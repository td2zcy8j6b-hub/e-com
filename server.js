const path = require('path');
const config = require('./src/config');
const { createApp } = require('./src/app');
const { OrderStore } = require('./src/orders');
const { createMailer } = require('./src/mailer');
const { createCjClient } = require('./src/suppliers/cj');
const { createAutomation } = require('./src/automation');

const env = process.env;
const stripe = env.STRIPE_SECRET_KEY ? require('stripe')(env.STRIPE_SECRET_KEY) : null;
const port = Number(env.PORT) || 3000;
// Render sets RENDER_EXTERNAL_URL automatically, so BASE_URL is optional there.
// Emails need an absolute link; checkout falls back to the request's host.
const publicUrl = (env.BASE_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const baseUrl = publicUrl || `http://localhost:${port}`;

const store = new OrderStore(path.join(__dirname, 'data', 'orders.json'));
const mailer = createMailer({ baseUrl });
const cj = env.CJ_API_KEY
  ? createCjClient({ apiKey: env.CJ_API_KEY, logisticName: config.cjLogisticName, fromCountryCode: config.cjFromCountry })
  : null;
const automation = createAutomation({ store, mailer, cj, baseUrl });

createApp({ stripe, store, automation, baseUrl: publicUrl || undefined }).listen(port, () => {
  console.log(`Store running on http://localhost:${port}`);
  console.log(`Payments: ${stripe ? 'Stripe Checkout' : 'DEMO MODE (no STRIPE_SECRET_KEY set – orders are auto-approved)'}`);
  if (!env.ADMIN_PASSWORD) console.log('Admin disabled: set ADMIN_PASSWORD to use /admin.html');
  console.log(`Automation: every ${config.automationIntervalMinutes} min · email ${mailer.configured ? 'on' : 'log only (set SMTP_URL)'}`
    + ` · CJ ordering ${cj ? 'on' : 'off (set CJ_API_KEY)'} · owner alerts ${mailer.ownerConfigured ? 'on' : 'off (set OWNER_EMAIL)'}`);
});

const tick = () => automation.run().catch((err) => console.error('Automation run failed:', err));
setTimeout(tick, 5000).unref();
setInterval(tick, config.automationIntervalMinutes * 60_000).unref();
