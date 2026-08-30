import { store } from '../store.js';
import { DECLINE_TAXONOMY } from '../config.js';
import { clamp } from '../lib/util.js';

/**
 * Recovery-probability model.
 *
 * This exists because "the AI is 92% confident" is not a number anyone should
 * gate money on. A language model's stated confidence is not calibrated against
 * anything, so a policy engine keyed to it is keyed to a vibe.
 *
 * Instead: a logistic regression fitted on historical recovery attempts and
 * their observed outcomes. It produces a probability with a Brier score and a
 * calibration curve attached, and the policy engine gates on that. The language
 * model's job is explanation and strategy selection, which is what it is
 * actually good at.
 */

export const FEATURES = [
  'class_soft',
  'class_timing',
  'class_instrument',
  'class_dead',
  'prior_success_rate',
  'prior_failed_attempts',
  'contacts_30d',
  'in_success_window',
  'outage_active',
  'log_amount',
  'action_link',
  'action_capture',
];

export function featurize(ctx) {
  const klass = DECLINE_TAXONOMY[ctx.errorCode]?.class || 'soft';
  return [
    klass === 'soft' ? 1 : 0,
    klass === 'timing' ? 1 : 0,
    klass === 'instrument' ? 1 : 0,
    klass === 'mandate' || klass === 'terminal' ? 1 : 0,
    ctx.priorSuccessRate ?? 0.5,
    Math.min(ctx.priorFailedAttempts ?? 0, 4) / 4,
    Math.min(ctx.contactsLast30d ?? 0, 3) / 3,
    ctx.inSuccessWindow ? 1 : 0,
    ctx.outageActive ? 1 : 0,
    (Math.log(Math.max(ctx.amount ?? 50000, 1)) - Math.log(50000)) / 2,
    ctx.action === 'payment_link' ? 1 : 0,
    ctx.action === 'capture' ? 1 : 0,
  ];
}

const sigmoid = (z) => 1 / (1 + Math.exp(-clamp(z, -30, 30)));

export function fitModel({ epochs = 900, lr = 0.35, l2 = 1e-4 } = {}) {
  const rows = store.trainingRows;
  if (!rows.length) throw new Error('no training rows');

  // 80/20 split so the reported metrics are held out, not in-sample.
  const split = Math.floor(rows.length * 0.8);
  const train = rows.slice(0, split);
  const test = rows.slice(split);

  const X = train.map(featurize);
  const y = train.map((r) => r.recovered);
  let w = new Array(FEATURES.length).fill(0);
  let b = 0;

  for (let e = 0; e < epochs; e++) {
    const gw = new Array(FEATURES.length).fill(0);
    let gb = 0;
    for (let i = 0; i < X.length; i++) {
      const z = X[i].reduce((s, v, j) => s + v * w[j], b);
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < w.length; j++) gw[j] += err * X[i][j];
      gb += err;
    }
    for (let j = 0; j < w.length; j++) w[j] -= lr * (gw[j] / X.length + l2 * w[j]);
    b -= lr * (gb / X.length);
  }

  const preds = test.map((r) => sigmoid(featurize(r).reduce((s, v, j) => s + v * w[j], b)));
  const actuals = test.map((r) => r.recovered);
  const brier = preds.reduce((s, p, i) => s + (p - actuals[i]) ** 2, 0) / (preds.length || 1);
  const baseRate = actuals.reduce((s, v) => s + v, 0) / (actuals.length || 1);
  const brierBase = actuals.reduce((s, v) => s + (baseRate - v) ** 2, 0) / (actuals.length || 1);

  // Reliability curve in ten buckets. If the model says 0.7, roughly 70% of
  // those attempts should have worked.
  const buckets = Array.from({ length: 10 }, (_, i) => ({ bin: i / 10, n: 0, predicted: 0, observed: 0 }));
  preds.forEach((p, i) => {
    const bkt = buckets[Math.min(9, Math.floor(p * 10))];
    bkt.n++;
    bkt.predicted += p;
    bkt.observed += actuals[i];
  });
  const calibration = buckets
    .filter((bkt) => bkt.n >= 5)
    .map((bkt) => ({
      bin: bkt.bin,
      n: bkt.n,
      predicted: bkt.predicted / bkt.n,
      observed: bkt.observed / bkt.n,
    }));

  store.model = {
    weights: w,
    bias: b,
    trainedOn: train.length,
    testedOn: test.length,
    brier,
    skillScore: 1 - brier / (brierBase || 1),
    calibration,
    features: FEATURES.map((f, i) => ({ feature: f, weight: w[i] })).sort((a, b2) => Math.abs(b2.weight) - Math.abs(a.weight)),
    fittedAt: new Date().toISOString(),
  };
  return store.model;
}

export function predictRecovery(ctx) {
  if (!store.model) fitModel();
  const x = featurize(ctx);
  const z = x.reduce((s, v, j) => s + v * store.model.weights[j], store.model.bias);
  return clamp(sigmoid(z), 0.001, 0.999);
}
