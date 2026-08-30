/**
 * Central configuration.
 *
 * Everything that a merchant could plausibly want to tune lives in `defaultPolicy`.
 * The policy engine is deterministic and reads only from here (or from a stored
 * override), never from the model. That separation is the whole point: the model
 * proposes, the policy disposes.
 */

export const config = {
  port: Number(process.env.PORT || 4000),

  // "mock" replays a local Razorpay simulator. "live" talks to api.razorpay.com
  // with your test-mode key pair. Same code path, same request shapes.
  razorpayMode: process.env.RAZORPAY_MODE || 'mock',
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || 'whsec_demo_secret',

  /**
   * The agent driver.
   *
   *   gemini        - Google Gemini, free tier. Needs GEMINI_API_KEY.

   *   deterministic - no model at all, fixed decision tree over the same tools.
   *
   * Resolved at call time in agent/loop.js. If a key is missing the driver
   * degrades to deterministic rather than failing, so the app always runs.
   */
  agentDriver: process.env.AGENT_DRIVER || 'auto',

  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || '',
  geminiBase: process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta',

  focusMerchantId: 'acc_LEAFANDLOOM',

  /**
   * Synthetic background traffic.
   *
   * Set SYNTHETIC_TRAFFIC=off to run on real Razorpay payments only. The leak
   * map will be nearly empty and the network-correlation and congestion views
   * will have nothing to show, because both of those need many merchants and
   * you only own one Razorpay account. Default is on: real payments and
   * simulated ones live in the same store, and every surface labels which is
   * which.
   */
  syntheticTraffic: process.env.SYNTHETIC_TRAFFIC !== 'off',

  /**
   * Per-merchant guaranteed slots in the coordinated retry window.
   *
   * 0 is pure expected value, which maximises recovered rupees and serves the
   * smallest merchants worst. Each increment guarantees every merchant that
   * many attempts in the early slots before expected value orders the rest.
   * `fairnessCurve()` in coordinator.js prints what each setting costs, so this
   * number is defensible rather than arbitrary. 2 buys most of the coverage for
   * a small fraction of the recovery.
   */
  fairnessFloor: Number(process.env.FAIRNESS_FLOOR ?? 2),

  /**
   * Public base URL, used to build return URLs for real payment links. Set this
   * to your tunnel hostname when running a tunnel, e.g.
   *   PUBLIC_BASE_URL=https://something.trycloudflare.com
   */
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),

  // Fraction of eligible recovery candidates permanently withheld from the
  // intelligent path and given naive treatment instead. This is how the product
  // measures its own incremental lift. It is not a demo trick; it always runs.
  holdoutFraction: 0.2,

  // Meter retries to a degraded issuer across all merchants instead of letting
  // every merchant stampede it at once. See pipeline/coordinator.js.
  coordinateRetries: process.env.COORDINATE_RETRIES !== 'off',

  simulation: {
    // Anchor for the synthetic event stream. Everything is relative to this.
    days: 30,
    historyRowsForTraining: 2400,
  },

  /**
   * Statistical detection thresholds.
   *
   * These are deliberately strict, and they will NOT fire on the handful of
   * payments you can make by hand in test mode. That is correct behaviour: a
   * detector that alarms on five payments is a bad detector.
   *
   * Real failed payments do not need this path at all. They are surfaced by
   * detectRealFailures() as an observed fact rather than a statistical
   * inference, so a single real failure becomes a recovery candidate
   * immediately. See pipeline/detectors.js.
   */
  detection: {
    hours: 24,
    delta: 0.06,
    minProb: 0.97,
    minSegment: 25,
  },

  /**
   * Success rate assumed for an issuer we have never seen before.
   *
   * Real Razorpay traffic arrives with bank and VPA names that are not in the
   * INSTRUMENTS table below, so there is no measured baseline for them. Rather
   * than silently skipping those issuers, detection falls back to this figure
   * and marks the finding `baselineAssumed: true` so nothing downstream can
   * mistake an assumption for a measurement.
   */
  assumedBaselineRate: Number(process.env.ASSUMED_BASELINE_RATE || 0.92),
};

