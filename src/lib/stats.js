/**
 * Statistics for anomaly detection.
 *
 * The naive version of this product thresholds on a raw success rate: "if the
 * rate drops 10 points, alert". On thin slices that fires constantly. A bank
 * with 20 attempts an hour will swing 15 points on noise alone, and the merchant
 * learns to ignore the product inside a week.
 *
 * So every detection here has to clear a significance bar, and the change point
 * is located rather than assumed.
 */

/** Wilson score interval. Honest confidence bounds on a rate at small n. */
export function wilson(successes, total, z = 1.96) {
  if (total === 0) return { lo: 0, hi: 1, point: 0 };
  const p = successes / total;
  const d = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return { lo: Math.max(0, (centre - spread) / d), hi: Math.min(1, (centre + spread) / d), point: p };
}

function logBeta(a, b) {
  return lgamma(a) + lgamma(b) - lgamma(a + b);
}

/** Lanczos approximation. */
function lgamma(x) {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < g.length; i++) a += g[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function betaPdfSample(a, b, x) {
  if (x <= 0 || x >= 1) return 0;
  return Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - logBeta(a, b));
}

/**
 * Posterior probability that the current success rate is at least `delta` below
 * the historical baseline, given a Beta(1,1) prior updated by observed attempts.
 *
 * Numeric integration over a 2000-point grid. Exact enough at this scale and it
 * avoids pulling in a stats library for one function.
 */
export function probabilityOfDegradation(successes, total, baselineRate, delta = 0.05) {
  if (total < 8) return { probability: 0, posteriorMean: baselineRate, insufficient: true };
  const a = 1 + successes;
  const b = 1 + (total - successes);
  const threshold = baselineRate - delta;
  if (threshold <= 0) return { probability: 0, posteriorMean: a / (a + b), insufficient: false };

  const steps = 2000;
  let below = 0;
  let all = 0;
  for (let i = 1; i < steps; i++) {
    const x = i / steps;
    const d = betaPdfSample(a, b, x);
    all += d;
    if (x < threshold) below += d;
  }
  return {
    probability: all > 0 ? below / all : 0,
    posteriorMean: a / (a + b),
    insufficient: false,
  };
}

/**
 * Bernoulli CUSUM, log-likelihood-ratio form, for locating when a success rate
 * dropped rather than reporting a whole window as degraded.
 *
 * The normal-approximation version of this is a trap on payment data. With a
 * baseline near 94%, a single failure is nearly four standard deviations out, so
 * two unlucky consecutive failures trip the alarm and the "change point" lands
 * wherever the first random dip happened. The LLR form weights each observation
 * by how much it actually discriminates between the baseline rate and the
 * alternative, which is what makes the located change point trustworthy.
 *
 * Returns the index where the run of evidence began, or -1 for no change.
 */
export function cusumChangePoint(series, baselineRate, { delta = 0.06, h = 5 } = {}) {
  const p0 = Math.min(Math.max(baselineRate, 0.01), 0.99);
  const p1 = Math.min(Math.max(p0 - delta, 0.01), 0.99);
  const wSuccess = Math.log(p1 / p0);
  const wFailure = Math.log((1 - p1) / (1 - p0));

  let s = 0;
  let anchor = 0;
  for (let i = 0; i < series.length; i++) {
    const inc = series[i] === 1 ? wSuccess : wFailure;
    const next = s + inc;
    if (next <= 0) {
      s = 0;
      anchor = i + 1;
    } else {
      s = next;
    }
    if (s > h) return Math.min(anchor, series.length - 1);
  }
  return -1;
}

/**
 * Maximum-likelihood change-point location.
 *
 * CUSUM answers "did this change?" well and "when?" badly: it alarms at the end
 * of a run of evidence, and its anchor drifts if the series had an unlucky patch
 * earlier that never fully reset. So CUSUM is used as the alarm, and the split
 * point is then located properly by scanning every candidate index and keeping
 * the one that maximises the two-segment binomial likelihood.
 *
 * Only splits where the later segment is worse than the earlier one are
 * considered, since a rate *improving* is not the event being detected.
 */
export function mleChangePoint(series, { minSegment = 20 } = {}) {
  const n = series.length;
  if (n < 2 * minSegment) return -1;

  const cum = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + series[i];

  const ll = (successes, total) => {
    if (total === 0) return 0;
    const p = successes / total;
    if (p <= 0 || p >= 1) return 0;
    return successes * Math.log(p) + (total - successes) * Math.log(1 - p);
  };

  let bestTau = -1;
  let bestLL = -Infinity;
  for (let tau = minSegment; tau <= n - minSegment; tau++) {
    const preS = cum[tau];
    const postS = cum[n] - cum[tau];
    const preRate = preS / tau;
    const postRate = postS / (n - tau);
    if (postRate >= preRate) continue;
    const value = ll(preS, tau) + ll(postS, n - tau);
    if (value > bestLL) {
      bestLL = value;
      bestTau = tau;
    }
  }
  return bestTau;
}

/** Sample mean and sd, used for the training-set feature scaling. */
export function meanSd(values) {
  const n = values.length || 1;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const varr = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return { mean, sd: Math.sqrt(varr) || 1 };
}

/** Two-proportion z-test, used for the control vs treatment lift readout. */
export function twoProportionTest(s1, n1, s2, n2) {
  if (n1 === 0 || n2 === 0) return { z: 0, pValue: 1, significant: false };
  const p1 = s1 / n1;
  const p2 = s2 / n2;
  const pPool = (s1 + s2) / (n1 + n2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, pValue: 1, significant: false };
  const z = (p2 - p1) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { z, pValue, significant: pValue < 0.05 };
}

export function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x) {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return s * y;
}
