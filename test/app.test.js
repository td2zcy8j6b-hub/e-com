const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');

const customer = {
  email: 'Buyer@Example.com', firstName: 'Ada', lastName: 'Lovelace',
  address1: '1 Main St', city: 'Springfield', postalCode: '12345', country: 'US',
};

async function withServer(opts, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  const app = createApp({ ordersFile: path.join(dir, 'orders.json'), adminPassword: 'secret', ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
  try { await fn(call, app); } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('products API hides supplier details', async () => {
  await withServer({}, async (call) => {
    const { status, body } = await call('GET', '/api/products');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.length, 2);
    for (const p of body) assert.strictEqual(p.supplier, undefined);
    assert.strictEqual((await call('GET', '/api/products/missing')).status, 404);
  });
});

test('static storefront pages are served', async () => {
  await withServer({}, async (call) => {
    for (const page of ['/', '/product.html', '/cart.html', '/checkout.html', '/admin.html', '/policies.html', '/img/projector.svg']) {
      assert.strictEqual((await call('GET', page)).status, 200, page);
    }
  });
});

test('demo checkout creates a paid order that can be tracked by email', async () => {
  await withServer({}, async (call) => {
    const res = await call('POST', '/api/checkout', { items: [{ variantId: 'pb-sage', quantity: 2 }], customer });
    assert.strictEqual(res.status, 200);
    const { orderId, redirectUrl } = res.body;
    assert.match(redirectUrl, /^\/success\.html\?order=NN-/);

    const found = await call('GET', `/api/orders/${orderId}?email=buyer@example.com`);
    assert.strictEqual(found.status, 200);
    assert.strictEqual(found.body.status, 'paid');
    assert.strictEqual(found.body.total, 2999 * 2 - 600);
    assert.strictEqual(found.body.customer, undefined, 'full address is not exposed');

    assert.strictEqual((await call('GET', `/api/orders/${orderId}?email=other@example.com`)).status, 404);
  });
});

test('checkout validates cart and customer', async () => {
  await withServer({}, async (call) => {
    assert.strictEqual((await call('POST', '/api/checkout', { items: [], customer })).status, 400);
    const bad = await call('POST', '/api/checkout', { items: [{ variantId: 'pb-sage', quantity: 1 }], customer: { ...customer, email: 'nope' } });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual((await call('POST', '/api/checkout', '{broken')).status, 400);
  });
});

test('admin endpoints require the password and update fulfilment', async () => {
  await withServer({}, async (call) => {
    const { body: { orderId } } = await call('POST', '/api/checkout', { items: [{ variantId: 'gsp-dome', quantity: 1 }], customer });
    assert.strictEqual((await call('GET', '/api/admin/orders')).status, 401);
    assert.strictEqual((await call('GET', '/api/admin/orders', undefined, { Authorization: 'Bearer wrong' })).status, 401);

    const auth = { Authorization: 'Bearer secret' };
    const list = await call('GET', '/api/admin/orders', undefined, auth);
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body[0].lines[0].supplier.sku, 'CJ-GSP-2291');
    assert.strictEqual(list.body[0].grossProfit, 2999 - 1150);

    assert.strictEqual((await call('PATCH', `/api/admin/orders/${orderId}`, { status: 'bogus' }, auth)).status, 400);
    const upd = await call('PATCH', `/api/admin/orders/${orderId}`, { status: 'shipped', trackingNumber: 'YT123', trackingCarrier: 'USPS' }, auth);
    assert.strictEqual(upd.status, 200);
    assert.ok(upd.body.shippedAt);

    const tracked = await call('GET', `/api/orders/${orderId}?email=buyer@example.com`);
    assert.strictEqual(tracked.body.status, 'shipped');
    assert.strictEqual(tracked.body.trackingNumber, 'YT123');
  });
});

test('admin is disabled when no password is configured', async () => {
  await withServer({ adminPassword: '' }, async (call) => {
    assert.strictEqual((await call('GET', '/api/admin/orders', undefined, { Authorization: 'Bearer ' })).status, 503);
  });
});

function fakeStripe() {
  const sessions = {};
  return {
    sessions,
    checkout: {
      sessions: {
        async create(params) {
          const s = { id: `cs_test_${Object.keys(sessions).length}`, url: 'https://checkout.stripe.test/pay', payment_status: 'unpaid', ...params };
          sessions[s.id] = s;
          return s;
        },
        async retrieve(id) { return sessions[id]; },
      },
    },
    webhooks: {
      constructEvent(body, sig) {
        if (sig !== 'valid') throw new Error('bad signature');
        return JSON.parse(body.toString());
      },
    },
  };
}

test('stripe checkout charges exactly the server-computed total', async () => {
  const stripe = fakeStripe();
  await withServer({ stripe, stripeWebhookSecret: 'whsec' }, async (call) => {
    const items = [{ variantId: 'gsp-astronaut', quantity: 2 }, { variantId: 'gsp-dome', quantity: 1 }];
    const res = await call('POST', '/api/checkout', { items, customer });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.redirectUrl, 'https://checkout.stripe.test/pay');

    const session = Object.values(stripe.sessions)[0];
    const stripeTotal = session.line_items.reduce((s, li) => s + li.price_data.unit_amount * li.quantity, 0)
      + session.shipping_options[0].shipping_rate_data.fixed_amount.amount;
    const { body: quote } = await call('POST', '/api/cart/quote', { items });
    assert.strictEqual(stripeTotal, quote.total);

    // Not paid yet
    const pending = await call('GET', `/api/orders/${res.body.orderId}?email=buyer@example.com`);
    assert.strictEqual(pending.body.status, 'pending_payment');

    // Bad signature rejected, valid webhook marks it paid.
    session.payment_status = 'paid';
    const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: session } });
    assert.strictEqual((await call('POST', '/api/webhooks/stripe', event, { 'stripe-signature': 'forged' })).status, 400);
    assert.strictEqual((await call('POST', '/api/webhooks/stripe', event, { 'stripe-signature': 'valid' })).status, 200);
    const paid = await call('GET', `/api/orders/${res.body.orderId}?email=buyer@example.com`);
    assert.strictEqual(paid.body.status, 'paid');
  });
});

