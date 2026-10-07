const test = require('node:test');
const assert = require('node:assert');
const { createCjClient } = require('../src/suppliers/cj');

const order = {
  id: 'NN-ABC123',
  customer: { email: 'a@b.co', firstName: 'Ada', lastName: 'Lovelace', address1: '1 Main St', city: 'Springfield', state: 'IL', postalCode: '12345', country: 'US', phone: '555' },
};

function fakeFetch(handlers) {
  const calls = [];
  const fetch = async (url, opts) => {
    const u = new URL(url);
    const call = { path: u.pathname, query: Object.fromEntries(u.searchParams), headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : undefined };
    calls.push(call);
    const [status, json] = handlers[u.pathname.replace('/api2.0/v1', '')](call);
    return { ok: status < 400, status, json: async () => json };
  };
  return { fetch, calls };
}

const tokenOk = () => [200, { code: 200, result: true, data: { accessToken: 'tok1', accessTokenExpiryDate: '2099-01-01T00:00:00+08:00' } }];

test('creates an unpaid order with the shipping address and variant ids', async () => {
  const { fetch, calls } = fakeFetch({
    '/authentication/getAccessToken': tokenOk,
    '/shopping/order/createOrderV2': () => [200, { code: 200, result: true, data: { orderId: 'CJ777', orderStatus: 'CREATED' } }],
  });
  const cj = createCjClient({ apiKey: 'key', fetch, logisticName: 'CJPacket Ordinary' });
  const res = await cj.createOrder(order, [{ cjVariantId: 'vid1', quantity: 2 }]);
  assert.deepStrictEqual(res, { cjOrderId: 'CJ777', cjStatus: 'awaiting_payment' });

  assert.deepStrictEqual(calls[0].body, { apiKey: 'key' });
  const create = calls[1];
  assert.strictEqual(create.headers['CJ-Access-Token'], 'tok1');
  assert.strictEqual(create.body.orderNumber, 'NN-ABC123');
  assert.strictEqual(create.body.shippingCountryCode, 'US');
  assert.strictEqual(create.body.shippingCountry, 'United States');
  assert.strictEqual(create.body.shippingCustomerName, 'Ada Lovelace');
  assert.strictEqual(create.body.payType, 3, 'created unpaid for the owner to approve');
  assert.deepStrictEqual(create.body.products, [{ vid: 'vid1', quantity: 2 }]);
});

test('reuses the access token until it expires', async () => {
  let t = Date.parse('2026-10-07T00:00:00Z');
  const { fetch, calls } = fakeFetch({
    '/authentication/getAccessToken': () => [200, { code: 200, result: true, data: { accessToken: 'tok', accessTokenExpiryDate: '2026-10-08T00:00:00Z' } }],
    '/shopping/order/getOrderDetail': () => [200, { code: 200, result: true, data: { orderStatus: 'SHIPPED', trackNumber: 'YT1', logisticName: 'YunExpress' } }],
  });
  const cj = createCjClient({ apiKey: 'key', fetch, now: () => t });
  assert.deepStrictEqual(await cj.getOrder('CJ1'), { cjStatus: 'shipped', trackingNumber: 'YT1', carrier: 'YunExpress' });
  await cj.getOrder('CJ1');
  assert.strictEqual(calls.filter((c) => c.path.endsWith('getAccessToken')).length, 1);
  assert.deepStrictEqual(calls[1].query, { orderId: 'CJ1' });
  t += 24 * 3600_000;
  await cj.getOrder('CJ1');
  assert.strictEqual(calls.filter((c) => c.path.endsWith('getAccessToken')).length, 2);
});

test('CJ error envelopes throw, and request errors are not retryable', async () => {
  const { fetch } = fakeFetch({
    '/authentication/getAccessToken': tokenOk,
    '/shopping/order/createOrderV2': () => [400, { code: 1600100, result: false, message: 'Param error' }],
    '/shopping/order/getOrderDetail': () => [200, { code: 1600200, result: false, message: 'Busy' }],
  });
  const cj = createCjClient({ apiKey: 'key', fetch });
  await assert.rejects(cj.createOrder(order, [{ cjVariantId: 'v', quantity: 1 }]), (err) => /Param error/.test(err.message) && err.retryable === false);
  await assert.rejects(cj.getOrder('x'), (err) => /Busy/.test(err.message) && err.retryable === true);
});

test('a bad API key fails clearly', async () => {
  const { fetch } = fakeFetch({ '/authentication/getAccessToken': () => [200, { code: 1600001, result: false, message: 'Invalid API key' }] });
  const cj = createCjClient({ apiKey: 'nope', fetch });
  await assert.rejects(cj.getOrder('x'), /Invalid API key/);
});
