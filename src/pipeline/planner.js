import { store } from '../store.js';
import { DECLINE_TAXONOMY } from '../config.js';
import { predictRecovery } from './model.js';
import { stableHash, istHour, id } from '../lib/util.js';

/**
 * Recovery planning.
 *
 * Most dunning tools ask a per-event question: "should I retry this payment?"
 * That question has no good answer on its own, because the constraint that
 * actually binds is not gateway capacity, it is customer patience. Every
 * merchant has a finite number of times they can poke a customer before the
 * customer stops reading. So the real question is an allocation one: given a
 * contact budget, which interventions buy the most recovered rupees?
 *
 * This module scores every viable channel for every failed payment, keeps the
 * best one by expected value, and hands the ranked list to the policy engine.
 */

const CHANNELS = [
  { action: 'retry', label: 'Retry the charge', costsContact: false },
  { action: 'retry_windowed', label: 'Retry inside the customer\u2019s usual paying window', costsContact: false },
  { action: 'payment_link', label: 'Send a recovery payment link', costsContact: true },
  { action: 'capture', label: 'Capture the authorisation', costsContact: false },
  { action: 'escalate', label: 'Escalate to the merchant', costsContact: false },
  { action: 'none', label: 'Do nothing', costsContact: false },
];

function contextFor(payment, customer, opts) {
  return {
    errorCode: payment.errorCode || 'GATEWAY_ERROR',
    amount: payment.amount,
    priorSuccessRate: customer?.priorSuccessRate ?? 0.5,
    priorFailedAttempts: (customer?.priorFailures ?? 0) + (payment.attemptNo - 1),
    contactsLast30d: customer?.contactsLast30d ?? 0,
    inSuccessWindow: opts.inSuccessWindow,
    outageActive: opts.outageActive,
    action: opts.action,
  };
}

function inCustomerWindow(customer, iso) {
  if (!customer?.successWindow) return false;
  const h = istHour(iso);
  return h >= customer.successWindow[0] && h <= customer.successWindow[1];
}

/** Next occurrence of the customer's historically successful paying window. */
function nextWindowStart(customer, fromIso) {
  const from = new Date(fromIso);
  const target = new Date(from);
  target.setHours(customer?.successWindow?.[0] ?? 11, 0, 0, 0);
  if (target <= from) target.setDate(target.getDate() + 1);
  return target.toISOString();
}

/**
 * Anything that costs a customer contact gets scheduled into a slot the merchant
 * actually allows, rather than fired the instant it is planned.
 *
 * Quiet hours are a scheduling constraint, not an approval question. Sending a
 * recovery link at 11pm and sending it at 9am are the same action with different
 * timing, so the planner moves it; there is nothing here for a human to decide.
 */
function nextAllowedContactSlot(customer, fromIso, quietHours) {
  const t = new Date(fromIso);
  const { start, end } = quietHours;
  for (let i = 0; i < 48; i++) {
    const h = t.getHours();
    const quiet = start > end ? h >= start || h < end : h >= start && h < end;
    const inWindow = customer?.successWindow
      ? h >= customer.successWindow[0] && h <= customer.successWindow[1]
      : true;
    if (!quiet && inWindow) return t.toISOString();
    t.setHours(t.getHours() + 1, 0, 0, 0);
  }
  return t.toISOString();
}

export function planRecovery(payment, { outageActive = false, leakType, investigationId } = {}) {
  const customer = store.customers.get(payment.customerId);
  const taxonomy = DECLINE_TAXONOMY[payment.errorCode] || { class: 'soft', retryable: true, label: 'Unknown' };
  const now = store.meta.clock;

  const options = [];
  for (const ch of CHANNELS) {
    if (ch.action === 'none' || ch.action === 'escalate') continue;

    // Structural feasibility. A retry against a dead instrument is not a low
    // probability action, it is an impossible one, and the model should not be
    // asked to discover that from data every time.
    if ((ch.action === 'retry' || ch.action === 'retry_windowed') && !taxonomy.retryable) continue;
    if (ch.action === 'capture' && payment.status !== 'authorized') continue;
    if (ch.action !== 'capture' && payment.status === 'authorized') continue;
    if (ch.action === 'payment_link' && taxonomy.class === 'terminal') continue;

    const windowed = ch.action === 'retry_windowed';
    const modelAction = ch.action === 'retry_windowed' ? 'retry' : ch.action;
    const probability = predictRecovery(
      contextFor(payment, customer, {
        action: modelAction,
        inSuccessWindow: windowed ? true : inCustomerWindow(customer, now),
        outageActive,
      })
    );

    const expectedValue = Math.round(probability * payment.amount);
    const scheduledFor = ch.costsContact
      ? nextAllowedContactSlot(customer, now, store.policy.quietHours)
      : windowed
        ? nextWindowStart(customer, now)
        : now;

    options.push({
      action: ch.action,
      label: ch.label,
      probability,
      expectedValue,
      costsContact: ch.costsContact,
      scheduledFor,
    });
  }

  options.sort((a, b) => b.expectedValue - a.expectedValue);
  const best = options[0] || {
    action: 'none',
    label: 'Do nothing',
    probability: 0,
    expectedValue: 0,
    costsContact: false,
    scheduledFor: now,
  };

  // Permanent holdout. A deterministic hash on the payment id means the same
  // payment lands in the same arm on every run, and the split never drifts.
  const arm = stableHash(`holdout::${payment.id}`) < 0.2 ? 'control' : 'treatment';

  return {
    id: id('cand'),
    investigationId,
    leakType,
    paymentId: payment.id,
    merchantId: payment.merchantId,
    customerId: payment.customerId,
    customerName: customer?.name || 'Unknown',
    amount: payment.amount,
    errorCode: payment.errorCode,
    declineClass: taxonomy.class,
    declineLabel: taxonomy.label,
    retryable: taxonomy.retryable,
    outageActive,
    arm,
    chosen: best,
    alternatives: options.slice(1),
    // What the naive path would have done: retry immediately, every time,
    // regardless of decline class or upstream state. This is the control arm.
    naive: { action: 'retry', scheduledFor: now },
    createdAt: now,
  };
}
