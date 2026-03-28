// ============================================================
// HECHARR Backend v2 — Vercel Serverless
// Stripe PaymentIntents + Supabase Auth + Orders + Multi-Currency
// ============================================================

const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ===== CORS =====
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    const allowed =
      origin.endsWith('.netlify.app') ||
      origin.endsWith('.hechar.com') ||
      origin === 'https://hechar.com' ||
      origin.endsWith('.vercel.app') ||
      origin === 'http://localhost:3000' ||
      origin === 'http://localhost:5500' ||
      origin === 'http://localhost:8080' ||
      origin === 'http://127.0.0.1:5500' ||
      origin === 'http://127.0.0.1:3000' ||
      origin === 'http://127.0.0.1:8080' ||
      origin === 'null';
    if (allowed) return callback(null, true);
    console.warn('CORS blocked origin:', origin);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true
}));

// Webhook raw body MUST be before express.json()
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ===== SUPABASE (service role — full access) =====
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Stripe-supported currencies
const STRIPE_SUPPORTED = [
  'USD','GBP','EUR','AUD','CAD','SGD','AED','INR',
  'MYR','THB','PHP','HKD','NZD','CHF','SEK','NOK',
  'DKK','JPY','BRL','MXN','ZAR'
];

// ===== HEALTH CHECK =====
app.get('/', (req, res) => {
  res.json({
    message: '🍬 HECHARR Backend v2 is live!',
    status: 'ok',
    platform: 'vercel',
    timestamp: new Date().toISOString(),
    stripe: process.env.STRIPE_SECRET_KEY ? '✅' : '❌ MISSING',
    supabase: process.env.SUPABASE_URL ? '✅' : '❌ MISSING'
  });
});

