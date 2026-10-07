const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OrderStore } = require('../src/orders');
const { createAutomation, dueEmails } = require('../src/automation');
const { products } = require('../src/products');

const customer = {
  email: 'buyer@example.com', firstName: 'Ada', lastName: 'Lovelace',
  address1: '1 Main St', city: 'Springfield', postalCode: '12345', country: 'US',
};
const quietLog = { error() {}, log() {} };

// Give every variant a CJ id for the duration of a test.
function withCjIds(fn) {
  const saved = products.flatMap((p) => p.variants.map((v) => [v, v.cjVariantId]));
  for (const [v] of saved) v.cjVariantId = `vid-${v.id}`;
  return Promise.resolve(fn()).finally(() => { for (const [v, id] of saved) v.cjVariantId = id; });
}

function recordingMailer({ owner = true } = {}) {
  const sent = [];
  return {
    sent,
    configured: true,
    ownerConfigured: owner,
    async sendCustomer(order, kind) { sent.push({ to: order.customer.email, kind, id: order.id }); return { sent: true }; },
    async sendOwner(msg) { sent.push({ to: 'owner', subject: msg.subject, text: msg.text }); return { sent: true }; },
  };
}

function fakeCj() {
  const cj = {
    created: [],
    orders: {},
    failNext: 0,
    failError: null,
    async createOrder(order, lines) {
      if (cj.failNext > 0) { cj.failNext -= 1; throw cj.failError || Object.assign(new Error('CJ down'), { retryable: true }); }
      const cjOrderId = `CJ${cj.created.length + 1}`;
      cj.created.push({ orderNumber: order.id, lines: lines.map((l) => ({ vid: l.cjVariantId, quantity: l.quantity })) });
      cj.orders[cjOrderId] = { cjStatus: 'awaiting_payment', trackingNumber: null, carrier: null };
      return { cjOrderId, cjStatus: 'awaiting_payment' };
    },
    async getOrder(id) { return cj.orders[id]; },
  };
  return cj;
}

