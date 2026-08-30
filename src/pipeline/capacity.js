import { store } from '../store.js';
import { ISSUER_CAPACITY, INSTRUMENTS } from '../config.js';
import { congestionMultiplier } from './coordinator.js';
import { rng } from '../lib/util.js';

/**
 * Online issuer-capacity estimation.
 *
 * This module exists to retire the largest assumption in the system.
 *
 * The scheduler meters retry traffic against an issuer's capacity, and until now
 * that capacity was a constant in `config.js` — a defensible guess, labelled as
 * a guess, but still a number nobody measured. Every scheduling decision
 * inherited it. The honest version of this product does not assume capacity, it
 * estimates it from traffic it can already see, reports how confident it is, and
 * says so when it does not know.
 *
 * HOW THE ESTIMATE WORKS
 *
 * The congestion model asserts a relationship:
 *
 *     observed_success_rate(t) ≈ baseline_rate × congestionMultiplier(load(t), C)
 *
 * `load(t)` and `observed_success_rate(t)` are both measurable — they are just
 * attempt counts and outcomes bucketed by minute. `baseline_rate` is the
 * issuer's healthy success rate, which the detectors already track. That leaves
 * exactly one unknown, C, so the problem is a one-dimensional fit rather than
 * anything exotic.
 *
 * The fit is a grid search on squared error, weighted by bucket size, because
 * the likelihood surface is smooth and one-dimensional and a grid is easier to
 * reason about at 3am than a solver that might not converge.
 *
 * WHY IT HAS TO REPORT A CONFIDENCE INTERVAL
 *
 * Capacity is only identifiable from buckets where load was near or above
 * capacity. If the issuer was never stressed, every bucket sits on the flat part
 * of the curve where the multiplier is 1.0 regardless of C, and the data is
 * consistent with almost any capacity at all. A point estimate computed from
 * that data would look exactly like a point estimate computed from good data.
 *
 * So the interval is bootstrapped over buckets, and the estimate is only allowed
 * to override the configured assumption when the interval is tight enough to be
 * worth acting on. Otherwise the system keeps the assumption and says the data
 * was insufficient — which is a real answer, and a more useful one than a
 * confident number derived from traffic that never tested the limit.
 */

const MIN_BUCKETS = 12;
const MIN_STRESSED_BUCKETS = 4;
/** Interval wider than this fraction of the estimate means we learned nothing useful. */
const MAX_RELATIVE_WIDTH = 0.8;
const BOOTSTRAP_SAMPLES = 200;
/** Congestion requires success rate to fall as load rises. Anything weaker is an outage. */
const MAX_LOAD_RATE_CORRELATION = -0.35;

/** Pearson correlation. Returns 0 for a degenerate series rather than NaN. */
function correlation(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den ? num / den : 0;
}

function baselineRateFor(issuer) {
  const known = INSTRUMENTS.find((i) => i.issuer === issuer);
  if (known) return known.base;
  return 0.92; // matches ASSUMED_BASELINE_RATE elsewhere
}

/**
 * Attempts and outcomes for one issuer, bucketed by minute.
 *
 * Only buckets with enough attempts to produce a meaningful rate are kept: a
 * bucket with two attempts has a success rate of 0%, 50% or 100% and tells the
 * fit nothing except noise.
 */
export function loadBucketsFor(issuer, { windowHours = 24, minAttempts = 8 } = {}) {
  const since = new Date(store.meta.clock).getTime() - windowHours * 36e5;
  const rows = store.payments.filter(
    (p) => p.issuer === issuer && new Date(p.createdAt).getTime() >= since
  );
  if (!rows.length) return [];

  // Adaptive bucket width. A fixed one-minute bucket is right at production
  // volume and useless at demo volume, where most minutes hold a single
  // attempt and the "success rate" is therefore always 0% or 100%. So widen
  // the bucket until each one holds enough attempts to produce a rate that
  // means something, and express load as attempts *per minute* regardless of
  // bucket width — the congestion curve is defined on a rate, not a count, so
  // the estimate stays in comparable units either way.
  const widths = [1, 2, 5, 10, 15, 30, 60];
  let chosen = null;

  for (const width of widths) {
    const buckets = new Map();
    for (const p of rows) {
      const key = Math.floor(new Date(p.createdAt).getTime() / (width * 60000));
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { key, width, attempts: 0, succeeded: 0 }));
      b.attempts += 1;
      if (p.status === 'captured' || p.status === 'authorized') b.succeeded += 1;
    }
    const usable = [...buckets.values()].filter((b) => b.attempts >= minAttempts);
    chosen = usable;
    if (usable.length >= MIN_BUCKETS) break;
  }

  return (chosen || [])
    .map((b) => ({
      ...b,
      loadPerMinute: b.attempts / b.width,
      rate: b.succeeded / b.attempts,
    }))
    .sort((a, b) => a.key - b.key);
}

/** Weighted squared error of a candidate capacity against observed buckets. */
function residual(buckets, capacity, baseline) {
  let err = 0;
  let weight = 0;
  for (const b of buckets) {
    const predicted = baseline * congestionMultiplier(b.loadPerMinute, capacity);
    err += b.attempts * (predicted - b.rate) ** 2;
    weight += b.attempts;
  }
  return weight ? err / weight : Infinity;
}

