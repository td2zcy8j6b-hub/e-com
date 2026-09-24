// Renders a server-priced order summary (used by cart and checkout pages).
function renderSummary(quote, cfg) {
  const rows = [
    el('div', { class: 'summary-row' }, el('span', {}, 'Subtotal'), el('span', {}, money(quote.subtotal))),
  ];
  if (quote.discount) rows.push(el('div', { class: 'summary-row discount' }, el('span', {}, 'Bundle discount'), el('span', {}, `−${money(quote.discount)}`)));
  rows.push(el('div', { class: 'summary-row' }, el('span', {}, 'Shipping'), el('span', {}, quote.shipping ? money(quote.shipping) : 'FREE')));
  rows.push(el('div', { class: 'summary-row total' }, el('span', {}, 'Total'), el('span', {}, money(quote.total))));

  const remaining = cfg.freeShippingThreshold - (quote.subtotal - quote.discount);
  const pct = Math.min(100, ((quote.subtotal - quote.discount) / cfg.freeShippingThreshold) * 100);
  const progress = [
    el('div', { class: 'small' }, remaining > 0 ? `You're ${money(remaining)} away from free shipping!` : '🎉 You’ve unlocked free shipping!'),
    el('div', { class: 'progress' }, el('div', { style: `width:${pct}%` })),
  ];
  return [el('h2', {}, 'Order summary'), ...progress, ...rows];
}
