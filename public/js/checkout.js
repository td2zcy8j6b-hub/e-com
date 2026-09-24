(async () => {
  const form = document.getElementById('checkout-form');
  const summary = document.getElementById('summary');
  const errorEl = document.getElementById('checkout-error');
  const payBtn = document.getElementById('pay-btn');
  const cfg = await getConfig();
  const items = Cart.read();

  if (!items.length) { location.href = '/cart.html'; return; }

  if (cfg.paymentMode === 'demo') {
    document.getElementById('mode-notice').replaceChildren(el('div', { class: 'notice' },
      el('strong', {}, 'Demo mode: '), 'no payment provider is configured, so orders are accepted without charging a card. Set STRIPE_SECRET_KEY to take real payments.'));
    payBtn.textContent = 'Place order (demo)';
  }

  try {
    const quote = await api('/api/cart/quote', { method: 'POST', body: JSON.stringify({ items }) });
    summary.replaceChildren(
      ...renderSummary(quote, cfg).slice(0, 1),
      ...quote.lines.map((l) => el('div', { class: 'summary-row small' }, el('span', {}, `${l.quantity} × ${l.productName} (${l.variantName})`), el('span', {}, money(l.lineTotal - l.discount)))),
      ...renderSummary(quote, cfg).slice(1),
    );
  } catch (err) {
    summary.replaceChildren(el('p', { class: 'error' }, err.message), el('a', { href: '/cart.html' }, 'Back to cart'));
    payBtn.disabled = true;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const customer = Object.fromEntries(new FormData(form));
    payBtn.disabled = true;
    payBtn.textContent = 'Processing…';
    try {
      const { redirectUrl } = await api('/api/checkout', { method: 'POST', body: JSON.stringify({ items: Cart.read(), customer }) });
      // Cart is cleared on the success page, so an abandoned Stripe payment keeps it.
      location.href = redirectUrl;
    } catch (err) {
      errorEl.textContent = err.message;
      payBtn.disabled = false;
      payBtn.textContent = cfg.paymentMode === 'demo' ? 'Place order (demo)' : 'Continue to payment';
    }
  });
})();
