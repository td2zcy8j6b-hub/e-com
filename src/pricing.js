const config = require('./config');
const { findVariant } = require('./products');

const MAX_QTY_PER_LINE = 10;

class CartError extends Error {}

// Turns [{ variantId, quantity }] from the browser into priced line items.
// Throws CartError for anything malformed so the route can answer 400.
function priceCart(items) {
  if (!Array.isArray(items) || items.length === 0) throw new CartError('Your cart is empty.');
  if (items.length > 20) throw new CartError('Too many items in cart.');

  const merged = new Map();
  for (const item of items) {
    const quantity = Number(item && item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) throw new CartError('Invalid quantity.');
    const found = findVariant(item.variantId);
    if (!found) throw new CartError('One of the items in your cart is no longer available.');
    const next = (merged.get(item.variantId) || 0) + quantity;
    if (next > MAX_QTY_PER_LINE) throw new CartError(`Maximum ${MAX_QTY_PER_LINE} of each item per order.`);
    merged.set(item.variantId, next);
  }

  const lines = [...merged].map(([variantId, quantity]) => {
    const { product, variant } = findVariant(variantId);
    return {
      variantId,
      slug: product.slug,
      productName: product.name,
      variantName: variant.name,
      unitPrice: variant.price,
      quantity,
      lineTotal: variant.price * quantity,
    };
  });

  // Quantity discounts count every variant of the same product together.
  let discount = 0;
  const qtyBySlug = {};
  for (const l of lines) qtyBySlug[l.slug] = (qtyBySlug[l.slug] || 0) + l.quantity;
  for (const l of lines) {
    const { product } = findVariant(l.variantId);
    const tier = [...(product.quantityDiscounts || [])]
      .sort((a, b) => b.minQty - a.minQty)
      .find((t) => qtyBySlug[l.slug] >= t.minQty);
    l.percentOff = tier ? tier.percentOff : 0;
    // Discount is rounded per unit so every unit has a whole-cent price.
    l.unitDiscount = Math.round((l.unitPrice * l.percentOff) / 100);
    l.discount = l.unitDiscount * l.quantity;
    discount += l.discount;
  }

  const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const afterDiscount = subtotal - discount;
  const shipping = afterDiscount >= config.freeShippingThreshold ? 0 : config.standardShipping;

  return { lines, subtotal, discount, shipping, total: afterDiscount + shipping, currency: config.currency };
}

module.exports = { priceCart, CartError, MAX_QTY_PER_LINE };
