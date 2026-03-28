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

    // ===== GET /admin — Admin Dashboard =====
    if (req.method === 'GET' && path === '/admin') {
      const urlParams = new URL(req.url, `https://${req.headers.host}`).searchParams;
      if (urlParams.get('secret') !== process.env.ADMIN_SECRET) {
        return res.status(401).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:60px;background:#1C1512;text-align:center"><h2 style="color:#D4380D;font-size:32px">Access Denied</h2><p style="color:#8B7B6B;margin-top:12px">Add <code style="background:#2D2420;color:#E8A838;padding:2px 8px;border-radius:4px">?secret=YOUR_ADMIN_SECRET</code> to the URL.</p></body></html>`);
      }

      const { data: orders } = await supabase.from('orders').select('*').order('created_at', { ascending: false }).limit(500);
      const { data: users } = await supabase.from('users').select('*').order('created_at', { ascending: false }).limit(500);

      const totalRevenue = (orders || []).reduce((sum, o) => sum + parseFloat(o.total_amount || 0), 0);
      const avgOrder = orders?.length ? (totalRevenue / orders.length).toFixed(2) : '0.00';
      const statusColors = { paid:'#3D7A4A', shipped:'#2196F3', delivered:'#9C27B0', refunded:'#C0392B', pending:'#E8A838' };

      const orderRows = (orders || []).map(o => {
        let itemsText = '-';
        try {
          const parsed = Array.isArray(o.items) ? o.items : JSON.parse(o.items || '[]');
          itemsText = parsed.map(i => `${i.name} x${i.qty}`).join(', ');
        } catch(e) {}
        const addr = [o.shipping_address, o.shipping_city, o.shipping_state, o.shipping_zip, o.shipping_country].filter(Boolean).join(', ') || '-';
        const c = statusColors[o.status] || '#8B7B6B';
        return `<tr>
          <td><span class="oid">${o.order_id}</span></td>
          <td>${new Date(o.created_at).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</td>
          <td>${o.customer_name||'-'}</td><td>${o.customer_email||'-'}</td>
          <td>${o.customer_phone||'-'}</td>
          <td class="sm">${itemsText}</td><td class="sm">${addr}</td>
          <td class="tot">${parseFloat(o.total_amount||0).toFixed(2)} ${o.currency||'USD'}</td>
          <td><span class="badge" style="background:${c}22;color:${c}">${o.status}</span></td>
        </tr>`;
      }).join('');

      const userRows = (users||[]).map(u=>`<tr>
        <td>${[u.first_name,u.last_name].filter(Boolean).join(' ')||'-'}</td>
        <td>${u.email}</td><td>${u.phone||'-'}</td>
        <td>${new Date(u.created_at).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</td>
      </tr>`).join('');

      return res.status(200).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HECHARR Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#1C1512;min-height:100vh;color:#FAF0E4}
.hdr{background:linear-gradient(135deg,#D4380D,#FF6B3D);color:white;padding:20px 32px;display:flex;align-items:center;justify-content:space-between;box-shadow:0 4px 20px rgba(212,56,13,0.25)}
.hdr h1{font-size:22px;font-weight:800;letter-spacing:2px}.hdr-sub{font-size:12px;opacity:.8;margin-top:2px}.hdr-right{font-size:12px;opacity:.8}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;padding:24px 32px}
.stat{background:#2D2420;border-radius:8px;padding:22px 24px;border:1px solid #4A3728}
.stat-label{font-size:11px;color:#8B7B6B;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:10px}
.stat-value{font-size:34px;font-weight:800;color:#D4380D;line-height:1}
.tabs{display:flex;margin:0 32px;border-bottom:2px solid #4A3728}
.tab{padding:12px 24px;font-size:14px;font-weight:600;color:#8B7B6B;cursor:pointer;border-bottom:3px solid transparent;margin-bottom:-2px;transition:all .2s}
.tab.active{color:#D4380D;border-bottom-color:#D4380D}
.sec{padding:24px 32px;display:none}.sec.active{display:block}
.toolbar{display:flex;gap:12px;margin-bottom:16px;align-items:center}
.search{flex:1;padding:10px 16px;border:1.5px solid #4A3728;border-radius:4px;font-size:14px;outline:none;font-family:inherit;background:#2D2420;color:#FAF0E4}
.search:focus{border-color:#D4380D}
.search::placeholder{color:#8B7B6B}
.btn{background:#D4380D;color:white;border:none;padding:10px 20px;border-radius:4px;font-size:13px;font-weight:600;cursor:pointer;letter-spacing:1px;text-transform:uppercase}
.btn:hover{background:#FF6B3D}
.wrap{overflow-x:auto;border-radius:8px;border:1px solid #4A3728}
table{width:100%;border-collapse:collapse;background:#2D2420;min-width:900px}
th{background:#D4380D;color:white;padding:12px 14px;text-align:left;font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:700;white-space:nowrap}
td{padding:13px 14px;font-size:13px;border-bottom:1px solid #4A3728;color:#FAF0E4;vertical-align:middle}
tr:last-child td{border-bottom:none}tr:hover td{background:#3D2F28}
.badge{padding:4px 10px;border-radius:4px;font-size:11px;font-weight:700;text-transform:capitalize}
.oid{font-family:monospace;font-weight:700;font-size:12px;background:#3D2F28;color:#D4380D;padding:3px 8px;border-radius:4px}
.tot{font-weight:700;color:#E8A838}.sm{font-size:11px;color:#8B7B6B;max-width:180px}
.empty{text-align:center;padding:60px;color:#8B7B6B;font-size:14px}
@media(max-width:768px){.stats{grid-template-columns:repeat(2,1fr)}.stat-value{font-size:24px}}
</style></head><body>
<div class="hdr"><div><h1>HECHARR ADMIN</h1><div class="hdr-sub">Orders & Customer Dashboard</div></div>
<div class="hdr-right">Refreshed: ${new Date().toLocaleString('en-GB')}</div></div>
<div class="stats">
  <div class="stat"><div class="stat-label">Total Orders</div><div class="stat-value">${(orders||[]).length}</div></div>
  <div class="stat"><div class="stat-label">Revenue (USD)</div><div class="stat-value">$${totalRevenue.toFixed(2)}</div></div>
  <div class="stat"><div class="stat-label">Customers</div><div class="stat-value" style="color:#3D7A4A">${(users||[]).length}</div></div>
  <div class="stat"><div class="stat-label">Avg Order</div><div class="stat-value">$${avgOrder}</div></div>
</div>
<div class="tabs">
  <div class="tab active" onclick="show('os','cs',this)">Orders (${(orders||[]).length})</div>
  <div class="tab" onclick="show('cs','os',this)">Customers (${(users||[]).length})</div>
</div>
<div id="os" class="sec active">
  <div class="toolbar">
    <input class="search" placeholder="Search orders..." oninput="filter(this,'ot')">
    <button class="btn" onclick="exportCSV('os','orders')">Export CSV</button>
    <button class="btn" style="background:#4A3728" onclick="location.reload()">Refresh</button>
  </div>
  <div class="wrap"><table><thead><tr><th>Order ID</th><th>Date</th><th>Customer</th><th>Email</th><th>Phone</th><th>Items</th><th>Address</th><th>Total</th><th>Status</th></tr></thead>
  <tbody id="ot">${orderRows||'<tr><td colspan="9" class="empty">No orders yet</td></tr>'}</tbody></table></div>
</div>
<div id="cs" class="sec">
  <div class="toolbar">
    <input class="search" placeholder="Search customers..." oninput="filter(this,'ct')">
    <button class="btn" onclick="exportCSV('cs','customers')">Export CSV</button>
  </div>
  <div class="wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Joined</th></tr></thead>
  <tbody id="ct">${userRows||'<tr><td colspan="4" class="empty">No customers yet</td></tr>'}</tbody></table></div>
</div>
<script>
function show(a,b,tab){document.getElementById(a).classList.add('active');document.getElementById(b).classList.remove('active');document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));tab.classList.add('active');}
function filter(input,id){const q=input.value.toLowerCase();document.querySelectorAll('#'+id+' tr').forEach(r=>{r.style.display=r.textContent.toLowerCase().includes(q)?'':'none';});}
function exportCSV(secId,name){const t=document.getElementById(secId).querySelector('table');const rows=[...t.querySelectorAll('tr')].map(r=>[...r.querySelectorAll('th,td')].map(c=>'"'+c.innerText.replace(/"/g,'""').trim()+'"').join(','));const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([rows.join('\\n')],{type:'text/csv'}));a.download='hecharr-'+name+'-'+new Date().toISOString().slice(0,10)+'.csv';a.click();}
</script></body></html>`);
    }

    // ===== 404 — Route not found =====
    return res.status(404).json({ error: 'Route not found', path, method: req.method });

  } catch (err) {
    console.error('Server error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