/**
 * Decline-code taxonomy.
 *
 * Retrying a terminal decline burns a customer contact and a gateway call for a
 * guaranteed failure. Half of "smart retry" is knowing which codes are not worth
 * a second attempt at all.
 *
 * class:
 *   soft      - transient, retry directly
 *   timing    - will succeed later (funds / limits), retry in a chosen window
 *   instrument- the payment instrument itself is dead, needs a new one from the customer
 *   mandate   - the recurring authorisation is gone, needs re-authorisation
 *   terminal  - do not retry, do not contact
 */
export const DECLINE_TAXONOMY = {
  GATEWAY_ERROR: { class: 'soft', retryable: true, label: 'Gateway timeout at the bank' },
  NETWORK_ERROR: { class: 'soft', retryable: true, label: 'Network error in transit' },
  BANK_DOWN: { class: 'soft', retryable: true, label: 'Issuing bank unavailable' },
  ISSUER_DECLINED_TEMP: { class: 'soft', retryable: true, label: 'Issuer declined, no reason given' },
  INSUFFICIENT_FUNDS: { class: 'timing', retryable: true, label: 'Not enough balance' },
  LIMIT_EXCEEDED: { class: 'timing', retryable: true, label: 'Per-transaction limit hit' },
  PAYMENT_TIMEOUT: { class: 'soft', retryable: true, label: 'Customer session timed out' },
  USER_DROPPED: { class: 'timing', retryable: true, label: 'Customer abandoned the page' },
  CARD_EXPIRED: { class: 'instrument', retryable: false, label: 'Card has expired' },
  CARD_BLOCKED: { class: 'instrument', retryable: false, label: 'Card blocked by issuer' },
  INVALID_VPA: { class: 'instrument', retryable: false, label: 'UPI ID no longer valid' },
  MANDATE_REVOKED: { class: 'mandate', retryable: false, label: 'Customer cancelled the mandate' },
  ACCOUNT_CLOSED: { class: 'terminal', retryable: false, label: 'Bank account closed' },
  FRAUD_SUSPECTED: { class: 'terminal', retryable: false, label: 'Flagged by risk systems' },
};

export const defaultPolicy = {
  version: 4,
  // Model-estimated recovery probability required before an action runs without
  // a human. Deliberately expressed as a probability from a fitted model, not as
  // a language model's self-reported confidence.
  minRecoveryProbability: 0.58,
  // Expected value floor. Below this, the action costs more attention than it earns.
  minExpectedValuePaise: 15000,
  // Hard ceiling on any single automatic action.
  autoActionCeilingPaise: 2500000,
  // Contact fatigue. Customer attention is a depletable budget.
  maxContactsPer30d: 2,
  maxRetriesPerPayment: 2,
  // Money leaving the account is never automatic, at any confidence.
  allowAutomaticRefund: false,
  allowAutomaticCapture: true,
  allowAutomaticPaymentLink: true,
  allowAutomaticSubscriptionRetry: true,
  // Suppress retries into a live upstream outage. Retrying a bank that is down
  // manufactures failures and trains the customer that your checkout is broken.
  suppressDuringNetworkOutage: true,
  quietHours: { start: 21, end: 8 },
};

/**
 * Assumed issuer capacity, used by the retry coordinator.
 *
 * These are NOT measurements from Razorpay. No gateway publishes per-issuer
 * capacity, and a student with test-mode keys cannot observe it. They are
 * plausible order-of-magnitude assumptions, stated here rather than buried in
 * the scheduler so that a reviewer can change them and re-run the comparison.
 *
 * The coordinated-vs-uncoordinated comparison uses the same numbers on both
 * sides. What it demonstrates is that metering beats stampeding under any
 * congestion curve of this shape, not that these particular figures are right.
 *
 *   attemptsPerMinute - attempts the issuer handles before success rates degrade
 *   organicPerMinute  - first-attempt traffic already arriving, which retries
 *                       have to share the pipe with
 *   retryShare        - fraction of capacity the coordinator is willing to fill
 *                       with retries, leaving headroom for organic traffic
 */
