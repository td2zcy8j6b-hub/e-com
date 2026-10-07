const express = require('express');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { products, publicProduct, findProduct, findVariant, supplierCostOf } = require('./products');
const { priceCart, CartError } = require('./pricing');
const { OrderStore, STATUSES, statusPatch } = require('./orders');

// Options let tests inject a temp order file, a fake Stripe client and automation.
function createApp({
  ordersFile = path.join(__dirname, '..', 'data', 'orders.json'),
  store = new OrderStore(ordersFile),
  // Optional back-office automation (src/automation.js). It is kicked whenever
  // an order is paid so the confirmation email and supplier order go out quickly.
  automation = null,
  stripe = null,
  stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET,
  adminPassword = process.env.ADMIN_PASSWORD,
  // Render sets RENDER_EXTERNAL_URL automatically, so BASE_URL is optional there.
  baseUrl = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL,
} = {}) {
  const app = express();
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
    const obj = event.data.object;
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      await markPaidFromSession(obj);
    } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
      // Shopper abandoned checkout or a delayed payment method failed.
      const orderId = obj.metadata && obj.metadata.orderId;
      if (orderId) {
        await store.update(orderId, (o) => (o.status === 'pending_payment'
          ? { ...statusPatch('cancelled'), cancelReason: event.type === 'checkout.session.expired' ? 'payment_not_completed' : 'payment_failed' }
          : {}));
      }
    } else if (event.type === 'charge.refunded') {
      await markRefunded(obj);
    }
    res.json({ received: true });
  });

  app.use(express.json({ limit: '50kb' }));

  async function markPaidFromSession(session) {
    const orderId = session.metadata && session.metadata.orderId;
    if (!orderId || session.payment_status !== 'paid') return null;
    let newlyPaid = false;
    const order = await store.update(orderId, (o) => {
      if (o.status !== 'pending_payment') return {};
      newlyPaid = true;
      return { status: 'paid', paidAt: new Date().toISOString(), payment: { provider: 'stripe', sessionId: session.id, paymentIntent: session.payment_intent } };
    });
    if (newlyPaid && automation) automation.kick();
    return order;
  }

  // A refund made in the Stripe dashboard marks the order refunded once the
  // whole charge has been returned. Partial refunds are left to the owner.
  async function markRefunded(charge) {
    if (!charge.payment_intent || !charge.refunded) return;
    const order = (await store.readAll()).find((o) => o.payment && o.payment.paymentIntent === charge.payment_intent);
    if (!order) return;
    await store.update(order.id, (o) => (o.status === 'refunded' ? {} : statusPatch('refunded')));
    if (automation) automation.kick();
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
      if (automation) automation.kick();
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
      await store.update(order.id, { ...statusPatch('cancelled'), cancelReason: 'payment_setup_failed' });
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
    const { status, trackingNumber, trackingCarrier, supplierOrderId, note, retryFulfilment } = req.body || {};
    if (status !== undefined && !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const fields = {};
    for (const [key, val] of Object.entries({ trackingNumber, trackingCarrier, supplierOrderId, note })) {
      if (val !== undefined) fields[key] = String(val).slice(0, 200);
    }
    const order = await store.update(req.params.id, (o) => {
      const patch = { ...fields };
      // Timestamps only change when the status actually changes, so re-saving
      // an order doesn't re-trigger its emails.
      if (status !== undefined && status !== o.status) Object.assign(patch, statusPatch(status));
      if ('trackingNumber' in fields) {
        patch.shipments = fields.trackingNumber ? [{ carrier: fields.trackingCarrier ?? o.trackingCarrier ?? '', trackingNumber: fields.trackingNumber }] : [];
      }
      // Lets automation try CJ again after it gave up.
      // Its failure alerts are cleared so a new failure is reported again.
      if (retryFulfilment) {
        patch.fulfilment = { ...(o.fulfilment || {}), attempts: 0, gaveUp: false, lastError: null, lastAttemptAt: null };
        const { supplier_failed, supplier_gave_up, ...alerts } = o.alerts || {};
        patch.alerts = alerts;
      }
      return patch;
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (automation) automation.kick();
    res.json(withSupplierInfo(order));
  });

  // What automation is set up to do. Never returns secrets.
  app.get('/api/admin/automation', requireAdmin, (req, res) => {
    if (!automation) return res.json({ enabled: false });
    res.json({ enabled: true, ...automation.status() });
  });

  // Runs automation now. Used by the admin button and the scheduled GitHub workflow.
  app.post('/api/admin/automation/run', requireAdmin, async (req, res) => {
    if (!automation) return res.status(503).json({ error: 'Automation is not enabled on this server.' });
    res.json(await automation.run());
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
    shipments: o.shipments && o.shipments.length
      ? o.shipments
      : o.trackingNumber ? [{ carrier: o.trackingCarrier || '', trackingNumber: o.trackingNumber }] : [],
    shipTo: { firstName: o.customer.firstName, city: o.customer.city, country: o.customer.country },
  };
}

// Admin view: attach supplier SKU + cost so each order can be placed with the supplier.
function withSupplierInfo(o) {
  const cost = supplierCostOf(o.lines);
  const lines = o.lines.map((l) => {
    const found = findVariant(l.variantId);
    return { ...l, supplier: found ? found.product.supplier : null };
  });
  return { ...o, lines, supplierCost: cost, grossProfit: o.total - o.shipping - cost };
}

module.exports = { createApp, validateCustomer };
