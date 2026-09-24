// Store-wide settings. Override anything marked "env" in a .env file (see .env.example).
module.exports = {
  storeName: process.env.STORE_NAME || 'Nova & Nest',
  currency: 'usd',
  // Prices are integers in cents everywhere to avoid floating-point rounding.
  freeShippingThreshold: 4900,
  standardShipping: 499,
  // How long suppliers typically take, shown on product pages and policies.
  processingDays: '1-3',
  deliveryDays: '7-12',
  supportEmail: process.env.SUPPORT_EMAIL || 'support@example.com',
};
