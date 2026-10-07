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

// ---- Slide-out cart drawer ----
let productsCache = null;
function getProducts() {
  if (!productsCache) productsCache = api('/api/products').catch((err) => { productsCache = null; throw err; });
  return productsCache;
}

let drawer = null;
function buildDrawer() {
  if (drawer) return drawer;
  const body = el('div', { class: 'drawer-body' });
  const foot = el('div', { class: 'drawer-foot' });
  const panel = el('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Your cart', tabindex: '-1' },
    el('div', { class: 'drawer-head' },
      el('h2', {}, 'Your cart'),
      el('button', { type: 'button', class: 'drawer-close', 'aria-label': 'Close cart', onclick: closeCart }, '×')),
    body, foot);
  document.body.append(el('div', { class: 'drawer-backdrop', onclick: closeCart }), panel);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('drawer-open')) closeCart(); });
  drawer = { panel, body, foot };
  return drawer;
}

async function renderDrawer() {
  const { body, foot } = buildDrawer();
  const items = Cart.read();
  if (!items.length) {
    body.replaceChildren(el('div', { class: 'drawer-empty' },
      el('p', { class: 'muted' }, 'Your cart is empty.'),
      el('a', { class: 'btn', href: '/#shop', onclick: closeCart }, 'Start shopping')));
    foot.replaceChildren();
    return;
  }
  let cfg, products, quote;
  try {
    [cfg, products, quote] = await Promise.all([
      getConfig(), getProducts(),
      api('/api/cart/quote', { method: 'POST', body: JSON.stringify({ items }) }),
    ]);
  } catch (err) {
    body.replaceChildren(el('p', { class: 'error' }, err.message), el('a', { class: 'btn btn-block', href: '/cart.html' }, 'Open cart'));
    foot.replaceChildren();
    return;
  }
  const imageBySlug = Object.fromEntries(products.map((p) => [p.slug, p.image]));
  const change = (variantId, quantity) => { Cart.setQty(variantId, quantity); renderDrawer(); };
  body.replaceChildren(...quote.lines.map((l) => el('div', { class: 'line' },
    el('img', { src: imageBySlug[l.slug], alt: '', width: 64, height: 64 }),
    el('div', {},
      el('strong', {}, l.productName),
      el('div', { class: 'small muted' }, l.variantName, l.percentOff ? ` · ${l.percentOff}% off` : ''),
      el('div', { style: 'display:flex;gap:12px;align-items:center;margin-top:6px' },
        el('div', { class: 'qty' },
          el('button', { type: 'button', 'aria-label': 'Decrease quantity', onclick: () => change(l.variantId, l.quantity - 1) }, '−'),
          el('span', {}, l.quantity),
          el('button', { type: 'button', 'aria-label': 'Increase quantity', disabled: l.quantity >= 10, onclick: () => change(l.variantId, l.quantity + 1) }, '+')),
        el('button', { type: 'button', class: 'link-btn', onclick: () => change(l.variantId, 0) }, 'Remove'))),
    el('div', { style: 'text-align:right' },
      el('strong', {}, money(l.lineTotal - l.discount)),
      l.discount ? el('div', { class: 'small compare' }, money(l.lineTotal)) : ''),
  )));

  const merchandise = quote.subtotal - quote.discount;
  const remaining = cfg.freeShippingThreshold - merchandise;
  const pct = Math.min(100, (merchandise / cfg.freeShippingThreshold) * 100);
  foot.replaceChildren(
    el('div', { class: 'small' }, remaining > 0 ? `You're ${money(remaining)} away from free shipping!` : '🎉 You’ve unlocked free shipping!'),
    el('div', { class: 'progress' }, el('div', { style: `width:${pct}%` })),
    quote.discount ? el('div', { class: 'summary-row discount small' }, el('span', {}, 'Bundle savings'), el('span', {}, `−${money(quote.discount)}`)) : '',
    el('div', { class: 'summary-row small' }, el('span', {}, 'Shipping'), el('span', {}, quote.shipping ? money(quote.shipping) : 'FREE')),
    el('div', { class: 'summary-row total' }, el('span', {}, 'Total'), el('span', {}, money(quote.total))),
    el('a', { class: 'btn btn-block', href: '/checkout.html' }, 'Checkout'),
    el('a', { class: 'btn btn-ghost btn-block', href: '/cart.html' }, 'View cart'),
  );
}

let lastFocus = null;
function openCart() {
  const { panel } = buildDrawer();
  lastFocus = document.activeElement;
  document.body.classList.add('drawer-open');
  renderDrawer();
  panel.focus();
}
function closeCart() {
  document.body.classList.remove('drawer-open');
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}

// The header cart link opens the drawer (except on the cart page itself,
// or when the shopper asks for a new tab).
document.addEventListener('click', (e) => {
  const link = e.target.closest && e.target.closest('.cart-link');
  if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  if (location.pathname === '/cart.html' || location.pathname === '/cart') return;
  e.preventDefault();
  openCart();
});

window.addEventListener('storage', (e) => { if (e.key === CART_KEY) updateCartCount(); });
document.addEventListener('DOMContentLoaded', renderChrome);
