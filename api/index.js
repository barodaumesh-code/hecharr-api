// ============================================================
// HECHARR Backend v2 — Vercel Serverless (Single Function)
// Deploy: put this file at api/index.js in your repo
// All routes handled via req.url parsing
// NO vercel.json needed
// ============================================================

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const STRIPE_SUPPORTED = [
  'USD','GBP','EUR','AUD','CAD','SGD','AED','INR',
  'MYR','THB','PHP','HKD','NZD','CHF','SEK','NOK',
  'DKK','JPY','BRL','MXN','ZAR'
];

// ===== CORS HEADERS =====
function setCors(req, res) {
  const origin = req.headers.origin || '';
  const allowed =
    !origin ||
    origin.endsWith('.netlify.app') ||
    origin.endsWith('.hechar.com') ||
    origin === 'https://hechar.com' ||
    origin.endsWith('.vercel.app') ||
    origin.startsWith('http://localhost') ||
    origin.startsWith('http://127.0.0.1') ||
    origin === 'null';

  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

// ===== PARSE JSON BODY =====
function parseBody(req) {
  return new Promise((resolve) => {
    if (req.body) return resolve(req.body);
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve({}); }
    });
  });
}

// ===== MAIN HANDLER =====
module.exports = async function handler(req, res) {
  setCors(req, res);

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Get the path — strip /api prefix if present
  let path = req.url.split('?')[0];
  path = path.replace(/^\/api/, '');
  if (!path || path === '') path = '/';

  try {
    // ===== GET / — Health Check =====
    if (req.method === 'GET' && path === '/') {
      return res.status(200).json({
        message: '🍬 HECHARR Backend v2 is live!',
        status: 'ok',
        platform: 'vercel',
        timestamp: new Date().toISOString(),
        stripe: process.env.STRIPE_SECRET_KEY ? '✅' : '❌ MISSING',
        supabase: process.env.SUPABASE_URL ? '✅' : '❌ MISSING'
      });
    }

    // ===== POST /create-payment-intent =====
    if (req.method === 'POST' && path === '/create-payment-intent') {
      const body = await parseBody(req);
      const { amount, currency, customer, items } = body;

      if (!amount || isNaN(amount) || amount < 50) {
        return res.status(400).json({ error: 'Invalid amount. Minimum is $0.50 equivalent.' });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const validEmail = customer?.email && emailRegex.test(customer.email) ? customer.email : null;
      const rawCurrency = (currency || 'USD').toUpperCase();
      const stripeCurrency = STRIPE_SUPPORTED.includes(rawCurrency) ? rawCurrency : 'USD';

      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount),
        currency: stripeCurrency.toLowerCase(),
        metadata: {
          customer_email: validEmail || '',
          customer_name: `${customer?.firstName || ''} ${customer?.lastName || ''}`.trim(),
          item_count: String(items?.length || 0),
          display_currency: rawCurrency,
        },
        description: 'HECHARR Multivitamin Gummies Order',
        receipt_email: validEmail || undefined,
        payment_method_types: ['card']
      });

      return res.status(200).json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id
      });
    }

    // ===== POST /save-order =====
    if (req.method === 'POST' && path === '/save-order') {
      const body = await parseBody(req);
      const { paymentIntentId, customer, items, total, currency, authUserId } = body;

      if (!paymentIntentId || !customer?.email) {
        return res.status(400).json({ error: 'Missing required order fields.' });
      }

      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (paymentIntent.status !== 'succeeded') {
        return res.status(400).json({ error: `Payment not completed. Status: ${paymentIntent.status}` });
      }

      let userId = null;
      const { data: existingUser } = await supabase
        .from('users').select('id').eq('email', customer.email).maybeSingle();

      if (existingUser) {
        userId = existingUser.id;
      } else {
        const { data: newUser, error: userError } = await supabase
          .from('users')
          .insert({
            auth_user_id: authUserId || null,
            email: customer.email,
            first_name: customer.firstName || '',
            last_name: customer.lastName || '',
            phone: customer.phone || null,
          })
          .select('id').single();
        if (userError) console.error('User insert error:', userError.message);
        userId = newUser?.id || null;
      }

      const orderId = 'HCH' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 3).toUpperCase();

      const { error: orderError } = await supabase.from('orders').insert({
        order_id: orderId,
        stripe_payment_intent_id: paymentIntentId,
        user_id: userId,
        customer_email: customer.email,
        customer_name: `${customer.firstName || ''} ${customer.lastName || ''}`.trim(),
        customer_phone: customer.phone || null,
        shipping_address: customer.address || '',
        shipping_address2: customer.address2 || null,
        shipping_city: customer.city || '',
        shipping_zip: customer.zip || '',
        shipping_state: customer.state || '',
        shipping_country: customer.country || '',
        items: items,
        total_amount: total,
        currency: (currency || 'USD').toUpperCase(),
        status: 'paid',
      });

      if (orderError) throw orderError;
      return res.status(200).json({ success: true, orderId });
    }

    // ===== POST /auth/signup =====
    if (req.method === 'POST' && path === '/auth/signup') {
      const body = await parseBody(req);
      const { email, password, firstName, lastName } = body;
      if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

      const { data, error } = await supabase.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { first_name: firstName, last_name: lastName }
      });

      if (error) {
        if (error.message.toLowerCase().includes('already')) {
          return res.status(400).json({ error: 'An account with this email already exists. Please log in.' });
        }
        return res.status(400).json({ error: error.message });
      }

      await supabase.from('users').upsert({
        auth_user_id: data.user.id, email,
        first_name: firstName || '', last_name: lastName || '',
      }, { onConflict: 'email' });

      const { data: loginData, error: loginError } = await supabase.auth.signInWithPassword({ email, password });
      const name = [firstName, lastName].filter(Boolean).join(' ') || email.split('@')[0];

      if (loginError || !loginData.session) {
        return res.status(200).json({
          success: true,
          user: { id: data.user.id, email, name, firstName, lastName, phone: '' },
          session: null
        });
      }

      return res.status(200).json({
        success: true,
        user: { id: data.user.id, email, name, firstName, lastName, phone: '' },
        session: {
          access_token: loginData.session.access_token,
          refresh_token: loginData.session.refresh_token,
          expires_at: loginData.session.expires_at
        }
      });
    }

    // ===== POST /auth/login =====
    if (req.method === 'POST' && path === '/auth/login') {
      const body = await parseBody(req);
      const { email, password } = body;
      if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return res.status(401).json({ error: 'Incorrect email or password.' });

      const { data: profile } = await supabase
        .from('users').select('first_name, last_name, phone').eq('email', email).maybeSingle();

      const firstName = profile?.first_name || data.user.user_metadata?.first_name || '';
      const lastName = profile?.last_name || data.user.user_metadata?.last_name || '';
      const name = [firstName, lastName].filter(Boolean).join(' ') || email.split('@')[0];

      return res.status(200).json({
        success: true,
        user: { id: data.user.id, email, name, firstName, lastName, phone: profile?.phone || '' },
        session: {
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_at: data.session.expires_at
        }
      });
    }

    // ===== GET /my-orders =====
    if (req.method === 'GET' && path === '/my-orders') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) return res.status(401).json({ error: 'Not authenticated.' });

      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error || !user) return res.status(401).json({ error: 'Invalid or expired session.' });

      const { data: orders, error: ordersError } = await supabase
        .from('orders').select('*').eq('customer_email', user.email)
        .order('created_at', { ascending: false });

      if (ordersError) throw ordersError;
      return res.status(200).json({ success: true, orders: orders || [] });
    }

    // ===== POST /create-subscription =====
    if (req.method === 'POST' && path === '/create-subscription') {
      const body = await parseBody(req);
      const { priceId, customer, successUrl, cancelUrl } = body;
      if (!priceId) return res.status(400).json({ error: 'Missing Stripe Price ID.' });

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const validEmail = customer?.email && emailRegex.test(customer.email) ? customer.email : null;

      let stripeCustomer;
      if (validEmail) {
        const existing = await stripe.customers.list({ email: validEmail, limit: 1 });
        if (existing.data.length > 0) stripeCustomer = existing.data[0];
        else stripeCustomer = await stripe.customers.create({ email: validEmail });
      }

      const sessionParams = {
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl || 'https://hechar.com?subscription=success',
        cancel_url: cancelUrl || 'https://hechar.com?subscription=cancelled',
      };
      if (stripeCustomer) sessionParams.customer = stripeCustomer.id;

      const session = await stripe.checkout.sessions.create(sessionParams);
      return res.status(200).json({ url: session.url, sessionId: session.id });
    }

    // ===== POST /webhook =====
    if (req.method === 'POST' && path === '/webhook') {
      const sig = req.headers['stripe-signature'];
      let event;
      try {
        // For Vercel, req.body may already be parsed or a buffer
        const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
      } catch (err) {
        return res.status(400).json({ error: `Webhook Error: ${err.message}` });
      }

      if (event.type === 'invoice.paid' && event.data.object.subscription) {
        try {
          const invoice = event.data.object;
          const orderId = 'HSUB' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 3).toUpperCase();
          await supabase.from('orders').insert({
            order_id: orderId,
            stripe_payment_intent_id: invoice.payment_intent,
            customer_email: invoice.customer_email || '',
            customer_name: invoice.customer_name || '',
            items: [{ name: 'Subscription Renewal', qty: 1, price: invoice.amount_paid / 100 }],
            total_amount: invoice.amount_paid / 100,
            currency: (invoice.currency || 'usd').toUpperCase(),
            status: 'paid',
          });
        } catch (e) { console.error('Webhook save error:', e.message); }
      }

      return res.status(200).json({ received: true });
    }

    // ===== 404 — Route not found =====
    return res.status(404).json({ error: 'Route not found', path, method: req.method });

  } catch (err) {
    console.error('Server error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
