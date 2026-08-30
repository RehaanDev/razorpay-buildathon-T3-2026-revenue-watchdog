import { store } from '../store.js';
import { config, DECLINE_TAXONOMY } from '../config.js';
import { probabilityOfDegradation, cusumChangePoint, mleChangePoint, wilson } from '../lib/stats.js';
import { groupBy, sum, id } from '../lib/util.js';

const HOUR = 36e5;

function nowMs() {
  return store.meta.clock ? new Date(store.meta.clock).getTime() : Date.now();
}

function windowPayments(merchantId, hours) {
  const cutoff = nowMs() - hours * HOUR;
  return store.payments.filter(
    (p) => p.merchantId === merchantId && new Date(p.createdAt).getTime() >= cutoff
  );
}

/**
 * Per-issuer degradation, scored for significance rather than thresholded.
 *
 * The change point comes from a CUSUM over the ordered binary success series,
 * which is what lets the investigation say "this started at 18:04" instead of
 * "something was wrong at some point today".
 */
export function detectInstrumentDegradation(
  merchantId,
  { hours = 24, delta = 0.06, minProb = 0.97, minSegment = 25 } = {}
) {
  const merchant = store.merchants.find((m) => m.id === merchantId);
  const recent = windowPayments(merchantId, hours).filter((p) => p.status !== 'authorized' && !p.recurring);
  const byIssuer = groupBy(recent, (p) => p.issuer);
  const findings = [];

  for (const [issuer, rows] of byIssuer) {
    const baseline = baselineFor(merchant, issuer);
    if (!baseline) continue;
    const ordered = rows.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const series = ordered.map((p) => (p.status === 'captured' ? 1 : 0));

    // Find where the behaviour changed *before* testing how bad it is. Testing
    // the whole 24-hour window first is the mistake that hides a sharp evening
    // outage inside a day of healthy traffic: five bad hours averaged against
    // nineteen good ones look like noise.
    //
    // CUSUM raises the alarm, then the split is located by maximum likelihood.
    // Using the CUSUM anchor as the change point puts it minutes to hours early.
    const alarmed = cusumChangePoint(series, baseline.rate) >= 0;
    if (!alarmed) continue;
    const cpIdx = mleChangePoint(series);
    const segStart = cpIdx >= 0 ? cpIdx : 0;
    const affected = ordered.slice(segStart);
    if (affected.length < minSegment) continue;

    const segSeries = series.slice(segStart);
    const test = probabilityOfDegradation(sum(segSeries), segSeries.length, baseline.rate, delta);
    if (test.insufficient || test.probability < minProb) continue;

    const affectedFailures = affected.filter((p) => p.status === 'failed');
    const post = wilson(affected.filter((p) => p.status === 'captured').length, affected.length);

    findings.push({
      issuer,
      method: rows[0].method,
      baselineRate: baseline.rate,
      baselineAssumed: !!baseline.assumed,
      currentRate: post.point,
      currentInterval: [post.lo, post.hi],
      attemptsInWindow: series.length,
      changePointFound: cpIdx >= 0,
      significance: test.probability,
      changePoint: ordered[segStart].createdAt,
      affectedAttempts: affected.length,
      affectedFailures: affectedFailures.length,
      amountAtRisk: sum(affectedFailures, (p) => p.amount),
      failureIds: affectedFailures.map((p) => p.id),
    });
  }
  return findings.sort((a, b) => b.amountAtRisk - a.amountAtRisk);
}

/**
 * The cross-merchant signal.
 *
 * A single merchant staring at their own dashboard cannot tell whether a bank is
 * broken for them or broken for everyone. A payment platform can, because it
 * watches the same issuer across thousands of merchants at once. This is the one
 * capability in the product that does not exist outside a gateway, and it
 * changes the recommended action completely: an upstream outage means suppress
 * retries and route around it, a merchant-local fault means go fix your
 * checkout.
 */
