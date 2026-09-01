import crypto from 'node:crypto';
import { config } from '../config.js';
import { store } from '../store.js';
import { id } from '../lib/util.js';

/**
 * Razorpay adapter.
 *
 * Two modes, one call signature.
 *
 *   mock - resolves locally against the simulator. Default, so the prototype
 *          runs with no keys and no network.
 *   live - issues the real HTTPS request to api.razorpay.com with Basic auth,
 *          using your test-mode key pair. Same paths, same payload shapes, same
 *          response handling.
 *
 * Set RAZORPAY_MODE=live plus RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET and the
 * recovery actions become real test-mode payment links, captures and refunds.
 * Nothing above this layer changes.
 *
 * Every request carries an idempotency key. Recovery actions get retried by
 * schedulers, by operators clicking twice, and by network timeouts that already
 * succeeded server-side. Without the key, "retry the payment" eventually means
 * "charge the customer twice", which is a worse outcome than the failure the
 * system was trying to fix.
 */

const BASE = 'https://api.razorpay.com/v1';

function authHeader() {
  const token = Buffer.from(`${config.razorpayKeyId}:${config.razorpayKeySecret}`).toString('base64');
  return `Basic ${token}`;
}

async function callLive(method, path, body, idempotencyKey) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: authHeader(),
      'x-razorpay-idempotency-key': idempotencyKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.description || `Razorpay ${res.status}`);
    err.code = data?.error?.code || 'API_ERROR';
    err.status = res.status;
    err.retryable = res.status >= 500 || res.status === 429;
    throw err;
  }
  return data;
}

/* ------------------------------------------------------------------ mock ---- */

const mockLedger = new Map();

function mockPaymentLink({ amount, customer, description, reference_id }) {
  const linkId = id('plink');
  const row = {
    id: linkId,
    short_url: `https://rzp.io/i/${linkId.slice(6)}`,
    amount,
    currency: 'INR',
    status: 'created',
    reference_id,
    description,
    customer,
    created_at: Math.floor(Date.now() / 1000),
  };
  mockLedger.set(linkId, row);
  return row;
}

function mockCapture(paymentId, amount) {
  const p = store.paymentsById.get(paymentId);
  return {
    id: paymentId,
    entity: 'payment',
    amount,
    currency: 'INR',
    status: 'captured',
    method: p?.method || 'card',
    captured: true,
    created_at: Math.floor(Date.now() / 1000),
  };
}

function mockRefund(paymentId, amount) {
  const refundId = id('rfnd');
  return {
    id: refundId,
    entity: 'refund',
    amount,
    currency: 'INR',
    payment_id: paymentId,
    status: 'processed',
    speed_processed: 'normal',
  };
}

function mockSubscriptionRetry(subscriptionId) {
  return { id: subscriptionId, entity: 'subscription', status: 'active', retried: true };
}

/* ----------------------------------------------------------------- public --- */