test('returning from stripe confirms payment without waiting for the webhook', async () => {
  const stripe = fakeStripe();
  await withServer({ stripe }, async (call) => {
    const res = await call('POST', '/api/checkout', { items: [{ variantId: 'pb-midnight', quantity: 1 }], customer });
    Object.values(stripe.sessions)[0].payment_status = 'paid';
    const order = await call('GET', `/api/orders/${res.body.orderId}?email=buyer@example.com`);
    assert.strictEqual(order.body.status, 'paid');
  });
});

test('concurrent orders are all persisted', async () => {
  await withServer({}, async (call) => {
    await Promise.all(Array.from({ length: 15 }, () =>
      call('POST', '/api/checkout', { items: [{ variantId: 'pb-sage', quantity: 1 }], customer })));
    const list = await call('GET', '/api/admin/orders', undefined, { Authorization: 'Bearer secret' });
    assert.strictEqual(list.body.length, 15);
  });
});

test('stripe refunds, expired sessions and failed payments update the order', async () => {
  const stripe = fakeStripe();
  await withServer({ stripe, stripeWebhookSecret: 'whsec' }, async (call) => {
    const hook = (type, object) => call('POST', '/api/webhooks/stripe', JSON.stringify({ type, data: { object } }), { 'stripe-signature': 'valid' });
    const items = [{ variantId: 'pb-sage', quantity: 1 }];
    const a = (await call('POST', '/api/checkout', { items, customer })).body.orderId;
    const b = (await call('POST', '/api/checkout', { items, customer })).body.orderId;
    const c = (await call('POST', '/api/checkout', { items, customer })).body.orderId;
    const [sa, sb, sc] = Object.values(stripe.sessions);

    sa.payment_status = 'paid';
    sa.payment_intent = 'pi_a';
    await hook('checkout.session.completed', sa);
    // A partial refund leaves the order alone; a full refund marks it refunded.
    await hook('charge.refunded', { payment_intent: 'pi_a', refunded: false });
    assert.strictEqual((await call('GET', `/api/orders/${a}?email=buyer@example.com`)).body.status, 'paid');
    await hook('charge.refunded', { payment_intent: 'pi_a', refunded: true });
    assert.strictEqual((await call('GET', `/api/orders/${a}?email=buyer@example.com`)).body.status, 'refunded');

    await hook('checkout.session.expired', sb);
    await hook('checkout.session.async_payment_failed', sc);
    const auth = { Authorization: 'Bearer secret' };
    const all = (await call('GET', '/api/admin/orders', undefined, auth)).body;
    const byId = Object.fromEntries(all.map((o) => [o.id, o]));
    assert.strictEqual(byId[b].status, 'cancelled');
    assert.strictEqual(byId[b].cancelReason, 'payment_not_completed');
    assert.strictEqual(byId[c].cancelReason, 'payment_failed');
    assert.ok(byId[a].refundedAt && byId[b].cancelledAt);

    // A paid order is never cancelled by a late "expired" event.
    await hook('checkout.session.expired', sa);
    assert.strictEqual((await call('GET', `/api/orders/${a}?email=buyer@example.com`)).body.status, 'refunded');
  });
});

