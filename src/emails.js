// Email templates. Each returns { subject, text, html }. Customer data is
// always escaped before it goes into HTML.
const config = require('./config');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const money = (cents, currency = config.currency) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
const trackUrl = (n) => `https://t.17track.net/en#nums=${encodeURIComponent(n)}`;

function shipmentsOf(order) {
  if (order.shipments && order.shipments.length) return order.shipments;
  return order.trackingNumber ? [{ carrier: order.trackingCarrier, trackingNumber: order.trackingNumber }] : [];
}

function layout(title, paragraphs, order, baseUrl) {
  const lines = order ? order.lines.map((l) => `${l.quantity} × ${l.productName} (${l.variantName})`) : [];
  const orderLink = order && baseUrl ? `${baseUrl}/track.html?order=${encodeURIComponent(order.id)}&email=${encodeURIComponent(order.customer.email)}` : null;
  const text = [
    ...paragraphs.map((p) => p.text),
    ...(order ? ['', `Order ${order.id}`, ...lines, `Total: ${money(order.total, order.currency)}`] : []),
    ...(orderLink ? ['', `View your order: ${orderLink}`] : []),
    '', `Questions? Reply to this email or write to ${config.supportEmail}.`, `– ${config.storeName}`,
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#1f2937;max-width:560px;margin:0 auto;padding:24px">
<h2 style="margin-top:0">${esc(title)}</h2>
${paragraphs.map((p) => `<p>${p.html ?? esc(p.text)}</p>`).join('\n')}
${order ? `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin:16px 0">
<strong>Order ${esc(order.id)}</strong><br>${lines.map(esc).join('<br>')}<br><strong>Total: ${esc(money(order.total, order.currency))}</strong></div>` : ''}
${orderLink ? `<p><a href="${esc(orderLink)}">View your order</a></p>` : ''}
<p style="color:#6b7280;font-size:14px">Questions? Reply to this email or write to ${esc(config.supportEmail)}.<br>– ${esc(config.storeName)}</p>
</body></html>`;
  return { subject: title, text, html };
}

const customerTemplates = {
  confirmation: (o, baseUrl) => layout(`Order confirmed – ${o.id}`, [
    { text: `Hi ${o.customer.firstName}, thanks for your order! We've received your payment and are preparing it now.` },
    { text: `Orders leave our warehouse in ${config.processingDays} business days and usually arrive within ${config.deliveryDays} business days. We'll email you the tracking number as soon as it ships.` },
  ], o, baseUrl),

  shipped: (o, baseUrl) => {
    const shipments = shipmentsOf(o);
    return layout(`Your order ${o.id} has shipped`, [
      { text: `Hi ${o.customer.firstName}, good news: your order is on its way.` },
      ...shipments.map((s) => ({
        text: `Tracking: ${s.carrier ? s.carrier + ' ' : ''}${s.trackingNumber} – ${trackUrl(s.trackingNumber)}`,
        html: `Tracking: <strong>${esc(s.carrier ? s.carrier + ' ' : '')}${esc(s.trackingNumber)}</strong> – <a href="${esc(trackUrl(s.trackingNumber))}">track your package</a>`,
      })),
      { text: `Tracking can take 2–3 days to show its first update. Delivery usually takes ${config.deliveryDays} business days.` },
    ], o, baseUrl);
  },

  refunded: (o, baseUrl) => layout(`Refund issued for order ${o.id}`, [
    { text: `Hi ${o.customer.firstName}, we've refunded ${money(o.total, o.currency)} for this order. It usually appears on your statement within 5–10 business days.` },
  ], o, baseUrl),

  cancelled: (o, baseUrl) => layout(`Order ${o.id} cancelled`, [
    { text: `Hi ${o.customer.firstName}, your order has been cancelled.${o.paidAt ? ' If you were charged, the refund will follow in a separate email.' : ' You have not been charged.'}` },
  ], o, baseUrl),
};

function ownerAlert(subject, body) {
  return { subject: `[${config.storeName}] ${subject}`, text: body, html: `<pre style="font-family:system-ui,sans-serif;white-space:pre-wrap">${esc(body)}</pre>` };
}

// digest: { date, orders, revenue, profit, awaitingPayment, stuck, failed }
function ownerDigest(d) {
  const list = (title, items, fmt) => (items.length ? [``, `${title} (${items.length}):`, ...items.map((o) => `  • ${fmt(o)}`)] : []);
  const body = [
    `Daily summary for ${d.date}`,
    ``,
    `New paid orders: ${d.orders}`,
    `Revenue: ${money(d.revenue)}`,
    `Gross profit after product cost: ${money(d.profit)}`,
    ...list('Waiting for you to pay in CJdropshipping (My CJ → Orders)', d.awaitingPayment, (o) => `${o.id} → CJ order ${o.fulfilment.cjOrderId}`),
    ...list(`With the supplier ${config.stuckWithoutTrackingDays}+ days and still no tracking`, d.stuck, (o) => `${o.id} (CJ ${o.supplierOrderId})`),
    ...list('Need placing by hand (automation could not)', d.failed, (o) => `${o.id}: ${o.fulfilment.lastError}`),
    ``,
    d.awaitingPayment.length || d.stuck.length || d.failed.length ? 'Everything else is running automatically.' : 'Nothing needs your attention.',
  ].join('\n');
  return ownerAlert(`Daily summary – ${d.date}`, body);
}

module.exports = { customerTemplates, ownerAlert, ownerDigest, shipmentsOf, esc };
