(() => {
  const TOKEN_KEY = 'nn_admin_token';
  const loginForm = document.getElementById('login');
  const dashboard = document.getElementById('dashboard');
  const tbody = document.getElementById('orders');
  const filter = document.getElementById('filter');
  let orders = [];

  const token = () => { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
  const setToken = (t) => { try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } };
  const adminApi = (url, opts = {}) => api(url, { ...opts, headers: { Authorization: `Bearer ${token()}` } });

  async function load() {
    try {
      orders = await adminApi('/api/admin/orders');
    } catch (err) {
      setToken('');
      dashboard.hidden = true;
      loginForm.hidden = false;
      document.getElementById('login-error').textContent = err.message;
      return;
    }
    loginForm.hidden = true;
    dashboard.hidden = false;
    render();
  }

  function render() {
    const paid = orders.filter((o) => !['pending_payment', 'cancelled', 'refunded'].includes(o.status));
    const revenue = paid.reduce((s, o) => s + o.total, 0);
    const profit = paid.reduce((s, o) => s + o.grossProfit, 0);
    const todo = orders.filter((o) => o.status === 'paid').length;
    document.getElementById('stats').replaceChildren(
      el('div', { class: 'stat' }, el('span', { class: 'small muted' }, 'Paid orders'), el('b', {}, paid.length)),
      el('div', { class: 'stat' }, el('span', { class: 'small muted' }, 'Revenue'), el('b', {}, money(revenue))),
      el('div', { class: 'stat' }, el('span', { class: 'small muted' }, 'Gross profit (after product cost)'), el('b', {}, money(profit))),
      el('div', { class: 'stat' }, el('span', { class: 'small muted' }, 'To order from supplier'), el('b', {}, todo)),
    );

    const shown = filter.value === 'all' ? orders : orders.filter((o) => ['paid', 'ordered_from_supplier'].includes(o.status));
    if (!shown.length) { tbody.replaceChildren(el('tr', {}, el('td', { colspan: 5, class: 'muted' }, 'Nothing here yet.'))); return; }
    tbody.replaceChildren(...shown.map(row));
  }

  function row(o) {
    const c = o.customer;
    const address = [c.address1, c.address2, `${c.city}${c.state ? ', ' + c.state : ''} ${c.postalCode}`, c.country].filter(Boolean);
    const supplierOrderId = el('input', { placeholder: 'Supplier order #', value: o.supplierOrderId || '' });
    const carrier = el('input', { placeholder: 'Carrier (e.g. USPS)', value: o.trackingCarrier || '' });
    const tracking = el('input', { placeholder: 'Tracking number', value: o.trackingNumber || '' });
    const status = el('select', {}, ['pending_payment', 'paid', 'ordered_from_supplier', 'shipped', 'cancelled', 'refunded']
      .map((s) => el('option', { value: s, selected: s === o.status }, s.replace(/_/g, ' '))));
    const save = el('button', { class: 'btn btn-sm', type: 'button', style: 'margin-top:6px', onclick: async () => {
      save.disabled = true;
      try {
        let next = status.value;
        // Adding a tracking number to an order implies it has shipped.
        if (tracking.value.trim() && ['paid', 'ordered_from_supplier'].includes(next)) next = 'shipped';
        else if (supplierOrderId.value.trim() && next === 'paid') next = 'ordered_from_supplier';
        const updated = await adminApi(`/api/admin/orders/${encodeURIComponent(o.id)}`, { method: 'PATCH', body: JSON.stringify({
          status: next, supplierOrderId: supplierOrderId.value.trim(), trackingCarrier: carrier.value.trim(), trackingNumber: tracking.value.trim(),
        }) });
        orders = orders.map((x) => (x.id === updated.id ? updated : x));
        toast(`Order ${o.id} saved`);
        render();
      } catch (err) { toast(err.message); save.disabled = false; }
    } }, 'Save');

    return el('tr', {},
      el('td', {}, el('strong', {}, o.id), el('div', { class: 'small muted' }, new Date(o.createdAt).toLocaleString()),
        el('span', { class: `status ${o.status}` }, o.status.replace(/_/g, ' '))),
      el('td', {}, el('strong', {}, `${c.firstName} ${c.lastName}`), el('div', {}, c.email), c.phone ? el('div', {}, c.phone) : '',
        el('div', { class: 'small muted' }, address.map((a) => el('div', {}, a)))),
      el('td', {}, o.lines.map((l) => el('div', { style: 'margin-bottom:6px' },
        el('div', {}, `${l.quantity} × ${l.productName} – ${l.variantName}`),
        l.supplier ? el('div', { class: 'small muted' }, `${l.supplier.name} · SKU ${l.supplier.sku} · cost ${money(l.supplier.unitCost)}/ea`) : ''))),
      el('td', {}, el('div', {}, 'Paid ', el('strong', {}, money(o.total))),
        el('div', { class: 'small muted' }, `Supplier cost ${money(o.supplierCost)}`),
        el('div', { class: 'small' }, 'Profit ', el('strong', {}, money(o.grossProfit)))),
      el('td', { style: 'min-width:200px' }, status, supplierOrderId, carrier, tracking, save),
    );
  }

  function exportCsv() {
    const header = ['order_id', 'created_at', 'status', 'email', 'name', 'address1', 'address2', 'city', 'state', 'postal_code', 'country', 'phone', 'supplier', 'supplier_sku', 'product', 'variant', 'quantity', 'total'];
    const rows = orders.flatMap((o) => o.lines.map((l) => [o.id, o.createdAt, o.status, o.customer.email, `${o.customer.firstName} ${o.customer.lastName}`,
      o.customer.address1, o.customer.address2 || '', o.customer.city, o.customer.state || '', o.customer.postalCode, o.customer.country, o.customer.phone || '',
      l.supplier ? l.supplier.name : '', l.supplier ? l.supplier.sku : '', l.productName, l.variantName, l.quantity, (o.total / 100).toFixed(2)]));
    // Quote every cell and neutralise spreadsheet formula injection.
    const cell = (v) => `"${String(v).replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"`;
    const csv = [header, ...rows].map((r) => r.map(cell).join(',')).join('\n');
    const a = el('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `orders-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    URL.revokeObjectURL(a.href);
  }

  loginForm.addEventListener('submit', (e) => { e.preventDefault(); setToken(document.getElementById('password').value); load(); });
  document.getElementById('refresh').addEventListener('click', load);
  document.getElementById('export').addEventListener('click', exportCsv);
  document.getElementById('logout').addEventListener('click', () => { setToken(''); location.reload(); });
  filter.addEventListener('change', render);
  if (token()) load();
})();
