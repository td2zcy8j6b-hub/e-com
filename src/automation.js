// Runs the store's back office on its own. Each run:
//   1. cancels checkouts that were never paid,
//   2. places paid orders with CJdropshipping (created unpaid; you pay in CJ),
//   3. polls CJ for tracking and marks orders shipped,
//   4. emails customers (confirmation, shipped, refunded, cancelled),
//   5. emails the owner a daily summary.
// Every step is idempotent, so running it often (or twice) is safe.
const fs = require('fs/promises');
const path = require('path');
const defaultConfig = require('./config');
const { products, findVariant, supplierCostOf } = require('./products');
const { statusPatch } = require('./orders');
const { ownerAlert, ownerDigest } = require('./emails');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Only events this recent trigger customer emails, so turning automation on
// never mass-emails customers about old orders.
const EMAIL_WINDOW = 3 * DAY;
const POLL_EVERY = 30 * MINUTE;

const isoAgo = (now, ms) => new Date(now.getTime() - ms).toISOString();
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Wait 10m, 20m, 40m… (capped at 6h) between failed supplier attempts.
const backoff = (attempts) => Math.min(10 * MINUTE * 2 ** Math.max(0, attempts - 1), 6 * HOUR);

// Which customer email is due for this order, given its state. Returns kinds in send order.
function dueEmails(o, now) {
  const sent = o.emails || {};
  const recent = (ts) => ts && ts >= isoAgo(now, EMAIL_WINDOW);
  const due = [];
  if (['paid', 'ordered_from_supplier', 'shipped'].includes(o.status) && !sent.confirmation && recent(o.paidAt)) due.push('confirmation');
  if (o.status === 'shipped' && !sent.shipped && recent(o.shippedAt)) due.push('shipped');
  if (o.status === 'refunded' && o.paidAt && !sent.refunded && recent(o.refundedAt)) due.push('refunded');
  // Abandoned checkouts are cancelled silently; only paid orders get a cancellation email.
  if (o.status === 'cancelled' && o.paidAt && !sent.cancelled && recent(o.cancelledAt)) due.push('cancelled');
  return due;
}