/**
 * Shopper completion rate on a recovery link.
 *
 * ASSUMPTION, not measurement. Sits in the same category as ISSUER_CAPACITY:
 * the shape is defensible and the exact figure is not observed. Published
 * cart-recovery email benchmarks cluster in the 40-70% open-and-complete band
 * for a transactional mail about an order the shopper already tried to place,
 * which is a much warmer audience than a marketing blast. 0.62 sits inside that
 * band; the loyalty and fatigue terms are directional.
 *
 * This is deliberately part of the *ground truth* in the generator, not the
 * policy. The model has to learn it from historical rows like any other effect.
 */
export const LINK_COMPLETION = {
  base: 0.62,
  loyaltyLift: 0.16,
  fatiguePerContact: 0.09,
  source: 'assumption, documented in config.js',
};

export const ISSUER_CAPACITY = {
  'HDFC Netbanking': { attemptsPerMinute: 40, organicPerMinute: 18, retryShare: 0.5, source: 'assumption, documented in config.js' },
  'UPI / Google Pay': { attemptsPerMinute: 90, organicPerMinute: 40, retryShare: 0.5, source: 'assumption, documented in config.js' },
  'UPI / PhonePe': { attemptsPerMinute: 90, organicPerMinute: 45, retryShare: 0.5, source: 'assumption, documented in config.js' },
  default: { attemptsPerMinute: 50, organicPerMinute: 20, retryShare: 0.5, source: 'assumption, documented in config.js' },
};

export const METHODS = ['upi', 'card', 'netbanking', 'wallet'];

export const INSTRUMENTS = [
  { method: 'upi', issuer: 'UPI / PhonePe', share: 0.24, base: 0.947 },
  { method: 'upi', issuer: 'UPI / Google Pay', share: 0.18, base: 0.951 },
  { method: 'upi', issuer: 'UPI / Paytm', share: 0.08, base: 0.933 },
  { method: 'card', issuer: 'HDFC Credit', share: 0.11, base: 0.928 },
  { method: 'card', issuer: 'ICICI Debit', share: 0.09, base: 0.914 },
  { method: 'card', issuer: 'SBI Debit', share: 0.07, base: 0.902 },
  { method: 'netbanking', issuer: 'HDFC Netbanking', share: 0.09, base: 0.941 },
  { method: 'netbanking', issuer: 'Axis Netbanking', share: 0.05, base: 0.926 },
  { method: 'netbanking', issuer: 'Kotak Netbanking', share: 0.04, base: 0.919 },
  { method: 'wallet', issuer: 'Wallet / Mobikwik', share: 0.05, base: 0.897 },
];

export const MERCHANTS = [
  { id: 'acc_LEAFANDLOOM', name: 'Leaf & Loom', category: 'D2C home textiles', dailyVolume: 420, subscriptions: true },
  { id: 'acc_CHAIPOINTX', name: 'Chai Point X', category: 'F&B subscriptions', dailyVolume: 610, subscriptions: true },
  { id: 'acc_FITKART', name: 'Fitkart', category: 'Fitness equipment', dailyVolume: 260, subscriptions: false },
  { id: 'acc_NOTEBOOKED', name: 'Notebooked', category: 'SaaS for schools', dailyVolume: 180, subscriptions: true },
  { id: 'acc_URBANSOLE', name: 'Urbansole', category: 'Footwear', dailyVolume: 540, subscriptions: false },
  { id: 'acc_MEDIQUICK', name: 'MediQuick', category: 'Pharmacy delivery', dailyVolume: 330, subscriptions: true },
];
