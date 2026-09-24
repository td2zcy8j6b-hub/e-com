# Nova & Nest – dropshipping store

A complete, self-hosted dropshipping storefront selling two trending products:

| Product | Variants | Price | Supplier cost* | Margin |
|---|---|---|---|---|
| **AuroraSky Galaxy Projector** | Astronaut, Classic Dome | $34.99 / $29.99 | $11.50 | ~62–67% |
| **BlendGo Portable Blender** | Sage, Blush, Midnight | $29.99 | $8.70 | ~71% |

\*Placeholder supplier SKUs and costs. Replace them in `src/products.js` with the real ones from your supplier (CJdropshipping, Zendrop, AliExpress, etc.).

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
3. In Stripe → Developers → Webhooks, add the endpoint `https://yourstore.com/api/webhooks/stripe` with the events `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
   For local testing: `stripe listen --forward-to localhost:3000/api/webhooks/stripe`
4. Set a strong `ADMIN_PASSWORD`.
5. Fill in your business details in `public/policies.html` and set `SUPPORT_EMAIL`.

## Daily fulfilment workflow

1. Open `/admin.html`. The default view lists the orders that need action.
2. For each **paid** order, place the same items with your supplier using the SKU shown, shipping to the customer's address. Enter the supplier order number and click Save. The status becomes *ordered from supplier*.
3. When the supplier sends tracking, enter the carrier and tracking number and click Save. The status becomes *shipped*, and the customer can see the tracking on `/track.html`.

## Deploying

This is a single Node process (Node 20+) with no build step. It runs on Render, Railway, Fly.io or any VPS. Orders are stored in `data/orders.json`, so give the host a **persistent disk** mounted at `data/`, or move the store in `src/orders.js` to a database once order volume grows.

## Project layout

```
server.js            entry point (wires in Stripe when a key is set)
src/app.js           Express routes: products, quote, checkout, orders, admin, webhook
src/products.js      catalog: products, variants, bundles and supplier info
src/pricing.js       cart pricing: bundle discounts and shipping
src/orders.js        JSON-file order store with atomic, serialised writes
src/config.js        store name, shipping rates, delivery times
public/              storefront pages, CSS, client JS and product images
test/                node:test suites (pricing and API, with a fake Stripe client)
```

## Customising

- **Products and prices**: `src/products.js`. Change the name, copy, variants, `compareAtPrice`, bundle tiers and supplier info. Replace the SVG illustrations in `public/img/` with real product photos from your supplier.
- **Shipping rates and delivery times**: `src/config.js`
- **Branding**: set `STORE_NAME`. Colours are the CSS variables at the top of `public/styles.css`.