async function setup({ cj = fakeCj(), mailer = recordingMailer(), start = '2026-10-07T10:00:00' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-'));
  const store = new OrderStore(path.join(dir, 'orders.json'));
  const clock = { t: new Date(start) };
  const automation = createAutomation({ store, mailer, cj, now: () => new Date(clock.t), log: quietLog, baseUrl: 'https://shop.test' });
  const advance = (ms) => { clock.t = new Date(clock.t.getTime() + ms); };
  const paidOrder = async (extra = {}) => {
    const o = await store.create({
      customer, lines: [{ variantId: 'pb-sage', productName: 'BlendGo', variantName: 'Sage', unitPrice: 2999, quantity: 1, lineTotal: 2999, discount: 0 }],
      subtotal: 2999, discount: 0, shipping: 499, total: 3498, currency: 'usd',
    });
    return store.update(o.id, { status: 'paid', paidAt: clock.t.toISOString(), ...extra });
  };
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { store, automation, cj, mailer, clock, advance, paidOrder, cleanup };
}

const MIN = 60_000;

test('a paid order is confirmed, placed with CJ, then shipped with tracking', () => withCjIds(async () => {
  const s = await setup();
  try {
    const order = await s.paidOrder();
    let run = await s.automation.run();
    assert.deepStrictEqual(run.submitted, [order.id]);
    let o = await s.store.get(order.id);
    assert.strictEqual(o.status, 'ordered_from_supplier');
    assert.strictEqual(o.supplierOrderId, 'CJ1');
    assert.strictEqual(o.fulfilment.cjStatus, 'awaiting_payment');
    assert.deepStrictEqual(s.cj.created[0], { orderNumber: order.id, lines: [{ vid: 'vid-pb-sage', quantity: 1 }] });
    assert.deepStrictEqual(s.mailer.sent.filter((m) => m.kind).map((m) => m.kind), ['confirmation']);

    // Owner pays in CJ; CJ ships and reports tracking. Polling waits 30 minutes between checks.
    s.cj.orders.CJ1 = { cjStatus: 'shipped', trackingNumber: 'YT999', carrier: 'YunExpress' };
    await s.automation.run();
    assert.strictEqual((await s.store.get(order.id)).status, 'ordered_from_supplier', 'polled too soon');
    s.advance(31 * MIN);
    run = await s.automation.run();
    assert.deepStrictEqual(run.shipped, [order.id]);
    o = await s.store.get(order.id);
    assert.strictEqual(o.status, 'shipped');
    assert.strictEqual(o.trackingNumber, 'YT999');
    assert.deepStrictEqual(o.shipments, [{ carrier: 'YunExpress', trackingNumber: 'YT999' }]);
    assert.ok(o.shippedAt);

    // Further runs send nothing new.
    s.advance(60 * MIN);
    await s.automation.run();
    await s.automation.run();
    const kinds = s.mailer.sent.filter((m) => m.kind).map((m) => m.kind);
    assert.deepStrictEqual(kinds, ['confirmation', 'shipped']);
    assert.strictEqual(s.cj.created.length, 1);
  } finally { s.cleanup(); }
}));

test('CJ failures retry with backoff, alert the owner once, then give up', () => withCjIds(async () => {
  const s = await setup();
  try {
    const order = await s.paidOrder();
    s.cj.failNext = 99;
    await s.automation.run();
    let o = await s.store.get(order.id);
    assert.strictEqual(o.status, 'paid');
    assert.strictEqual(o.fulfilment.attempts, 1);
    assert.match(o.fulfilment.lastError, /CJ down/);

    // Within the backoff window nothing is retried.
    await s.automation.run();
    assert.strictEqual((await s.store.get(order.id)).fulfilment.attempts, 1);

    for (let i = 0; i < 10; i++) { s.advance(7 * 60 * MIN); await s.automation.run(); }
    o = await s.store.get(order.id);
    assert.strictEqual(o.fulfilment.attempts, 5);
    assert.strictEqual(o.fulfilment.gaveUp, true);
    const alerts = s.mailer.sent.filter((m) => m.to === 'owner').map((m) => m.subject);
    assert.strictEqual(alerts.filter((x) => /retrying/.test(x)).length, 1);
    assert.strictEqual(alerts.filter((x) => /could not be placed/.test(x)).length, 1);
  } finally { s.cleanup(); }
}));

test('a non-retryable CJ error gives up immediately', () => withCjIds(async () => {
  const s = await setup();
  try {
    const order = await s.paidOrder();
    s.cj.failNext = 1;
    s.cj.failError = Object.assign(new Error('Invalid vid'), { retryable: false });
    await s.automation.run();
    const o = await s.store.get(order.id);
    assert.strictEqual(o.fulfilment.gaveUp, true);
    assert.strictEqual(o.fulfilment.attempts, 1);
  } finally { s.cleanup(); }
}));

test('orders are left for the owner when CJ is not set up, with one alert each', async () => {
  const s = await setup({ cj: null });
  try {
    const order = await s.paidOrder();
    const run = await s.automation.run();
    await s.automation.run();
    assert.deepStrictEqual(run.manual, [order.id]);
    const o = await s.store.get(order.id);
    assert.strictEqual(o.status, 'paid');
    assert.match(o.fulfilment.lastError, /CJ_API_KEY/);
    assert.strictEqual(s.mailer.sent.filter((m) => m.to === 'owner' && /by hand/.test(m.subject)).length, 1);
  } finally { s.cleanup(); }
});

test('a variant without a CJ id is not sent to CJ', async () => {
  const s = await setup();
  try {
    const order = await s.paidOrder();
    await s.automation.run();
    assert.strictEqual(s.cj.created.length, 0);
    assert.match((await s.store.get(order.id)).fulfilment.lastError, /cjVariantId.*pb-sage/);
  } finally { s.cleanup(); }
});

test('manually placed orders are not resubmitted', () => withCjIds(async () => {
  const s = await setup();
  try {
    await s.paidOrder({ supplierOrderId: 'MANUAL-1', status: 'ordered_from_supplier' });
    await s.automation.run();
    assert.strictEqual(s.cj.created.length, 0);
  } finally { s.cleanup(); }
}));

test('unpaid checkouts are cancelled after 24 hours without emailing the shopper', async () => {
  const s = await setup();
  try {
    const order = await s.store.create({ customer, lines: [], subtotal: 0, discount: 0, shipping: 0, total: 0, currency: 'usd' });
    await s.store.update(order.id, { createdAt: s.clock.t.toISOString() });
    s.advance(23 * 60 * MIN);
    await s.automation.run();
    assert.strictEqual((await s.store.get(order.id)).status, 'pending_payment');
    s.advance(2 * 60 * MIN);
    const run = await s.automation.run();
    assert.deepStrictEqual(run.expired, [order.id]);
    const o = await s.store.get(order.id);
    assert.strictEqual(o.status, 'cancelled');
    assert.strictEqual(o.cancelReason, 'payment_not_completed');
    assert.strictEqual(s.mailer.sent.filter((m) => m.kind).length, 0);
  } finally { s.cleanup(); }
});

test('refund and cancellation emails go out once', async () => {
  const s = await setup({ cj: null });
  try {
    const a = await s.paidOrder({ emails: { confirmation: { at: 'x' } } });
    const b = await s.paidOrder({ emails: { confirmation: { at: 'x' } } });
    await s.store.update(a.id, { status: 'refunded', refundedAt: s.clock.t.toISOString() });
    await s.store.update(b.id, { status: 'cancelled', cancelledAt: s.clock.t.toISOString() });
    await s.automation.run();
    await s.automation.run();
    const kinds = s.mailer.sent.filter((m) => m.kind).map((m) => `${m.kind}:${m.id}`).sort();
    assert.deepStrictEqual(kinds, [`cancelled:${b.id}`, `refunded:${a.id}`].sort());
  } finally { s.cleanup(); }
});

test('old orders never trigger emails when automation is first switched on', () => {
  const now = new Date('2026-10-07T10:00:00Z');
  const old = '2026-09-01T00:00:00.000Z';
  assert.deepStrictEqual(dueEmails({ status: 'shipped', paidAt: old, shippedAt: old }, now), []);
  assert.deepStrictEqual(dueEmails({ status: 'shipped', paidAt: old, shippedAt: now.toISOString() }, now), ['shipped']);
});

test('the owner gets one daily digest listing CJ orders awaiting payment', () => withCjIds(async () => {
  const s = await setup({ start: '2026-10-07T07:00:00' });
  try {
    const order = await s.paidOrder();
    let run = await s.automation.run();
    assert.strictEqual(run.digest, false, 'before the digest hour');
    s.advance(90 * MIN);
    run = await s.automation.run();
    assert.strictEqual(run.digest, true);
    run = await s.automation.run();
    assert.strictEqual(run.digest, false, 'only once per day');
    const digests = s.mailer.sent.filter((m) => /Daily summary/.test(m.subject || ''));
    assert.strictEqual(digests.length, 1);
    assert.match(digests[0].text, new RegExp(`${order.id} → CJ order CJ1`));
    assert.match(digests[0].text, /New paid orders: 1/);
    s.advance(24 * 60 * MIN);
    assert.strictEqual((await s.automation.run()).digest, true, 'next day');
  } finally { s.cleanup(); }
}));

test('overlapping runs share one run and never double-submit', () => withCjIds(async () => {
  const s = await setup();
  try {
    await s.paidOrder();
    const [r1, r2] = await Promise.all([s.automation.run(), s.automation.run()]);
    assert.strictEqual(r1, r2);
    assert.strictEqual(s.cj.created.length, 1);
  } finally { s.cleanup(); }
}));

test('status reports configuration without secrets', async () => {
  const s = await setup({ cj: null });
  try {
    const st = s.automation.status();
    assert.strictEqual(st.cj, false);
    assert.strictEqual(st.email, true);
    assert.ok(st.missingCjVariants.length > 0);
  } finally { s.cleanup(); }
});