function createAutomation({ store, mailer, cj = null, config = defaultConfig, stateFile, baseUrl, now = () => new Date(), log = console }) {
  stateFile = stateFile || path.join(path.dirname(store.file), 'automation.json');
  let running = null;
  let kickTimer = null;
  let lastRun = null;

  async function readState() {
    try { return JSON.parse(await fs.readFile(stateFile, 'utf8')); } catch { return {}; }
  }
  async function writeState(state) {
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.rename(tmp, stateFile);
  }

  // Sends an owner alert for this order at most once per key.
  async function alertOnce(order, key, subject, body, summary) {
    if (order.alerts && order.alerts[key]) return;
    const link = baseUrl ? `\n\nOpen the admin: ${baseUrl}/admin.html` : '';
    try {
      await mailer.sendOwner(ownerAlert(subject, body + link));
      await store.update(order.id, (o) => ({ alerts: { ...(o.alerts || {}), [key]: now().toISOString() } }));
      summary.alerts += 1;
    } catch (err) {
      summary.errors.push(`Alert for ${order.id} failed: ${err.message}`);
    }
  }

  async function expireUnpaid(orders, summary) {
    const cutoff = isoAgo(now(), config.pendingPaymentTtlHours * HOUR);
    for (const o of orders.filter((x) => x.status === 'pending_payment' && x.createdAt < cutoff)) {
      const updated = await store.update(o.id, (cur) =>
        cur.status === 'pending_payment' ? { ...statusPatch('cancelled', now()), cancelReason: 'payment_not_completed' } : {});
      if (updated && updated.status === 'cancelled') summary.expired.push(o.id);
    }
  }

  async function submitToSupplier(orders, summary) {
    const t = now();
    const due = orders.filter((o) => o.status === 'paid' && !o.supplierOrderId && !(o.fulfilment && o.fulfilment.gaveUp));
    for (const o of due) {
      const f = o.fulfilment || {};
      const needsSetup = (reason) => store.update(o.id, (cur) => ({ fulfilment: { ...(cur.fulfilment || {}), provider: 'manual', lastError: reason } }))
        .then((cur) => alertOnce(cur, 'needs_manual', `Place order ${o.id} by hand`,
          `Order ${o.id} is paid but can't be sent to CJdropshipping automatically: ${reason}\n\nPlace it with your supplier, then enter the supplier order number in the admin.`, summary))
        .then(() => summary.manual.push(o.id));

      if (!cj) { await needsSetup('CJ_API_KEY is not set.'); continue; }
      const lines = o.lines.map((l) => {
        const found = findVariant(l.variantId);
        return { ...l, cjVariantId: found && found.variant.cjVariantId };
      });
      const missing = lines.filter((l) => !l.cjVariantId);
      if (missing.length) {
        await needsSetup(`No cjVariantId in src/products.js for ${missing.map((l) => l.variantId).join(', ')}.`);
        continue;
      }
      if (f.lastAttemptAt && Date.parse(f.lastAttemptAt) + backoff(f.attempts || 0) > t.getTime()) continue;

      const attempts = (f.attempts || 0) + 1;
      await store.update(o.id, (cur) => ({ fulfilment: { ...(cur.fulfilment || {}), provider: 'cj', attempts, lastAttemptAt: t.toISOString() } }));
      try {
        const res = await cj.createOrder(o, lines);
        await store.update(o.id, (cur) => ({
          ...(cur.status === 'paid' && !cur.supplierOrderId ? { status: 'ordered_from_supplier', supplierOrderId: res.cjOrderId } : {}),
          fulfilment: { ...(cur.fulfilment || {}), provider: 'cj', cjOrderId: res.cjOrderId, cjStatus: res.cjStatus, submittedAt: now().toISOString(), lastError: null },
        }));
        summary.submitted.push(o.id);
      } catch (err) {
        const gaveUp = attempts >= config.maxSupplierAttempts || err.retryable === false;
        const cur = await store.update(o.id, (c) => ({ fulfilment: { ...(c.fulfilment || {}), lastError: err.message, gaveUp } }));
        summary.failed.push(o.id);
        log.error(`CJ order for ${o.id} failed (attempt ${attempts}): ${err.message}`);
        if (gaveUp) {
          await alertOnce(cur, 'supplier_gave_up', `Order ${o.id} could not be placed with CJ`,
            `CJdropshipping rejected order ${o.id} after ${attempts} attempt(s).\n\nLast error: ${err.message}\n\nFix the problem and click "Retry CJ order" in the admin, or place it by hand.`, summary);
        } else {
          await alertOnce(cur, 'supplier_failed', `Problem placing order ${o.id} with CJ (retrying)`,
            `Order ${o.id} failed to reach CJdropshipping: ${err.message}\n\nIt will be retried automatically, up to ${config.maxSupplierAttempts} attempts.`, summary);
        }
      }
    }
  }

  async function pollSupplier(orders, summary) {
    if (!cj) return;
    const t = now();
    const due = orders.filter((o) => o.status === 'ordered_from_supplier' && o.fulfilment && o.fulfilment.cjOrderId
      && !(o.fulfilment.lastPolledAt && Date.parse(o.fulfilment.lastPolledAt) + POLL_EVERY > t.getTime()));
    for (const o of due) {
      let res;
      try {
        res = await cj.getOrder(o.fulfilment.cjOrderId);
      } catch (err) {
        await store.update(o.id, (cur) => ({ fulfilment: { ...cur.fulfilment, lastPolledAt: t.toISOString() } }));
        summary.errors.push(`Tracking lookup for ${o.id} failed: ${err.message}`);
        continue;
      }
      const updated = await store.update(o.id, (cur) => {
        const patch = { fulfilment: { ...cur.fulfilment, cjStatus: res.cjStatus, lastPolledAt: t.toISOString() } };
        if (res.trackingNumber && cur.status === 'ordered_from_supplier') {
          Object.assign(patch, statusPatch('shipped', now()), {
            trackingNumber: res.trackingNumber,
            trackingCarrier: res.carrier || '',
            shipments: [{ carrier: res.carrier || '', trackingNumber: res.trackingNumber }],
          });
        }
        return patch;
      });
      if (updated.status === 'shipped' && o.status !== 'shipped') summary.shipped.push(o.id);
      if (res.cjStatus === 'cancelled') {
        await alertOnce(updated, 'supplier_cancelled', `CJ cancelled order ${o.id}`,
          `CJdropshipping cancelled its order ${o.fulfilment.cjOrderId} for your order ${o.id}. Re-place it or refund the customer in Stripe.`, summary);
      }
    }
  }

  async function sendCustomerEmails(orders, summary) {
    for (const o of orders) {
      for (const kind of dueEmails(o, now())) {
        try {
          const res = await mailer.sendCustomer(o, kind);
          await store.update(o.id, (cur) => ({ emails: { ...(cur.emails || {}), [kind]: { at: now().toISOString(), delivered: Boolean(res && res.sent) } } }));
          summary.emails.push(`${kind}:${o.id}`);
        } catch (err) {
          summary.errors.push(`Email ${kind} for ${o.id} failed: ${err.message}`);
          break; // keep emails in order; retry next run
        }
      }
    }
  }

  async function sendDigest(orders, summary) {
    const t = now();
    if (!mailer.ownerConfigured || t.getHours() < config.digestHour) return;
    const state = await readState();
    const today = localDate(t);
    if (state.lastDigestDate === today) return;
    const since = isoAgo(t, DAY);
    const recent = orders.filter((o) => o.paidAt && o.paidAt >= since && !['cancelled', 'refunded', 'pending_payment'].includes(o.status));
    const stuckCutoff = isoAgo(t, config.stuckWithoutTrackingDays * DAY);
    const digest = {
      date: today,
      orders: recent.length,
      revenue: recent.reduce((s, o) => s + o.total, 0),
      profit: recent.reduce((s, o) => s + (o.total - o.shipping - supplierCostOf(o.lines)), 0),
      awaitingPayment: orders.filter((o) => o.status === 'ordered_from_supplier' && o.fulfilment && o.fulfilment.cjStatus === 'awaiting_payment'),
      stuck: orders.filter((o) => o.status === 'ordered_from_supplier' && (o.fulfilment?.submittedAt || o.paidAt || o.createdAt) < stuckCutoff),
      failed: orders.filter((o) => o.status === 'paid' && o.fulfilment && o.fulfilment.lastError),
    };
    await mailer.sendOwner(ownerDigest(digest));
    await writeState({ ...state, lastDigestDate: today });
    summary.digest = true;
  }

  async function runOnce() {
    const summary = { startedAt: now().toISOString(), expired: [], submitted: [], failed: [], manual: [], shipped: [], emails: [], alerts: 0, digest: false, errors: [] };
    const steps = [
      ['expire', expireUnpaid], ['submit', submitToSupplier], ['poll', pollSupplier],
      ['emails', sendCustomerEmails], ['digest', sendDigest],
    ];
    // Each step re-reads orders so it sees what the previous step changed.
    for (const [name, step] of steps) {
      try {
        await step(await store.readAll(), summary);
      } catch (err) {
        summary.errors.push(`${name}: ${err.message}`);
        log.error(`Automation step ${name} failed:`, err);
      }
    }
    summary.finishedAt = now().toISOString();
    lastRun = summary;
    return summary;
  }

  const automation = {
    // Concurrent callers share the in-flight run instead of starting a second one.
    run() {
      if (!running) running = runOnce().finally(() => { running = null; });
      return running;
    },
    // Run soon (debounced), e.g. right after an order is paid.
    kick(delayMs = 2000) {
      if (kickTimer) return;
      kickTimer = setTimeout(() => {
        kickTimer = null;
        automation.run().catch((err) => log.error('Automation run failed:', err));
      }, delayMs);
      if (kickTimer.unref) kickTimer.unref();
    },
    status() {
      return {
        email: mailer.configured,
        ownerEmail: mailer.ownerConfigured,
        cj: Boolean(cj),
        missingCjVariants: listMissingCjVariants(),
        intervalMinutes: config.automationIntervalMinutes,
        lastRun,
      };
    },
  };
  return automation;
}

function listMissingCjVariants() {
  return products.flatMap((p) => p.variants.filter((v) => !v.cjVariantId).map((v) => `${p.name} – ${v.name}`));
}

module.exports = { createAutomation, dueEmails, backoff };
