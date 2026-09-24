(() => {
  const form = document.getElementById('track-form');
  const result = document.getElementById('track-result');
  const errorEl = document.getElementById('track-error');
  const params = new URLSearchParams(location.search);
  form.orderId.value = params.get('order') || '';
  form.email.value = params.get('email') || '';

  async function lookup() {
    errorEl.textContent = '';
    result.replaceChildren();
    try {
      const order = await api(`/api/orders/${encodeURIComponent(form.orderId.value.trim().toUpperCase())}?email=${encodeURIComponent(form.email.value.trim())}`);
      result.replaceChildren(el('div', { class: 'panel' }, ...renderOrder(order)));
    } catch {
      errorEl.textContent = 'We couldn’t find an order with that number and email.';
    }
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); lookup(); });
  if (form.orderId.value && form.email.value) lookup();
})();
