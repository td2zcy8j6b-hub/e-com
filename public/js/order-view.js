const STATUS_LABELS = {
  pending_payment: 'Awaiting payment',
  paid: 'Confirmed – preparing your order',
  ordered_from_supplier: 'Processing at our warehouse',
  shipped: 'Shipped',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
};

function renderOrder(o) {
  return [
    el('div', { class: 'summary-row' }, el('strong', {}, `Order ${o.id}`), el('span', { class: `status ${o.status}` }, STATUS_LABELS[o.status] || o.status)),
    el('p', { class: 'small muted' }, `Placed ${new Date(o.createdAt).toLocaleString()} · Shipping to ${o.shipTo.firstName}, ${o.shipTo.city}, ${o.shipTo.country}`),
    o.trackingNumber ? el('p', {}, '📦 Tracking: ', el('strong', {}, `${o.trackingCarrier ? o.trackingCarrier + ' ' : ''}${o.trackingNumber}`), ' · ',
      el('a', { href: `https://t.17track.net/en#nums=${encodeURIComponent(o.trackingNumber)}`, target: '_blank', rel: 'noopener' }, 'Track package')) : '',
    ...o.lines.map((l) => el('div', { class: 'summary-row' }, el('span', {}, `${l.quantity} × ${l.productName} (${l.variantName})`), el('span', {}, money(l.lineTotal - l.discount, o.currency)))),
    el('div', { class: 'summary-row' }, el('span', {}, 'Shipping'), el('span', {}, o.shipping ? money(o.shipping, o.currency) : 'FREE')),
    el('div', { class: 'summary-row total' }, el('span', {}, 'Total'), el('span', {}, money(o.total, o.currency))),
  ];
}