export function correlateAcrossNetwork(issuer, changePoint) {
  const since = new Date(changePoint).getTime() - HOUR;
  const perMerchant = [];

  for (const m of store.merchants) {
    const baseline = baselineFor(m, issuer);
    if (!baseline) continue;
    const rows = store.payments.filter(
      (p) =>
        p.merchantId === m.id &&
        p.issuer === issuer &&
        !p.recurring &&
        p.status !== 'authorized' &&
        new Date(p.createdAt).getTime() >= since
    );
    if (rows.length < 8) continue;
    const successes = rows.filter((p) => p.status === 'captured').length;
    const test = probabilityOfDegradation(successes, rows.length, baseline.rate, 0.06);
    perMerchant.push({
      merchantId: m.id,
      merchantName: m.name,
      attempts: rows.length,
      rate: successes / rows.length,
      baselineRate: baseline.rate,
      degraded: test.probability >= 0.9,
      significance: test.probability,
    });
  }

  const degradedCount = perMerchant.filter((x) => x.degraded).length;
  const share = perMerchant.length ? degradedCount / perMerchant.length : 0;
  const verdict = share >= 0.5 ? 'upstream' : share > 0 && degradedCount === 1 ? 'merchant_local' : 'inconclusive';

  const networkAttempts = sum(perMerchant, (x) => x.attempts);
  const networkSuccesses = sum(perMerchant, (x) => x.rate * x.attempts);

  return {
    issuer,
    verdict,
    merchantsObserved: perMerchant.length,
    merchantsDegraded: degradedCount,
    share,
    networkRate: networkAttempts ? networkSuccesses / networkAttempts : null,
    perMerchant: perMerchant.sort((a, b) => a.rate - b.rate),
  };
}

/** Recurring charge failures, segmented by what the decline code actually means. */
export function detectRecurringFailures(merchantId, { hours = 24 } = {}) {
  const rows = windowPayments(merchantId, hours).filter((p) => p.recurring && p.status === 'failed');
  if (!rows.length) return null;

  const segments = new Map();
  for (const p of rows) {
    const klass = DECLINE_TAXONOMY[p.errorCode]?.class || 'soft';
    if (!segments.has(klass)) segments.set(klass, []);
    segments.get(klass).push(p);
  }

  return {
    count: rows.length,
    amountAtRisk: sum(rows, (p) => p.amount),
    paymentIds: rows.map((p) => p.id),
    segments: [...segments.entries()].map(([klass, items]) => ({
      class: klass,
      count: items.length,
      amount: sum(items, (p) => p.amount),
      retryable: items[0] ? DECLINE_TAXONOMY[items[0].errorCode]?.retryable : false,
      codes: [...new Set(items.map((p) => p.errorCode))],
    })),
  };
}

/**
 * Money that has left the customer but has not turned into anything.
 *
 * Note what this does *not* do: it does not claim to read the merchant's order
 * table, which a payment gateway cannot see. It uses two signals that are
 * genuinely visible from the payments side — a capture whose webhook the
 * merchant never acknowledged, and an authorisation sliding toward auto-void.
 */
export function detectStrandedPayments(merchantId) {
  const orphans = store.payments.filter(
    (p) =>
      p.merchantId === merchantId &&
      p.status === 'captured' &&
      !p.orderId &&
      p.webhookDelivery &&
      !p.webhookDelivery.acknowledged
  );

  const expiring = store.payments.filter((p) => {
    if (p.merchantId !== merchantId || p.status !== 'authorized') return false;
    const hoursLeft = (new Date(p.autoVoidAt).getTime() - nowMs()) / HOUR;
    return hoursLeft < 48;
  });

  return {
    orphans: orphans.map((p) => ({
      ...pick(p),
      hoursStranded: Math.round((nowMs() - new Date(p.createdAt).getTime()) / HOUR),
    })),
    expiring: expiring.map((p) => ({
      ...pick(p),
      hoursToVoid: Math.round((new Date(p.autoVoidAt).getTime() - nowMs()) / HOUR),
    })),
    orphanAmount: sum(orphans, (p) => p.amount),
    expiringAmount: sum(expiring, (p) => p.amount),
  };
}

