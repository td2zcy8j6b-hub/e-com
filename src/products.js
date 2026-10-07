// Product catalog. The server is the only source of truth for prices: the
// browser sends variant ids and quantities, never amounts.
//
// `supplier` and each variant's `cjVariantId` are private (never sent to
// shoppers). Automation uses them to place the matching order with
// CJdropshipping. `cjVariantId` is CJ's "vid" for that exact variant: find it
// in your CJ account under My Products, or via CJ's product API. Orders for a
// variant with no `cjVariantId` are left for you to place by hand.

const products = [
  {
    slug: 'galaxy-star-projector',
    name: 'AuroraSky Galaxy Projector',
    tagline: 'Turn any room into a night sky in seconds.',
    description:
      'Project a slowly drifting nebula and thousands of twinkling stars across your ceiling. ' +
      'Ten colour modes, adjustable brightness, a 1–8 hour auto-off timer and a built-in Bluetooth ' +
      'speaker for white noise or your favourite playlist. Perfect for bedrooms, gaming setups and kids’ rooms.',
    features: [
      '10 nebula colour modes + star-only mode',
      'Built-in Bluetooth 5.3 speaker',
      'Remote control & 1–8h auto-off timer',
      'USB-C powered, whisper-quiet motor',
      'Covers up to 20 m² (215 ft²) of ceiling',
    ],
    image: '/img/projector.svg',
    compareAtPrice: 5999,
    rating: 4.8,
    reviewCount: 2143,
    variants: [
      { id: 'gsp-astronaut', name: 'Astronaut', price: 3499, cjVariantId: '' },
      { id: 'gsp-dome', name: 'Classic Dome', price: 2999, cjVariantId: '' },
    ],
    // Quantity breaks ("buy more, save more") apply per product line.
    quantityDiscounts: [
      { minQty: 2, percentOff: 10 },
      { minQty: 3, percentOff: 15 },
    ],
    reviews: [
      { author: 'Jess M.', rating: 5, text: 'My daughter refuses to sleep without it now. The colours are gorgeous.' },
      { author: 'Carlos R.', rating: 5, text: 'Looks insane behind my gaming setup. Speaker is surprisingly decent.' },
      { author: 'Priya K.', rating: 4, text: 'Shipping took 9 days but totally worth the wait.' },
    ],
    supplier: { name: 'CJdropshipping', sku: 'CJ-GSP-2291', unitCost: 1150 },
  },
  {
    slug: 'portable-blender',
    name: 'BlendGo Portable Blender',
    tagline: 'Fresh smoothies anywhere. Charges by USB-C.',
    description:
      'A 400 ml cordless blender with six stainless-steel blades that crushes ice and frozen fruit in ' +
      '30 seconds. Blend, sip straight from the jar and rinse clean. One charge lasts 15+ blends, so it ' +
      'goes to the gym, the office and on road trips with you.',
    features: [
      '6 stainless-steel blades, crushes ice',
      '400 ml BPA-free Tritan jar doubles as a bottle',
      'USB-C fast charge, 15+ blends per charge',
      'Magnetic safety lock – won’t spin unless closed',
      'Self-cleaning: add water + soap and blend',
    ],
    image: '/img/blender.svg',
    compareAtPrice: 4999,
    rating: 4.7,
    reviewCount: 1678,
    variants: [
      { id: 'pb-sage', name: 'Sage Green', price: 2999, cjVariantId: '' },
      { id: 'pb-blush', name: 'Blush Pink', price: 2999, cjVariantId: '' },
      { id: 'pb-midnight', name: 'Midnight Black', price: 2999, cjVariantId: '' },
    ],
    quantityDiscounts: [
      { minQty: 2, percentOff: 10 },
      { minQty: 3, percentOff: 15 },
    ],
    reviews: [
      { author: 'Hannah L.', rating: 5, text: 'Protein shakes at the gym with zero clumps. Love it.' },
      { author: 'Tom W.', rating: 5, text: 'Bought one, then two more as gifts. Battery lasts forever.' },
      { author: 'Aisha B.', rating: 4, text: 'Handles frozen berries fine, just add enough liquid.' },
    ],
    supplier: { name: 'CJdropshipping', sku: 'CJ-BLG-400', unitCost: 870 },
  },
];

function publicProduct(p) {
  const { supplier, variants, ...rest } = p;
  return { ...rest, variants: variants.map(({ cjVariantId, ...v }) => v) };
}

function findProduct(slug) {
  return products.find((p) => p.slug === slug);
}

function findVariant(variantId) {
  for (const product of products) {
    const variant = product.variants.find((v) => v.id === variantId);
    if (variant) return { product, variant };
  }
  return null;
}

// What the supplier charges for these order lines (cents).
function supplierCostOf(lines) {
  let cost = 0;
  for (const l of lines) {
    const found = findVariant(l.variantId);
    if (found && found.product.supplier) cost += found.product.supplier.unitCost * l.quantity;
  }
  return cost;
}

module.exports = { products, publicProduct, findProduct, findVariant, supplierCostOf };
