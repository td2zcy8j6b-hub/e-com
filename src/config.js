// Store-wide settings. Override anything marked "env" in a .env file (see .env.example).
const env = process.env;

module.exports = {
  storeName: env.STORE_NAME || 'Nova & Nest',
  currency: 'usd',
  // Prices are integers in cents everywhere to avoid floating-point rounding.
  freeShippingThreshold: 4900,
  standardShipping: 499,
  // How long suppliers typically take, shown on product pages and policies.
  processingDays: '1-3',
  deliveryDays: '7-12',
  supportEmail: env.SUPPORT_EMAIL || 'support@example.com',

  // ---- Automation (see README "Automation") ----
  // Emails: customers get mail from EMAIL_FROM; alerts and the daily digest go to OWNER_EMAIL.
  emailFrom: env.EMAIL_FROM || '',
  ownerEmail: env.OWNER_EMAIL || '',
  // CJdropshipping shipping method used for every supplier order.
  cjLogisticName: env.CJ_LOGISTIC_NAME || 'CJPacket Ordinary',
  cjFromCountry: env.CJ_FROM_COUNTRY || 'CN',
  // How often the server runs automation on its own (an external cron can also trigger it).
  automationIntervalMinutes: Number(env.AUTOMATION_INTERVAL_MINUTES) || 10,
  // Unpaid Stripe Checkout sessions expire after 24 hours, so the order is cancelled then.
  pendingPaymentTtlHours: 24,
  // Supplier order attempts before giving up and leaving it to the owner.
  maxSupplierAttempts: 5,
  // Owner is warned when an order has been with the supplier this long without tracking.
  stuckWithoutTrackingDays: 10,
  // Hour of the day (server time, 0-23) after which the daily digest is sent.
  digestHour: env.DIGEST_HOUR === undefined ? 8 : Number(env.DIGEST_HOUR),
};
