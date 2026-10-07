# Nova & Nest – dropshipping store

A complete, self-hosted dropshipping storefront selling two trending products:

| Product | Variants | Price | Supplier cost* | Margin |
|---|---|---|---|---|
| **AuroraSky Galaxy Projector** | Astronaut, Classic Dome | $34.99 / $29.99 | $11.50 | ~62–67% |
| **BlendGo Portable Blender** | Sage, Blush, Midnight | $29.99 | $8.70 | ~71% |

\*Placeholder supplier SKUs and costs. Both products are fulfilled through CJdropshipping. Replace the placeholders in `src/products.js` with your real CJ products, costs and variant ids.

## Features

**Storefront**
- Home page, product pages with style variants, reviews and "Buy 2 save 10% / Buy 3 save 15%" bundles
- Cart with live, server-side pricing and a free-shipping progress bar (free over $49, otherwise $4.99)
- Checkout collecting the shipping address, paid through **Stripe Checkout**
- Order confirmation page and a **Track your order** page (order number + email)
- Shipping, returns, privacy and terms policies (`/policies.html`), which payment processors and ad platforms require
- Works on phones, and works in private browsing

**Fulfilment admin** (`/admin.html`, password protected)
- Every order shows the customer's shipping address, plus the supplier name, supplier SKU and unit cost for each item, so you can place the order with your supplier
- Revenue and gross-profit stats
- Record the supplier order number and the carrier and tracking number. The customer then sees them on the tracking page.
- Export orders to CSV (for bulk-ordering from a supplier)

