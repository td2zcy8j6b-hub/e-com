const { createApp } = require('./src/app');

const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeKey ? require('stripe')(stripeKey) : null;
const port = Number(process.env.PORT) || 3000;

createApp({ stripe }).listen(port, () => {
  console.log(`Store running on http://localhost:${port}`);
  console.log(`Payments: ${stripe ? 'Stripe Checkout' : 'DEMO MODE (no STRIPE_SECRET_KEY set – orders are auto-approved)'}`);
  if (!process.env.ADMIN_PASSWORD) console.log('Admin disabled: set ADMIN_PASSWORD to use /admin.html');
});