function pick(p) {
  return {
    id: p.id,
    amount: p.amount,
    customerId: p.customerId,
    method: p.method,
    issuer: p.issuer,
    createdAt: p.createdAt,
    webhookDelivery: p.webhookDelivery,
    autoVoidAt: p.autoVoidAt,
  };
}

/**
 * The baseline success rate to test an issuer against.
 *
 * Seeded merchants carry measured baselines for the ten instruments in
 * config.js. Real Razorpay traffic does not: it arrives with whatever bank
 * name or VPA handle the customer actually used, and there is no history for
 * it. Rather than skip those issuers silently — which is what the first
 * version did, and it meant real payments were invisible to detection — this
 * falls back in two steps.
 *
 *   1. If this merchant has enough of its own history on the issuer outside
 *      the detection window, use the observed rate. That is a real baseline,
 *      just a locally computed one.
 *   2. Otherwise use the configured assumption, flagged as an assumption so
 *      that nothing downstream can present it as a measurement.
 */
export function baselineFor(merchant, issuer) {
  const measured = merchant.baselines?.[issuer];
  if (measured) return measured;

  const cutoff = nowMs() - config.detection.hours * HOUR;
  const history = store.payments.filter(
    (p) =>
      p.merchantId === merchant.id &&
      p.issuer === issuer &&
      p.status !== 'authorized' &&
      new Date(p.createdAt).getTime() < cutoff
  );

  if (history.length >= 40) {
    const successes = history.filter((p) => p.status === 'captured').length;
    return { rate: successes / history.length, learned: true, n: history.length };
  }

  return { rate: config.assumedBaselineRate, assumed: true };
}

/**
 * Real failed payments, surfaced as observations rather than inferences.
 *
 * This is the detector that makes the live path usable, and it is deliberately
 * not statistical.
 *
 * The three detectors above answer "has something changed?", which is a
 * question about a distribution and therefore needs a sample. With test-mode
 * keys you will make perhaps a dozen payments by hand, and no honest change
 * detector will fire on a dozen payments. Waiting for one to fire would mean
 * the live integration appears broken when it is working perfectly.
 *
 * But "this specific real payment failed and the money did not arrive" is not
 * an inference at all. It is a fact that Razorpay reported over a signed
 * webhook. It needs no significance test, because nothing is being claimed
 * beyond what was observed. So every real failed payment becomes a recovery
 * candidate immediately, and the finding carries `statistical: false` so no
 * surface can dress it up as a detected trend.
 */
export function detectRealFailures(merchantId, { hours = 72 } = {}) {
  const cutoff = nowMs() - hours * HOUR;
  const rows = store.payments.filter(
    (p) =>
      p.merchantId === merchantId &&
      p.source === 'razorpay' &&
      p.status === 'failed' &&
      new Date(p.createdAt).getTime() >= cutoff
  );

  if (!rows.length) return null;

  const byIssuer = groupBy(rows, (p) => p.issuer);

  return {
    statistical: false,
    count: rows.length,
    amountAtRisk: sum(rows, (p) => p.amount),
    paymentIds: rows.map((p) => p.id),
    windowHours: hours,
    byIssuer: [...byIssuer.entries()].map(([issuer, items]) => ({
      issuer,
      count: items.length,
      amount: sum(items, (p) => p.amount),
      codes: [...new Set(items.map((p) => p.errorCode))],
    })),
    byDecline: [...groupBy(rows, (p) => p.errorCode || 'UNKNOWN').entries()].map(([code, items]) => ({
      declineCode: code,
      meaning: DECLINE_TAXONOMY[code]?.label || 'Unrecognised decline',
      declineClass: DECLINE_TAXONOMY[code]?.class || 'soft',
      retryable: DECLINE_TAXONOMY[code]?.retryable ?? true,
      count: items.length,
      amount: sum(items, (p) => p.amount),
      razorpayReasons: [...new Set(items.map((p) => p.razorpayError?.reason).filter(Boolean))],
    })),
    note: 'These are actual failed payments reported by Razorpay over a signed webhook. No statistical claim is being made: each one is an observed failure, not a detected trend.',
  };
}

export function newInvestigationId() {
  return id('inv');
}
