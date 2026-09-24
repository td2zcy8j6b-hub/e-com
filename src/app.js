const express = require('express');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { products, publicProduct, findProduct, findVariant } = require('./products');
const { priceCart, CartError } = require('./pricing');
const { OrderStore, STATUSES } = require('./orders');

// Options let tests inject a temp order file and a fake Stripe client.
function createApp({
  ordersFile = path.join(__dirname, '..', 'data', 'orders.json'),
  stripe = null,
  stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET,
  adminPassword = process.env.ADMIN_PASSWORD,
  baseUrl = process.env.BASE_URL,
} = {}) {
  const app = express();
  const store = new OrderStore(ordersFile);
  app.locals.store = store;
  app.disable('x-powered-by');

  // Stripe needs the raw body to verify webhook signatures, so this route is
  // registered before the JSON parser.
  app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe || !stripeWebhookSecret) return res.status(404).end();
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], stripeWebhookSecret);
    } catch (err) {
      return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
    }
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      await markPaidFromSession(event.data.object);
    }
    res.json({ received: true });
  });

  app.use(express.json({ limit: '50kb' }));

  async function markPaidFromSession(session) {
    const orderId = session.metadata && session.metadata.orderId;
    if (!orderId || session.payment_status !== 'paid') return null;
    return store.update(orderId, (o) =>
      o.status === 'pending_payment'
        ? { status: 'paid', paidAt: new Date().toISOString(), payment: { provider: 'stripe', sessionId: session.id, paymentIntent: session.payment_intent } }
        : {},
    );
  }

  // ---- Storefront API ----

  app.get('/api/config', (req, res) => {
    res.json({
      storeName: config.storeName,
      currency: config.currency,
      freeShippingThreshold: config.freeShippingThreshold,
      standardShipping: config.standardShipping,
      processingDays: config.processingDays,
      deliveryDays: config.deliveryDays,
      supportEmail: config.supportEmail,
      paymentMode: stripe ? 'stripe' : 'demo',
    });
  });

  app.get('/api/products', (req, res) => res.json(products.map(publicProduct)));

  app.get('/api/products/:slug', (req, res) => {
    const product = findProduct(req.params.slug);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(publicProduct(product));
  });

  app.post('/api/cart/quote', (req, res) => {
    try {
      res.json(priceCart(req.body && req.body.items));
    } catch (err) {
      if (err instanceof CartError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  app.post('/api/checkout', async (req, res) => {
    const body = req.body || {};
    let quote;
    try {
      quote = priceCart(body.items);
    } catch (err) {
      if (err instanceof CartError) return res.status(400).json({ error: err.message });
      throw err;
    }
    const customer = validateCustomer(body.customer);
    if (customer.error) return res.status(400).json({ error: customer.error });

    const order = await store.create({ customer: customer.value, ...quote });
    const origin = baseUrl || `${req.protocol}://${req.get('host')}`;

    if (!stripe) {
      // Demo mode: no payment provider configured, so the order is accepted
      // immediately. Useful for local testing and store previews.
      const paid = await store.update(order.id, { status: 'paid', paidAt: new Date().toISOString(), payment: { provider: 'demo' } });
      return res.json({ orderId: paid.id, redirectUrl: `/success.html?order=${paid.id}&email=${encodeURIComponent(paid.customer.email)}` });
    }

    // Stripe Checkout. Discounts are folded into each unit amount (they are
    // whole cents per unit) so the Stripe total matches our quote exactly.
    const lineItems = quote.lines.map((l) => ({
      quantity: l.quantity,
      price_data: {
        currency: quote.currency,
        unit_amount: l.unitPrice - l.unitDiscount,
        product_data: { name: `${l.productName} – ${l.variantName}` },
      },
    }));
    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: customer.value.email,
        line_items: lineItems,
        shipping_options: [
          {
            shipping_rate_data: {
              display_name: quote.shipping === 0 ? 'Free shipping' : 'Standard shipping',
              type: 'fixed_amount',
              fixed_amount: { amount: quote.shipping, currency: quote.currency },
            },
          },
        ],
        metadata: { orderId: order.id },
        success_url: `${origin}/success.html?order=${order.id}&email=${encodeURIComponent(customer.value.email)}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/cart.html`,
      });
      await store.update(order.id, { stripeSessionId: session.id });
      res.json({ orderId: order.id, redirectUrl: session.url });
    } catch (err) {
      console.error('Stripe checkout failed:', err.message);
      await store.update(order.id, { status: 'cancelled', cancelReason: 'payment_setup_failed' });
      res.status(502).json({ error: 'Payment provider unavailable. Please try again in a moment.' });
    }
  });

  // Order lookup needs the email too, so order ids alone can't be enumerated.
  app.get('/api/orders/:id', async (req, res) => {
    let order = await store.get(req.params.id);
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!order || order.customer.email !== email) return res.status(404).json({ error: 'Order not found' });

    // Confirm payment on return from Stripe even if the webhook hasn't arrived yet.
    if (order.status === 'pending_payment' && stripe && order.stripeSessionId) {
      try {
        const session = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
        order = (await markPaidFromSession(session)) || order;
      } catch (err) {
        console.error('Stripe session lookup failed:', err.message);
      }
    }
    res.json(customerView(order));
  });

  // ---- Admin API ----

  function requireAdmin(req, res, next) {
    if (!adminPassword) return res.status(503).json({ error: 'Admin is disabled. Set ADMIN_PASSWORD to enable it.' });
    const supplied = Buffer.from(String(req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
    const expected = Buffer.from(adminPassword);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  }

  app.get('/api/admin/orders', requireAdmin, async (req, res) => {
    const orders = (await store.readAll()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(orders.map(withSupplierInfo));
  });

  app.patch('/api/admin/orders/:id', requireAdmin, async (req, res) => {
    const { status, trackingNumber, trackingCarrier, supplierOrderId, note } = req.body || {};
    if (status !== undefined && !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const patch = {};
    if (status !== undefined) patch.status = status;
    for (const [key, val] of Object.entries({ trackingNumber, trackingCarrier, supplierOrderId, note })) {
      if (val !== undefined) patch[key] = String(val).slice(0, 200);
    }
    if (status === 'shipped') patch.shippedAt = new Date().toISOString();
    const order = await store.update(req.params.id, patch);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(withSupplierInfo(order));
  });

  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.use((err, req, res, next) => {
    console.error(err);
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateCustomer(input) {
  const c = input || {};
  const required = ['email', 'firstName', 'lastName', 'address1', 'city', 'postalCode', 'country'];
  for (const key of required) {
    if (!c[key] || typeof c[key] !== 'string' || !c[key].trim()) return { error: `Missing ${key}.` };
  }
  const value = {};
  for (const key of [...required, 'address2', 'state', 'phone']) {
    if (c[key] !== undefined && c[key] !== null) value[key] = String(c[key]).trim().slice(0, 120);
  }
  value.email = value.email.toLowerCase();
  if (!EMAIL_RE.test(value.email)) return { error: 'Please enter a valid email address.' };
  return { value };
}

// What the shopper may see about their order: no supplier costs or notes.
function customerView(o) {
  return {
    id: o.id,
    createdAt: o.createdAt,
    status: o.status,
    lines: o.lines,
    subtotal: o.subtotal,
    discount: o.discount,
    shipping: o.shipping,
    total: o.total,
    currency: o.currency,
    trackingNumber: o.trackingNumber || null,
    trackingCarrier: o.trackingCarrier || null,
    shipTo: { firstName: o.customer.firstName, city: o.customer.city, country: o.customer.country },
  };
}

// Admin view: attach supplier SKU + cost so each order can be placed with the supplier.
function withSupplierInfo(o) {
  let cost = 0;
  const lines = o.lines.map((l) => {
    const found = findVariant(l.variantId);
    const supplier = found ? found.product.supplier : null;
    if (supplier) cost += supplier.unitCost * l.quantity;
    return { ...l, supplier };
  });
  return { ...o, lines, supplierCost: cost, grossProfit: o.total - o.shipping - cost };
}

module.exports = { createApp, validateCustomer };
