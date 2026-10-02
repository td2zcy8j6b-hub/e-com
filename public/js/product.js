(async () => {
  const root = document.getElementById('product-root');
  const slug = new URLSearchParams(location.search).get('slug');
  let p;
  try {
    p = await api(`/api/products/${encodeURIComponent(slug || '')}`);
  } catch {
    root.replaceChildren(el('div', { class: 'page' }, el('h1', {}, 'Product not found'), el('a', { class: 'btn', href: '/' }, 'Back to shop')));
    return;
  }
  const cfg = await getConfig();
  document.title = `${p.name} – ${cfg.storeName}`;

  let variant = p.variants[0];
  let qty = 1;

  const priceEl = el('div', { class: 'price' });
  const variantButtons = p.variants.map((v) =>
    el('button', { type: 'button', class: 'variant', 'aria-pressed': String(v === variant), onclick: () => { variant = v; render(); } }, v.name));

  const tiers = [{ minQty: 1, percentOff: 0 }, ...p.quantityDiscounts];
  const bundleInputs = [];
  const bundles = el('div', { class: 'bundles', role: 'radiogroup', 'aria-label': 'Quantity' },
    tiers.map((t, i) => {
      const input = el('input', { type: 'radio', name: 'bundle', value: t.minQty, checked: i === 0, onchange: () => { qty = t.minQty; render(); } });
      bundleInputs.push({ input, tier: t });
      return el('label', { class: 'bundle' },
        el('span', {}, input, ' ', el('strong', {}, t.minQty === 1 ? 'Buy 1' : `Buy ${t.minQty}`), t.minQty > 1 ? ' ' : '', t.percentOff ? el('span', { class: 'save' }, `SAVE ${t.percentOff}%`) : ''),
        el('span', { class: 'bundle-price' }),
      );
    }));

  function unitAfter(t) { return variant.price - Math.round((variant.price * t.percentOff) / 100); }

  function render() {
    variantButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(p.variants[i] === variant)));
    priceEl.replaceChildren(money(variant.price), el('span', { class: 'compare' }, money(p.compareAtPrice)));
    bundleInputs.forEach(({ input, tier }) => {
      input.closest('.bundle').querySelector('.bundle-price').textContent = money(unitAfter(tier) * tier.minQty);
    });
  }

  const addBtn = el('button', { class: 'btn btn-block', type: 'button', onclick: () => { Cart.add(variant.id, qty); toast(`Added ${qty} × ${p.name} to cart`); } }, 'Add to cart');
  const buyBtn = el('button', { class: 'btn btn-ghost btn-block', type: 'button', style: 'margin-top:10px', onclick: () => { Cart.add(variant.id, qty); location.href = '/checkout.html'; } }, 'Buy it now');

  root.replaceChildren(
    el('div', { class: 'product' },
      el('div', { class: 'product-media' }, el('img', { src: p.image, alt: p.name, width: 600, height: 600 })),
      el('div', {},
        el('span', { class: 'badge' }, 'Bestseller'),
        el('h1', { style: 'margin-top:10px' }, p.name),
        el('div', { class: 'small', style: 'margin-bottom:8px' }, el('span', { class: 'stars' }, stars(p.rating)), ` ${p.rating} · ${p.reviewCount.toLocaleString()} reviews`),
        priceEl,
        el('p', { class: 'muted' }, p.tagline),
        el('strong', {}, 'Style'),
        el('div', { class: 'variants' }, variantButtons),
        el('strong', {}, 'Bundle & save'),
        bundles,
        addBtn, buyBtn,
        el('p', { class: 'small muted', style: 'text-align:center' },
          `🚚 Ships in ${cfg.processingDays} business days · Delivered in ${cfg.deliveryDays} days · Free shipping over ${money(cfg.freeShippingThreshold)}`),
        el('h3', { style: 'margin-top:24px' }, 'Why you’ll love it'),
        el('p', {}, p.description),
        el('ul', { class: 'features' }, p.features.map((f) => el('li', {}, f))),
      ),
    ),
    el('section', { class: 'reviews' },
      el('h2', {}, 'Customer reviews'),
      p.reviews.map((r) => el('div', { class: 'review' },
        el('div', { class: 'stars' }, stars(r.rating)),
        el('p', { style: 'margin:6px 0' }, r.text),
        el('div', { class: 'small muted' }, `${r.author} · Verified buyer`))),
    ),
  );
  render();
})();