function fitCapacity(buckets, baseline, { lo = 5, hi = 400 } = {}) {
  let best = null;
  for (let c = lo; c <= hi; c += 1) {
    const err = residual(buckets, c, baseline);
    if (!best || err < best.err) best = { capacity: c, err };
  }
  return best;
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

/**
 * Estimate capacity for one issuer.
 *
 * Always returns a usable capacity object with the same shape the scheduler
 * already consumes, so callers never have to branch on whether learning
 * succeeded. What changes is `source` and `learned`, which the UI and the
 * agent's `check_congestion` tool surface so nobody mistakes an assumption for
 * a measurement.
 */
export function estimateCapacity(issuer, opts = {}) {
  const assumed = ISSUER_CAPACITY[issuer] || ISSUER_CAPACITY.default;
  const baseline = baselineRateFor(issuer);
  const buckets = loadBucketsFor(issuer, opts);

  const insufficient = (reason) => ({
    ...assumed,
    learned: false,
    baselineRate: baseline,
    buckets: buckets.length,
    bucketWidthMinutes: buckets[0]?.width ?? null,
    reason,
    source: `${assumed.source} — ${reason}`,
  });

  if (buckets.length < MIN_BUCKETS) {
    return insufficient(`only ${buckets.length} usable minute-buckets, need ${MIN_BUCKETS}`);
  }

  // Capacity is identifiable only from buckets that actually pressed against it.
  const stressed = buckets.filter((b) => b.rate < baseline * 0.97);
  const peakLoad = Math.max(...buckets.map((b) => b.loadPerMinute));
  if (stressed.length < MIN_STRESSED_BUCKETS) {
    return insufficient(
      `this issuer was never stressed in the window (${stressed.length} degraded buckets, peak load ${peakLoad.toFixed(1)}/min against an assumed ceiling of ${assumed.attemptsPerMinute}/min), so capacity is not identifiable from the data`
    );
  }

  // The confound this system exists to avoid getting wrong.
  //
  // A degraded success rate is not evidence of congestion. An issuer having a
  // bad afternoon for its own reasons produces exactly the same low rate, and a
  // fit that does not distinguish the two will happily "learn" a tiny capacity
  // from an outage that had nothing to do with load — and then the scheduler
  // will throttle traffic that was never the problem.
  //
  // Congestion has a signature an outage does not: the degradation has to move
  // WITH load. So the estimate is gated on that correlation being present and
  // negative. If success rate fell while load stayed flat, this is an outage,
  // the estimator says so, and the configured assumption is kept.
  const corr = correlation(buckets.map((b) => b.loadPerMinute), buckets.map((b) => b.rate));
  if (!(corr < MAX_LOAD_RATE_CORRELATION)) {
    return {
      ...insufficient(
        `degradation does not track load (r = ${corr.toFixed(2)} between offered load and success rate). ` +
          `That is the signature of an issuer-side outage, not congestion, so throttling would not help and capacity cannot be identified from it`
      ),
      loadRateCorrelation: Number(corr.toFixed(3)),
    };
  }

  const GRID = { lo: 5, hi: 400 };
  const point = fitCapacity(buckets, baseline, GRID);

  // A fit that lands on the edge of the search grid is not a fit, it is the
  // optimiser running out of room. It means the likelihood is monotone across
  // everything we searched, which is what happens when the data simply does not
  // constrain the parameter. Reporting the boundary as an estimate would dress
  // "no information" up as a precise answer.
  if (point.capacity <= GRID.lo || point.capacity >= GRID.hi) {
    return {
      ...insufficient(
        `best fit landed on the edge of the search range (${point.capacity}/min), which means the data does not constrain capacity rather than that capacity is ${point.capacity}`
      ),
      loadRateCorrelation: Number(corr.toFixed(3)),
    };
  }

  // Bootstrap over buckets for the interval.
  //
  // Seeded, not Math.random. This whole product's demo promise is that two
  // people running it on two machines see the same numbers, and a confidence
  // interval that moves between runs quietly breaks that — it shifted the
  // headline A/B figure by three percentage points before it was caught. A
  // stochastic estimator inside a reproducible system has to carry its own
  // deterministic stream.
  const draw = rng(20260829);
  const draws = [];
  for (let s = 0; s < BOOTSTRAP_SAMPLES; s++) {
    const sample = [];
    for (let i = 0; i < buckets.length; i++) {
      sample.push(buckets[(draw() * buckets.length) | 0]);
    }
    draws.push(fitCapacity(sample, baseline, GRID).capacity);
  }
  draws.sort((a, b) => a - b);
  const lo = percentile(draws, 0.05);
  const hi = percentile(draws, 0.95);
  const width = (hi - lo) / (point.capacity || 1);

  if (width > MAX_RELATIVE_WIDTH) {
    return {
      ...insufficient(`interval [${lo}, ${hi}] is too wide relative to the estimate to act on`),
      pointEstimate: point.capacity,
      interval: [lo, hi],
    };
  }

  return {
    attemptsPerMinute: point.capacity,
    organicPerMinute: assumed.organicPerMinute,
    retryShare: assumed.retryShare,
    learned: true,
    baselineRate: baseline,
    buckets: buckets.length,
    stressedBuckets: stressed.length,
    loadRateCorrelation: Number(corr.toFixed(3)),
    bucketWidthMinutes: buckets[0]?.width ?? null,
    peakLoadPerMinute: Number(peakLoad.toFixed(1)),
    interval: [lo, hi],
    relativeWidth: Number(width.toFixed(3)),
    assumedWas: assumed.attemptsPerMinute,
    residual: Number(point.err.toFixed(5)),
    source: `estimated from ${buckets.length} minute-buckets of observed traffic (${stressed.length} degraded), 90% CI [${lo}, ${hi}] attempts/min`,
  };
}

/** Every issuer the estimator has an opinion about. Read model for the UI. */
export function capacityReport() {
  const issuers = [...new Set(store.payments.map((p) => p.issuer))].filter(Boolean);
  return issuers
    .map((issuer) => ({ issuer, ...estimateCapacity(issuer) }))
    .sort((a, b) => Number(b.learned) - Number(a.learned) || a.issuer.localeCompare(b.issuer));
}
