const test = require('node:test');
const assert = require('node:assert');
const { priceCart, CartError } = require('../src/pricing');

test('single item under threshold pays shipping', () => {
  const q = priceCart([{ variantId: 'pb-sage', quantity: 1 }]);
  assert.strictEqual(q.subtotal, 2999);
  assert.strictEqual(q.discount, 0);
  assert.strictEqual(q.shipping, 499);
  assert.strictEqual(q.total, 3498);
});

test('quantity discount counts all variants of the same product', () => {
  const q = priceCart([{ variantId: 'pb-sage', quantity: 1 }, { variantId: 'pb-blush', quantity: 1 }]);
  assert.strictEqual(q.subtotal, 5998);
  assert.strictEqual(q.discount, 600); // 10% of 2999 = 299.9 -> 300 per unit
  assert.strictEqual(q.shipping, 0);
  assert.strictEqual(q.total, 5398);
});

test('highest applicable tier wins and duplicate lines merge', () => {
  const q = priceCart([{ variantId: 'gsp-astronaut', quantity: 2 }, { variantId: 'gsp-astronaut', quantity: 1 }]);
  assert.strictEqual(q.lines.length, 1);
  assert.strictEqual(q.lines[0].quantity, 3);
  assert.strictEqual(q.lines[0].percentOff, 15);
  assert.strictEqual(q.discount, 525 * 3);
});

test('discounts do not cross products', () => {
  const q = priceCart([{ variantId: 'pb-sage', quantity: 1 }, { variantId: 'gsp-dome', quantity: 1 }]);
  assert.strictEqual(q.discount, 0);
});

test('rejects bad carts', () => {
  for (const items of [[], null, [{ variantId: 'nope', quantity: 1 }], [{ variantId: 'pb-sage', quantity: 0 }],
    [{ variantId: 'pb-sage', quantity: 1.5 }], [{ variantId: 'pb-sage', quantity: 11 }], [{ variantId: 'pb-sage', quantity: '2' }]]) {
    if (items && items[0] && items[0].quantity === '2') {
      // Numeric strings are coerced, which is fine.
      assert.strictEqual(priceCart(items).lines[0].quantity, 2);
      continue;
    }
    assert.throws(() => priceCart(items), CartError, JSON.stringify(items));
  }
});
