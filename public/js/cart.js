(async () => {
  const root = document.getElementById('cart-root');
  const cfg = await getConfig();
  const products = await api('/api/products');
  const imageBySlug = Object.fromEntries(products.map((p) => [p.slug, p.image]));

  async function render() {
    const items = Cart.read();
    if (!items.length) {
      root.replaceChildren(el('div', { class: 'panel' }, el('p', {}, 'Your cart is empty.'), el('a', { class: 'btn', href: '/#shop' }, 'Continue shopping')));
      return;
    }
    let quote;
    try {
      quote = await api('/api/cart/quote', { method: 'POST', body: JSON.stringify({ items }) });
    } catch (err) {
      // Drop items that no longer exist so the shopper isn't stuck.
      const valid = new Set(products.flatMap((p) => p.variants.map((v) => v.id)));
      Cart.write(items.filter((i) => valid.has(i.variantId) && Number.isInteger(i.quantity) && i.quantity > 0));
      root.replaceChildren(el('p', { class: 'error' }, err.message), el('button', { class: 'btn', onclick: render }, 'Refresh cart'));
      return;
    }
    const lines = quote.lines.map((l) => el('div', { class: 'line' },
      el('img', { src: imageBySlug[l.slug], alt: '', width: 72, height: 72 }),
      el('div', {},
        el('strong', {}, l.productName),
        el('div', { class: 'small muted' }, l.variantName, l.percentOff ? ` · ${l.percentOff}% bundle discount` : ''),
        el('div', { style: 'display:flex;gap:16px;align-items:center;margin-top:6px' },
          el('div', { class: 'qty' },
            el('button', { type: 'button', 'aria-label': 'Decrease quantity', onclick: () => { Cart.setQty(l.variantId, l.quantity - 1); render(); } }, '−'),
            el('span', {}, l.quantity),
            el('button', { type: 'button', 'aria-label': 'Increase quantity', disabled: l.quantity >= 10, onclick: () => { Cart.setQty(l.variantId, l.quantity + 1); render(); } }, '+')),
          el('button', { type: 'button', class: 'link-btn', onclick: () => { Cart.setQty(l.variantId, 0); render(); } }, 'Remove'))),
      el('div', { style: 'text-align:right' },
        el('strong', {}, money(l.lineTotal - l.discount)),
        l.discount ? el('div', { class: 'small compare' }, money(l.lineTotal)) : ''),
    ));
    root.replaceChildren(el('div', { class: 'two-col' },
      el('div', { class: 'panel' }, lines, el('p', { class: 'small muted' }, 'Tip: mix and match styles — bundle discounts count every style of the same product.')),
      el('aside', { class: 'panel' }, renderSummary(quote, cfg), el('a', { class: 'btn btn-block', href: '/checkout.html', style: 'margin-top:16px' }, 'Checkout'))));
  }
  render();
})();