// ===== CREATE PAYMENT INTENT =====
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency, customer, items } = req.body;

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

    console.log(`✅ PaymentIntent created: ${paymentIntent.id} — ${Math.round(amount)} ${stripeCurrency}`);
    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });
  } catch (err) {
    console.error('❌ Stripe PaymentIntent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== SAVE ORDER =====
app.post('/save-order', async (req, res) => {
  try {
    const { paymentIntentId, customer, items, total, currency, authUserId } = req.body;

    if (!paymentIntentId || !customer?.email) {
      return res.status(400).json({ error: 'Missing required order fields.' });
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: `Payment not completed. Status: ${paymentIntent.status}` });
    }

    let userId = null;
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', customer.email)
      .maybeSingle();

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
        .select('id')
        .single();
      if (userError) console.error('User insert error:', userError.message);
      userId = newUser?.id || null;
    }

    const orderId = 'HCH' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 3).toUpperCase();

    const { error: orderError } = await supabase
      .from('orders')
      .insert({
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

    console.log(`✅ Order saved: ${orderId} — ${customer.email} — ${total} ${currency}`);
    res.json({ success: true, orderId });
  } catch (err) {
    console.error('❌ Save order error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== AUTH: SIGN UP (with auto-login) =====
app.post('/auth/signup', async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { first_name: firstName, last_name: lastName }
    });

    if (error) {
      if (error.message.toLowerCase().includes('already')) {
        return res.status(400).json({ error: 'An account with this email already exists. Please log in.' });
      }
      return res.status(400).json({ error: error.message });
    }

    await supabase.from('users').upsert({
      auth_user_id: data.user.id,
      email,
      first_name: firstName || '',
      last_name: lastName || '',
    }, { onConflict: 'email' });

    // Auto-login
    const { data: loginData, error: loginError } = await supabase.auth.signInWithPassword({ email, password });

    const name = [firstName, lastName].filter(Boolean).join(' ') || email.split('@')[0];

    if (loginError || !loginData.session) {
      console.warn('Auto-login after signup failed:', loginError?.message);
      return res.json({
        success: true,
        user: { id: data.user.id, email, name, firstName, lastName, phone: '' },
        session: null
      });
    }

    res.json({
      success: true,
      user: { id: data.user.id, email, name, firstName, lastName, phone: '' },
      session: {
        access_token:  loginData.session.access_token,
        refresh_token: loginData.session.refresh_token,
        expires_at:    loginData.session.expires_at
      }
    });
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== AUTH: LOGIN =====
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    const { data: profile } = await supabase
      .from('users')
      .select('first_name, last_name, phone')
      .eq('email', email)
      .maybeSingle();

    const firstName = profile?.first_name || data.user.user_metadata?.first_name || '';
    const lastName  = profile?.last_name  || data.user.user_metadata?.last_name  || '';
    const name = [firstName, lastName].filter(Boolean).join(' ') || email.split('@')[0];

    res.json({
      success: true,
      user: { id: data.user.id, email, name, firstName, lastName, phone: profile?.phone || '' },
      session: {
        access_token:  data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at:    data.session.expires_at
      }
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== MY ORDERS (authenticated) =====
app.get('/my-orders', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Not authenticated.' });

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });

    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select('*')
      .eq('customer_email', user.email)
      .order('created_at', { ascending: false });

    if (ordersError) throw ordersError;
    res.json({ success: true, orders: orders || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== CREATE SUBSCRIPTION =====
app.post('/create-subscription', async (req, res) => {
  try {
    const { priceId, customer, successUrl, cancelUrl } = req.body;

    if (!priceId) return res.status(400).json({ error: 'Missing Stripe Price ID.' });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const validEmail = customer?.email && emailRegex.test(customer.email) ? customer.email : null;

    let stripeCustomer;
    if (validEmail) {
      const existing = await stripe.customers.list({ email: validEmail, limit: 1 });
      if (existing.data.length > 0) {
        stripeCustomer = existing.data[0];
      } else {
        stripeCustomer = await stripe.customers.create({
          email: validEmail,
          name: `${customer?.firstName || ''} ${customer?.lastName || ''}`.trim() || undefined,
        });
      }
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
    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('❌ Subscription error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== SUBSCRIPTION STATUS =====
app.post('/subscription-status', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required.' });

    const customers = await stripe.customers.list({ email, limit: 1 });
    if (customers.data.length === 0) {
      return res.json({ active: false, subscriptions: [] });
    }

    const subscriptions = await stripe.subscriptions.list({
      customer: customers.data[0].id,
      status: 'all',
      limit: 10,
    });

    res.json({
      active: subscriptions.data.some(s => ['active', 'trialing'].includes(s.status)),
      subscriptions: subscriptions.data.map(s => ({
        id: s.id,
        status: s.status,
        interval: s.items.data[0]?.price?.recurring?.interval,
        currentPeriodEnd: new Date(s.current_period_end * 1000).toISOString(),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== CANCEL SUBSCRIPTION =====
app.post('/cancel-subscription', async (req, res) => {
  try {
    const { subscriptionId } = req.body;
    if (!subscriptionId) return res.status(400).json({ error: 'Subscription ID required.' });

    const subscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });

    res.json({
      success: true,
      cancelAt: new Date(subscription.current_period_end * 1000).toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== STRIPE WEBHOOK =====
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  switch (event.type) {
    case 'payment_intent.succeeded':
      console.log(`✅ Payment succeeded ${event.data.object.id}`); break;
    case 'payment_intent.payment_failed':
      console.log(`❌ Payment failed ${event.data.object.id}`); break;
    case 'invoice.paid':
      console.log(`✅ Invoice paid ${event.data.object.id}`);
      try {
        const invoice = event.data.object;
        if (invoice.subscription) {
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
        }
      } catch (saveErr) {
        console.error('Failed to save subscription order:', saveErr.message);
      }
      break;
    default:
      console.log(`Webhook: ${event.type}`);
  }
  res.json({ received: true });
});

// ===== EXPORT FOR VERCEL =====
module.exports = app;
