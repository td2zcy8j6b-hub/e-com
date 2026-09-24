// Shared helpers: cart (localStorage), money formatting, header/footer.
const CART_KEY = 'nn_cart_v1';

const Cart = {
  read() {
    try {
      const items = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
      return Array.isArray(items) ? items : [];
    } catch { return []; }
  },
  write(items) {
    try { localStorage.setItem(CART_KEY, JSON.stringify(items)); } catch { /* private mode */ }
    updateCartCount();
  },
  add(variantId, quantity) {
    const items = Cart.read();
    const existing = items.find((i) => i.variantId === variantId);
    if (existing) existing.quantity = Math.min(10, existing.quantity + quantity);
    else items.push({ variantId, quantity: Math.min(10, quantity) });
    Cart.write(items);
  },
  setQty(variantId, quantity) {
    Cart.write(Cart.read().map((i) => (i.variantId === variantId ? { ...i, quantity } : i)).filter((i) => i.quantity > 0));
  },
  clear() { Cart.write([]); },
  count() { return Cart.read().reduce((s, i) => s + i.quantity, 0); },
};

let storeConfig = null;
async function getConfig() {
  if (!storeConfig) storeConfig = await api('/api/config');
  return storeConfig;
}

function money(cents, currency = 'usd') {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
}

function stars(rating) {
  const full = Math.round(rating);
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Tiny element builder that only ever sets text (never innerHTML) for user data.
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

function toast(message) {
  let t = document.querySelector('.toast');
  if (!t) { t = el('div', { class: 'toast', role: 'status' }); document.body.append(t); }
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}

function updateCartCount() {
  const n = Cart.count();
  document.querySelectorAll('.cart-count').forEach((c) => { c.textContent = n; c.dataset.count = n; });
}

async function renderChrome() {
  const cfg = await getConfig().catch(() => ({ storeName: 'Store', freeShippingThreshold: 4900 }));
  const [first, ...rest] = cfg.storeName.split(' ');
  const header = document.getElementById('site-header');
  if (header) {
    header.replaceChildren(
      el('div', { class: 'announce' }, `Free shipping on orders over ${money(cfg.freeShippingThreshold)} · 30-day money-back guarantee`),
      el('header', { class: 'site-header' },
        el('div', { class: 'container' },
          el('a', { class: 'logo', href: '/' }, first + ' ', el('span', {}, rest.join(' '))),
          el('nav', { class: 'nav' },
            el('a', { href: '/#shop' }, 'Shop'),
            el('a', { href: '/track.html', class: 'hide-sm' }, 'Track order'),
            el('a', { href: '/cart.html', class: 'cart-link', 'aria-label': 'Cart' }, 'Cart', el('span', { class: 'cart-count', 'data-count': '0' }, '0')),
          ),
        ),
      ),
    );
  }
  const footer = document.getElementById('site-footer');
  if (footer) {
    footer.replaceChildren(
      el('footer', { class: 'site-footer' },
        el('div', { class: 'container' },
          el('div', {},
            el('a', { href: '/policies.html#shipping' }, 'Shipping'),
            el('a', { href: '/policies.html#returns' }, 'Returns & refunds'),
            el('a', { href: '/policies.html#privacy' }, 'Privacy'),
            el('a', { href: '/policies.html#terms' }, 'Terms'),
            el('a', { href: '/track.html' }, 'Track order'),
          ),
          el('div', {}, `© ${new Date().getFullYear()} ${cfg.storeName} · `, el('a', { href: `mailto:${cfg.supportEmail}` }, cfg.supportEmail)),
        ),
      ),
    );
  }
  updateCartCount();
}

window.addEventListener('storage', (e) => { if (e.key === CART_KEY) updateCartCount(); });
document.addEventListener('DOMContentLoaded', renderChrome);
