(async () => {
  const root = document.getElementById('success-root');
  const params = new URLSearchParams(location.search);
  const id = params.get('order');
  const email = params.get('email');
  const cfg = await getConfig();
  try {
    const order = await api(`/api/orders/${encodeURIComponent(id)}?email=${encodeURIComponent(email || '')}`);
    if (order.status === 'pending_payment') {
      root.replaceChildren(el('h1', {}, 'Payment not completed'),
        el('p', {}, 'We haven’t received your payment yet. If you were charged, it can take a minute to confirm — refresh this page shortly.'),
        el('a', { class: 'btn', href: '/cart.html' }, 'Return to cart'));
      return;
    }
    Cart.clear();
    root.replaceChildren(
      el('h1', {}, '🎉 Thank you for your order!'),
      el('p', {}, `We've received your order and will email ${email} with tracking as soon as it ships (usually within ${cfg.processingDays} business days).`),
      el('p', { class: 'small muted' }, 'Save your order number to track it any time.'),
      ...renderOrder(order),
      el('div', { style: 'margin-top:24px;display:flex;gap:12px;flex-wrap:wrap' },
        el('a', { class: 'btn', href: '/' }, 'Continue shopping'),
        el('a', { class: 'btn btn-ghost', href: `/track.html?order=${encodeURIComponent(order.id)}&email=${encodeURIComponent(email)}` }, 'Track order')),
    );
  } catch (err) {
    root.replaceChildren(el('h1', {}, 'Order not found'), el('p', {}, err.message), el('a', { class: 'btn', href: '/' }, 'Back to shop'));
  }
})();
