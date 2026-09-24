(async () => {
  const grid = document.getElementById('product-grid');
  try {
    const products = await api('/api/products');
    grid.replaceChildren(...products.map((p) => {
      const from = Math.min(...p.variants.map((v) => v.price));
      const savePct = Math.round((1 - from / p.compareAtPrice) * 100);
      return el('a', { class: 'card', href: `/product.html?slug=${encodeURIComponent(p.slug)}` },
        el('img', { src: p.image, alt: p.name, width: 600, height: 600, loading: 'lazy' }),
        el('div', { class: 'card-body' },
          el('div', {}, el('span', { class: 'badge' }, `Save ${savePct}%`)),
          el('h3', {}, p.name),
          el('div', { class: 'muted' }, p.tagline),
          el('div', { class: 'small' }, el('span', { class: 'stars' }, stars(p.rating)), ` ${p.rating} (${p.reviewCount.toLocaleString()} reviews)`),
          el('div', { class: 'price' }, `From ${money(from)}`, el('span', { class: 'compare' }, money(p.compareAtPrice))),
        ),
      );
    }));
  } catch (err) {
    grid.replaceChildren(el('p', { class: 'error' }, `Couldn't load products: ${err.message}`));
  }
})();