test('automation endpoints need the admin password and run automation', async () => {
  const runs = [];
  let kicks = 0;
  const automation = {
    kick() { kicks += 1; },
    async run() { runs.push(1); return { submitted: [], errors: [] }; },
    status() { return { email: false, cj: false, missingCjVariants: ['x'] }; },
  };
  await withServer({ automation }, async (call) => {
    assert.strictEqual((await call('POST', '/api/admin/automation/run')).status, 401);
    assert.strictEqual((await call('GET', '/api/admin/automation')).status, 401);
    const auth = { Authorization: 'Bearer secret' };
    const st = await call('GET', '/api/admin/automation', undefined, auth);
    assert.deepStrictEqual(st.body, { enabled: true, email: false, cj: false, missingCjVariants: ['x'] });
    const run = await call('POST', '/api/admin/automation/run', undefined, auth);
    assert.strictEqual(run.status, 200);
    assert.strictEqual(runs.length, 1);

    // Paying an order kicks automation so the confirmation goes out right away.
    await call('POST', '/api/checkout', { items: [{ variantId: 'pb-sage', quantity: 1 }], customer });
    assert.strictEqual(kicks, 1);
  });
  await withServer({}, async (call) => {
    assert.strictEqual((await call('POST', '/api/admin/automation/run', undefined, { Authorization: 'Bearer secret' })).status, 503);
  });
});

test('admin can retry a CJ order and tracking shows as a shipment', async () => {
  await withServer({}, async (call, app) => {
    const { body: { orderId } } = await call('POST', '/api/checkout', { items: [{ variantId: 'pb-sage', quantity: 1 }], customer });
    await app.locals.store.update(orderId, { fulfilment: { provider: 'cj', attempts: 5, gaveUp: true, lastError: 'boom' }, alerts: { supplier_gave_up: 'x', needs_manual: 'y' } });
    const auth = { Authorization: 'Bearer secret' };
    const retried = await call('PATCH', `/api/admin/orders/${orderId}`, { retryFulfilment: true }, auth);
    assert.deepStrictEqual(
      { attempts: retried.body.fulfilment.attempts, gaveUp: retried.body.fulfilment.gaveUp, lastError: retried.body.fulfilment.lastError },
      { attempts: 0, gaveUp: false, lastError: null },
    );
    assert.deepStrictEqual(retried.body.alerts, { needs_manual: 'y' }, 'a new failure alerts again');

    const shipped = await call('PATCH', `/api/admin/orders/${orderId}`, { status: 'shipped', trackingCarrier: 'USPS', trackingNumber: '9400' }, auth);
    const firstShippedAt = shipped.body.shippedAt;
    // Re-saving an already shipped order keeps its shipped time (so no repeat email).
    const again = await call('PATCH', `/api/admin/orders/${orderId}`, { status: 'shipped', trackingCarrier: 'USPS', trackingNumber: '9400' }, auth);
    assert.strictEqual(again.body.shippedAt, firstShippedAt);

    const view = await call('GET', `/api/orders/${orderId}?email=buyer@example.com`);
    assert.deepStrictEqual(view.body.shipments, [{ carrier: 'USPS', trackingNumber: '9400' }]);
    assert.strictEqual(view.body.fulfilment, undefined, 'supplier details stay private');
  });
});

test('products API hides CJ variant ids', async () => {
  await withServer({}, async (call) => {
    const { body } = await call('GET', '/api/products');
    for (const p of body) for (const v of p.variants) assert.strictEqual(v.cjVariantId, undefined);
  });
});
