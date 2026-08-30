import { store } from './store.js';
import { config, INSTRUMENTS } from './config.js';
import { rng, weightedPick, pick, gaussian, id } from './lib/util.js';
import { razorpay } from './razorpay/client.js';

/**
 * Live simulator.
 *
 * The static seed gives the system a past. This gives it a present: payments
 * keep arriving while the console is open, and a person can reach in and break
 * a bank on purpose.
 *
 * That second part is what makes the product legible. Detection is invisible
 * until you have watched something get detected. So the control room lets
 * someone flip a switch, watch normal traffic keep flowing, and then watch the
 * watchdog work out on its own that HDFC has gone bad and that it is the bank's
 * fault rather than the merchant's.
 */

const rand = rng(776655);
let timer = null;

export const scenario = {
  running: false,
  tickMs: 500,
  minutesPerTick: 2,
  ticks: 0,
  generated: 0,
  switches: {
    // A bank degrading for everyone. The correct read is "upstream".
    hdfc_netbanking_outage: { on: false, label: 'HDFC Netbanking degraded (all merchants)', issuer: 'HDFC Netbanking', rate: 0.61, scope: 'network' },
    // This merchant's own checkout misconfigured. The correct read is "local".
    our_upi_broken: { on: false, label: 'Our Google Pay checkout misconfigured (us only)', issuer: 'UPI / Google Pay', rate: 0.74, scope: 'merchant' },
    // A quiet one: money captured, merchant never told.
    webhook_endpoint_down: { on: false, label: 'Our order server is refusing webhooks', issuer: null, rate: null, scope: 'merchant' },
  },
};

export const PRODUCTS = [
  { id: 'p1', name: 'Malabar cotton bedsheet', detail: 'King, 300 thread count, indigo block print', price: 219000 },
  { id: 'p2', name: 'Kutch mirrorwork cushion cover', detail: 'Set of two, 45cm', price: 84000 },
  { id: 'p3', name: 'Handloom cotton throw', detail: 'Natural dye, 130 x 170cm', price: 156000 },
  { id: 'p4', name: 'Waffle weave bath towel', detail: 'Set of four, quick dry', price: 98000 },
  { id: 'p5', name: 'Kantha quilted bedcover', detail: 'Queen, reversible, hand stitched', price: 412000 },
  { id: 'p6', name: 'Linen table runner', detail: '180cm, stonewashed', price: 62000 },
];

/** Success rate for one attempt, after any scenario switch is applied. */
function rateFor(merchantId, issuer) {
  const merchant = store.merchants.find((m) => m.id === merchantId);
  let rate = merchant?.baselines[issuer]?.rate ?? 0.93;

  for (const sw of Object.values(scenario.switches)) {
    if (!sw.on || !sw.issuer || sw.issuer !== issuer) continue;
    if (sw.scope === 'merchant' && merchantId !== config.focusMerchantId) continue;
    rate = sw.rate;
  }
  return rate;
}

const SOFT = ['GATEWAY_ERROR', 'NETWORK_ERROR', 'ISSUER_DECLINED_TEMP', 'PAYMENT_TIMEOUT'];
const TIMING = ['INSUFFICIENT_FUNDS', 'LIMIT_EXCEEDED', 'USER_DROPPED'];
const HARD = ['CARD_EXPIRED', 'CARD_BLOCKED', 'INVALID_VPA'];

function makePayment({ merchantId, issuer, method, amount, at, customerId, source }) {
  const rate = rateFor(merchantId, issuer);
  const ok = rand() < rate;
  const degraded = rate < (store.merchants.find((m) => m.id === merchantId)?.baselines[issuer]?.rate ?? 1) - 0.02;

  let errorCode = null;
  if (!ok) {
    const r = rand();
    if (degraded) errorCode = r < 0.8 ? pick(rand, SOFT) : pick(rand, TIMING);
    else if (r < 0.42) errorCode = pick(rand, SOFT);
    else if (r < 0.78) errorCode = pick(rand, TIMING);
    else errorCode = pick(rand, HARD);
  }

  const p = {
    id: id('pay'),
    merchantId,
    customerId,
    amount,
    currency: 'INR',
    method,
    issuer,
    status: ok ? 'captured' : 'failed',
    errorCode,
    createdAt: at,
    orderId: null,
    subscriptionId: null,
    attemptNo: 1,
    degradedAtSource: degraded,
    source: source || 'live',
  };

  // The webhook switch models the merchant's own order server refusing
  // deliveries: the money is captured, but no order is ever created.
  const webhookDown = scenario.switches.webhook_endpoint_down.on && merchantId === config.focusMerchantId;
  if (ok && webhookDown) {
    p.webhookDelivery = { attempts: 5, acknowledged: false, lastError: 'HTTP 502 from merchant endpoint' };
  } else if (ok) {
    const oid = id('order');
    p.orderId = oid;
    store.orders.set(oid, { id: oid, merchantId, paymentId: p.id, createdAt: at, status: 'fulfilled' });
  }

  store.addPayment(p);
  scenario.generated++;
  return p;
}