export const razorpay = {
  mode: () => config.razorpayMode,

  async createPaymentLink({ amount, customerName, customerEmail, description, referenceId, idempotencyKey }) {
    const body = {
      amount,
      currency: 'INR',
      accept_partial: false,
      description,
      reference_id: referenceId,
      customer: { name: customerName, email: customerEmail || 'demo@example.com' },
      notify: { sms: true, email: true },
      reminder_enable: true,
      notes: { source: 'revenue-watchdog', reference: referenceId },
    };
    if (config.razorpayMode === 'live') return callLive('POST', '/payment_links', body, idempotencyKey);
    return mockPaymentLink(body);
  },

  async capturePayment({ paymentId, amount, idempotencyKey }) {
    if (config.razorpayMode === 'live') {
      return callLive('POST', `/payments/${paymentId}/capture`, { amount, currency: 'INR' }, idempotencyKey);
    }
    return mockCapture(paymentId, amount);
  },

  async refundPayment({ paymentId, amount, idempotencyKey }) {
    if (config.razorpayMode === 'live') {
      return callLive('POST', `/payments/${paymentId}/refund`, { amount, speed: 'normal' }, idempotencyKey);
    }
    return mockRefund(paymentId, amount);
  },

  async retrySubscriptionCharge({ subscriptionId, idempotencyKey }) {
    if (config.razorpayMode === 'live') {
      // Razorpay resumes a halted subscription; the next charge is attempted on
      // the mandate. Retry semantics for e-mandates are constrained by NPCI and
      // RBI rules, which is why the schedule comes from the policy engine and
      // not from the model.
      return callLive('POST', `/subscriptions/${subscriptionId}/resume`, { resume_at: 'now' }, idempotencyKey);
    }
    return mockSubscriptionRetry(subscriptionId);
  },

  async createOrder({ amount, currency = 'INR', receipt, notes }) {
    if (config.razorpayMode === 'live') {
      return callLive('POST', '/orders', { amount, currency, receipt, notes }, `order_${receipt}`);
    }
    // Mock order for simulated checkout
    const orderId = `order_mock_${id('ord').slice(4)}`;
    return { id: orderId, amount, currency, receipt, status: 'created', created_at: Math.floor(Date.now() / 1000) };
  },

  async fetchPaymentLinks({ count = 50 } = {}) {
    // Used to reconcile pending recovery links without relying on webhooks.
    // In live mode this pulls the account's recent payment links from Razorpay;
    // each carries its own status ('created' | 'paid' | 'expired' | 'cancelled')
    // and amount_paid, which is exactly what closes the loop pull-side.
    if (config.razorpayMode === 'live') {
      return callLive('GET', `/payment_links?count=${count}`, null, id('idem'));
    }
    // Mock: reflect the links the mock gateway has issued.
    const items = [...mockLedger.values()].slice(-count);
    return { payment_links: items };
  },

  async fetchPaymentLink(linkId) {
    if (config.razorpayMode === 'live') return callLive('GET', `/payment_links/${linkId}`, null, id('idem'));
    return mockLedger.get(linkId) || null;
  },

  async fetchRecentPayments({ count = 100, maxPages = 20 } = {}) {
    if (config.razorpayMode === 'live') {
      // Razorpay caps `count` at 100 per page and returns the most recent
      // payments first. A single page therefore misses everything older than
      // the last 100 payments, which is why failures made over several days in
      // test mode never all showed up. Page backwards with `skip` until Razorpay
      // returns a short page (fewer than `count`), meaning we've reached the end,
      // or until we hit maxPages as a safety stop. Everything is merged into one
      // collection with the same shape the caller already expects.
      const perPage = Math.min(count, 100);
      const all = [];
      for (let page = 0; page < maxPages; page += 1) {
        const skip = page * perPage;
        const res = await callLive(
          'GET',
          `/payments?count=${perPage}&skip=${skip}`,
          null,
          id('idem')
        );
        const items = res.items || [];
        all.push(...items);
        if (items.length < perPage) break; // last page reached
      }
      return { entity: 'collection', count: all.length, items: all };
    }
    // Mock: return real payments already in the store (all of them, most recent
    // last), matching the live path which now returns full history too.
    const real = store.realPayments().slice(-count * maxPages).map((p) => ({
      id: p.id, amount: p.amount, currency: p.currency, status: p.status,
      method: p.method, vpa: p.issuer, error_code: p.errorCode,
      created_at: Math.floor(new Date(p.createdAt).getTime() / 1000),
    }));
    return { entity: 'collection', count: real.length, items: real };
  },

  async fetchPayment(paymentId) {
    if (config.razorpayMode === 'live') return callLive('GET', `/payments/${paymentId}`, null, id('idem'));
    const p = store.paymentsById.get(paymentId);
    if (!p) throw Object.assign(new Error('payment not found'), { code: 'NOT_FOUND' });
    return {
      id: p.id,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      method: p.method,
      error_code: p.errorCode,
      created_at: Math.floor(new Date(p.createdAt).getTime() / 1000),
    };
  },
};

/** Razorpay signs webhooks with HMAC-SHA256 over the raw body. */
export function verifyWebhookSignature(rawBody, signature, secret = config.razorpayWebhookSecret) {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature || '', 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function signPayload(rawBody, secret = config.razorpayWebhookSecret) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}