**Automation** (see [Automation](#automation))
- Paid orders are placed with CJdropshipping through its API, ready for you to pay
- Tracking numbers come back from CJ on their own, and the order is marked shipped
- Customers get emails when their order is confirmed, shipped, refunded or cancelled
- Refunds made in Stripe, abandoned checkouts and failed payments update the order
- You get an alert when something needs you, and a daily summary email

**Safety**
- Prices are computed only on the server, so a shopper can't change what they pay
- Stripe webhooks are signature-verified. Payment is also confirmed when the shopper returns from Stripe, so orders still get marked paid if a webhook is late.
- Order lookup requires both the order number and the email. Supplier costs are never sent to shoppers.

## Run it

```bash
npm install
cp .env.example .env        # then edit it
node --env-file=.env server.js
# open http://localhost:3000
```

With no `STRIPE_SECRET_KEY` the store runs in **demo mode**: checkout accepts orders without charging a card, and every page shows a banner saying so. Use it to try the whole flow end to end.

Run the tests with `npm test`.

## Go live with Stripe

1. Create a Stripe account and copy your secret key into `STRIPE_SECRET_KEY`.
2. Set `BASE_URL` to your public URL (for example `https://yourstore.com`).
3. In Stripe → Developers → Webhooks, add the endpoint `https://yourstore.com/api/webhooks/stripe` with these events. Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
   - `checkout.session.completed` and `checkout.session.async_payment_succeeded` mark orders paid.
   - `checkout.session.expired` and `checkout.session.async_payment_failed` cancel unpaid orders.
   - `charge.refunded` marks an order refunded and emails the customer.
   For local testing: `stripe listen --forward-to localhost:3000/api/webhooks/stripe`
4. Set a strong `ADMIN_PASSWORD`.
5. Fill in your business details in `public/policies.html` and set `SUPPORT_EMAIL`.

## Automation

Once it is set up, an order runs like this with no admin work:

1. The shopper pays. They get an order confirmation email straight away.
2. The store creates the matching order at CJdropshipping, shipping to the customer. It is created **unpaid**.
3. **You pay it in CJ** (My CJ → Orders → Awaiting payment). This is the one manual step, so nothing is spent without you. The daily summary lists every CJ order waiting for payment.
4. CJ ships it. The store picks up the tracking number, marks the order shipped and emails the customer the tracking link.
5. If you refund the payment in Stripe, the order is marked refunded and the customer is told.

Automation runs inside the server every 10 minutes, and right after each payment. Each step is safe to repeat, so nothing is ordered or emailed twice.

### Set it up

| What | Where | Without it |
|---|---|---|
| `CJ_API_KEY` | CJ → My CJ → Authorization → API | Orders aren't sent to CJ. You get an email for each order to place by hand. |
| CJ variant ids | `cjVariantId` on each variant in `src/products.js`. It is CJ's "vid", shown on the product in My CJ → Products. | That variant's orders are left for you, with an alert. |
| `SMTP_URL` and `EMAIL_FROM` | Your email provider's SMTP settings. Gmail needs an app password. | Emails are only written to the server log. |
| `OWNER_EMAIL` | Your own address | No alerts or daily summary. |
| `STORE_URL` and `STORE_ADMIN_PASSWORD` | GitHub repository → Settings → Secrets and variables → Actions | The server still runs automation itself, but not while Render's free plan has it asleep. |
| Stripe webhook events | See [Go live with Stripe](#go-live-with-stripe) | Refunds and abandoned checkouts aren't picked up. |

`CJ_LOGISTIC_NAME` picks CJ's shipping method. The default is `CJPacket Ordinary`. `DIGEST_HOUR` sets when the daily summary is sent, in server time.

The admin page shows what is set up, with a **Run automation now** button. Each order shows its CJ status, any error, and which emails went out. If CJ rejects an order 5 times, automation stops trying and emails you. Fix the cause, then click **Retry CJ order**.

Turning automation on never emails customers about old orders. Only events from the last 3 days send email.

The CJ field names in `src/suppliers/cj.js` follow CJ's API 2.0 documentation. Place one test order and check it appears in CJ before relying on it.

### Doing it by hand

You can still fulfil any order yourself in `/admin.html`. Enter the supplier order number and the order is no longer sent to CJ. Enter a tracking number and the customer gets the shipped email.

## Put it online (Render)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/td2zcy8j6b-hub/e-com)

1. Click the button above. Sign up for Render with your GitHub account and allow it to access the `e-com` repository.
2. Render reads `render.yaml` and shows one web service on the **free plan**. Click **Apply**. Render may still ask for a card to verify your account, but the free plan isn't charged.
3. Wait a few minutes for the first deploy. Your store is then live at `https://nova-and-nest.onrender.com` (or a similar address shown in the dashboard).
4. Open the service's **Environment** tab to:
   - see the generated `ADMIN_PASSWORD` for `/admin.html`,
   - set `SUPPORT_EMAIL` to your real address,
   - add `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` when you're ready to take real payments (until then it runs in demo mode). Use the store address from step 3 for the Stripe webhook URL: `https://<your-address>/api/webhooks/stripe`.
5. Optional: add your own domain under **Settings → Custom Domains**.

Every push to `main` redeploys automatically.

**The free plan is for previewing only.** It has no persistent disk, so every order, and automation's record of what it already did, is erased whenever the server restarts or redeploys. It also sleeps after 15 minutes without visitors, and the next visitor waits about a minute for it to wake. Before taking real orders, upgrade: in `render.yaml` change `plan: free` to `plan: starter` (about $7/month) and uncomment the `disk:` block, then push to `main`.

Other hosts work too: it's a single Node process (Node 20+) with no build step. Give it a persistent disk mounted at `data/` for `orders.json`.

## Project layout

```
server.js            entry point (wires in Stripe when a key is set)
src/app.js           Express routes: products, quote, checkout, orders, admin, webhook
src/automation.js    scheduled back office: CJ orders, tracking, emails, daily summary
src/suppliers/cj.js  CJdropshipping API client
src/mailer.js        SMTP sending (log-only when SMTP_URL is unset)
src/emails.js        customer and owner email templates
src/products.js      catalog: products, variants, bundles and supplier info
src/pricing.js       cart pricing: bundle discounts and shipping
src/orders.js        JSON-file order store with atomic, serialised writes
src/config.js        store name, shipping rates, delivery times
public/              storefront pages, CSS, client JS and product images
test/                node:test suites (pricing, API, automation and CJ, with fake Stripe, CJ and mail)
.github/workflows/   store-automation.yml triggers automation every 15 minutes
```

## Customising

- **Products and prices**: `src/products.js`. Change the name, copy, variants, `compareAtPrice`, bundle tiers and supplier info. Replace the SVG illustrations in `public/img/` with real product photos from your supplier.
- **Shipping rates and delivery times**: `src/config.js`
- **Branding**: set `STORE_NAME`. Colours are the CSS variables at the top of `public/styles.css`.