function tick() {
  // The clock advances slowly while volume stays dense.
  //
  // The first version of this followed the same time-of-day curve as the seeded
  // history, which meant that after a minute of demo the simulated clock had run
  // into the small hours, traffic collapsed to almost nothing, and a real outage
  // could not accumulate enough attempts to be called significant. Correct
  // behaviour from the detector, useless as a demo. So live traffic runs at a
  // steady evening-ish rate: a person watching should get a detectable sample
  // inside a minute.
  const clock = new Date(store.meta.clock).getTime() + scenario.minutesPerTick * 60000;
  store.meta.clock = new Date(clock).toISOString();

  for (const m of store.merchants) {
    const count = Math.max(1, Math.round(m.dailyVolume / 140 + gaussian(rand, 0, 1)));
    const custs = [...store.customers.values()].filter((c) => c.merchantId === m.id);
    for (let i = 0; i < count; i++) {
      const inst = weightedPick(rand, INSTRUMENTS);
      makePayment({
        merchantId: m.id,
        issuer: inst.issuer,
        method: inst.method,
        amount: Math.max(4900, Math.round(Math.exp(gaussian(rand, Math.log(69000), 0.42)) / 100) * 100),
        at: new Date(clock - Math.floor(rand() * scenario.minutesPerTick * 60000)).toISOString(),
        customerId: pick(rand, custs).id,
      });
    }
  }

  scenario.ticks++;
  // Keep memory bounded during a long demo. Detection only ever looks back 24h.
  if (store.payments.length > 60000) {
    const cutoff = clock - 30 * 36e5;
    store.payments = store.payments.filter((p) => new Date(p.createdAt).getTime() >= cutoff);
    store.paymentsById = new Map(store.payments.map((p) => [p.id, p]));
  }
}

export function startLive() {
  if (timer) return scenario;
  scenario.running = true;
  timer = setInterval(tick, scenario.tickMs);
  return scenario;
}

export function stopLive() {
  clearInterval(timer);
  timer = null;
  scenario.running = false;
  return scenario;
}

export function setSwitch(key, on) {
  if (!scenario.switches[key]) return { error: 'unknown switch' };
  scenario.switches[key].on = !!on;
  store.record({
    type: 'scenario_changed',
    note: `${scenario.switches[key].label} turned ${on ? 'on' : 'off'}`,
  });
  return scenario;
}

/**
 * Create a Razorpay order to back a real checkout.
 *
 * In mock mode this falls through to the simulated path. In live mode a real
 * order is created at Razorpay and the id is returned to the frontend so
 * Checkout.js can open the native payment modal.
 */
export async function createOrder({ productId, customerName, customerEmail, customerContact }) {
  const product = PRODUCTS.find((p) => p.id === productId);
  if (!product) return { error: 'unknown product' };

  if (config.razorpayMode !== 'live') {
    // Mock: return a fake order id so the storefront can show a sensible error
    // rather than trying to open a live modal with a fake key.
    return { orderId: `order_mock_${Date.now()}`, amount: product.price, currency: 'INR', product: product.name, mock: true };
  }

  const order = await razorpay.createOrder({
    amount: product.price,
    currency: 'INR',
    receipt: `rcpt_${Date.now()}`,
    notes: {
      product: product.name,
      source: 'leaf-and-loom-storefront',
    },
  });

  return {
    orderId: order.id,
    amount: product.price,
    currency: 'INR',
    keyId: config.razorpayKeyId,
    product: product.name,
    customerName: customerName || '',
    customerEmail: customerEmail || '',
    customerContact: customerContact || '',
    mock: false,
  };
}

/**
 * Simulated checkout for mock mode.
 *
 * Stays intact so the control room and demos work without real keys.
 */
export function checkout({ productId, method, issuer, customerName }) {
  const product = PRODUCTS.find((p) => p.id === productId);
  if (!product) return { error: 'unknown product' };

  // A walk-in customer with no history, which is itself a signal the recovery
  // model uses: no prior successes means lower odds of recovery.
  const customerId = `cust_walkin_${id('x').slice(2, 8)}`;
  store.customers.set(customerId, {
    id: customerId,
    name: customerName || 'Guest shopper',
    merchantId: config.focusMerchantId,
    priorSuccesses: 0,
    priorFailures: 0,
    priorSuccessRate: 0.5,
    successWindow: [10, 14],
    contactsLast30d: 0,
  });

  const p = makePayment({
    merchantId: config.focusMerchantId,
    issuer,
    method,
    amount: product.price,
    at: store.meta.clock,
    customerId,
    source: 'storefront',
  });

  return {
    paymentId: p.id,
    status: p.status,
    errorCode: p.errorCode,
    amount: p.amount,
    product: product.name,
    issuer,
    orderCreated: !!p.orderId,
    orphaned: p.status === 'captured' && !p.orderId,
    customerName: customerName || 'Guest shopper',
  };
}

export function liveStatus() {
  const clock = new Date(store.meta.clock).getTime();
  const lastHour = store.payments.filter((p) => new Date(p.createdAt).getTime() >= clock - 36e5);
  const focus = lastHour.filter((p) => p.merchantId === config.focusMerchantId);
  return {
    running: scenario.running,
    ticks: scenario.ticks,
    generated: scenario.generated,
    clock: store.meta.clock,
    totalEvents: store.payments.length,
    lastHour: {
      attempts: focus.length,
      successRate: focus.length ? focus.filter((p) => p.status === 'captured').length / focus.length : null,
    },
    switches: Object.entries(scenario.switches).map(([key, s]) => ({ key, label: s.label, on: s.on, scope: s.scope })),
  };
}
