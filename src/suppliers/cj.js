// CJdropshipping API 2.0 client: places supplier orders and reads back tracking.
//
// Field names follow CJ's API 2.0 docs (developers.cjdropshipping.com →
// API 2.0 → Authentication / Shopping). If CJ changes them, this is the only
// file to update.

const DEFAULT_BASE_URL = 'https://developers.cjdropshipping.com/api2.0/v1';

// createOrderV2 payType 3 = "create the order only, don't pay from balance".
// The owner reviews and pays each order in CJ's dashboard (My CJ → Orders).
const PAY_TYPE_CREATE_ONLY = 3;

// CJ order statuses grouped into what the store cares about.
const STATUS_MAP = {
  CREATED: 'awaiting_payment',
  IN_CART: 'awaiting_payment',
  UNPAID: 'awaiting_payment',
  UNSHIPPED: 'processing',
  SHIPPED: 'shipped',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
};

class CjError extends Error {
  constructor(message, { code, retryable = true } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

const countryName = (code) => {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code; } catch { return code; }
};

function createCjClient({ apiKey, baseUrl = DEFAULT_BASE_URL, fetch = globalThis.fetch, logisticName, fromCountryCode = 'CN', now = () => Date.now() }) {
  if (!apiKey) throw new Error('CJ apiKey is required');
  let token = null; // { value, expiresAt }

  async function request(method, path, { body, query, auth = true } = {}) {
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers['CJ-Access-Token'] = await accessToken();
    let res;
    try {
      res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    } catch (err) {
      throw new CjError(`CJ request failed: ${err.message}`);
    }
    const data = await res.json().catch(() => null);
    if (res.status === 401 && auth) token = null;
    if (!res.ok || !data || data.result === false || (data.code !== undefined && data.code !== 200)) {
      const message = (data && data.message) || `HTTP ${res.status}`;
      // 4xx other than auth/rate limits means the request itself is wrong; retrying won't help.
      const retryable = res.status >= 500 || res.status === 401 || res.status === 429 || res.ok;
      throw new CjError(`CJ ${path}: ${message}`, { code: data && data.code, retryable });
    }
    return data.data;
  }

  async function accessToken() {
    if (token && token.expiresAt > now() + 60_000) return token.value;
    const data = await request('POST', '/authentication/getAccessToken', { body: { apiKey }, auth: false });
    if (!data || !data.accessToken) throw new CjError('CJ did not return an access token', { retryable: false });
    const expiry = Date.parse(data.accessTokenExpiryDate);
    // Tokens last about 15 days; fall back to a day if CJ omits the expiry.
    token = { value: data.accessToken, expiresAt: Number.isFinite(expiry) ? expiry : now() + 24 * 3600_000 };
    return token.value;
  }

  // lines: [{ cjVariantId, quantity }]. Our order id doubles as CJ's orderNumber,
  // which CJ keeps unique, so a retried submission can't create a duplicate order.
  async function createOrder(order, lines) {
    const c = order.customer;
    const data = await request('POST', '/shopping/order/createOrderV2', {
      body: {
        orderNumber: order.id,
        shippingCountryCode: c.country,
        shippingCountry: countryName(c.country),
        shippingProvince: c.state || '',
        shippingCity: c.city,
        shippingAddress: c.address1,
        shippingAddress2: c.address2 || '',
        shippingZip: c.postalCode,
        shippingCustomerName: `${c.firstName} ${c.lastName}`,
        shippingPhone: c.phone || '',
        email: c.email,
        remark: '',
        logisticName,
        fromCountryCode,
        payType: PAY_TYPE_CREATE_ONLY,
        products: lines.map((l) => ({ vid: l.cjVariantId, quantity: l.quantity })),
      },
    });
    const cjOrderId = data && (data.orderId || data.cjOrderId);
    if (!cjOrderId) throw new CjError('CJ accepted the order but returned no order id', { retryable: false });
    return { cjOrderId: String(cjOrderId), cjStatus: STATUS_MAP[data.orderStatus] || 'awaiting_payment' };
  }

  async function getOrder(cjOrderId) {
    const data = await request('GET', '/shopping/order/getOrderDetail', { query: { orderId: cjOrderId } });
    if (!data) throw new CjError(`CJ order ${cjOrderId} not found`);
    return {
      cjStatus: STATUS_MAP[data.orderStatus] || 'processing',
      trackingNumber: data.trackNumber || data.trackingNumber || null,
      carrier: data.logisticName || null,
    };
  }

  return { createOrder, getOrder };
}

module.exports = { createCjClient, CjError, STATUS_MAP };
