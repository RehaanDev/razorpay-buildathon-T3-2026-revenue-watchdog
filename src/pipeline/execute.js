import { store } from '../store.js';
import { DECLINE_TAXONOMY } from '../config.js';
import { razorpay } from '../razorpay/client.js';
import { trueRecoveryProbability } from '../seed/generator.js';
import { rng, istHour, id, sum } from '../lib/util.js';

/**
 * Execution and verification.
 *
 * Two things here are load-bearing.
 *
 * 1. Idempotency. The key is derived from the candidate and the action, not
 *    generated fresh, so a replayed request returns the original result instead
 *    of charging a customer a second time. `store.withIdempotency` is what makes
 *    a double-click harmless.
 *
 * 2. The control arm. A fixed 20% of candidates are permanently withheld from
 *    the intelligent path and given naive treatment: immediate retry, every
 *    time, whatever the decline code says. That is the only way to state a lift
 *    figure that means anything. Without it "we recovered X" is a number with no
 *    denominator, because some of those payments would have recovered anyway.
 *
 * Outcomes are sampled from the hidden dynamics in the generator, which the
 * model never reads. Under a live Razorpay key the same code path issues real
 * test-mode API calls and the outcome comes back over webhooks instead.
 */

const outcomeRand = rng(918273);

function idempotencyKeyFor(candidate, action) {
  return `rw:${candidate.paymentId}:${action}:v${store.policy.version}`;
}

function inWindow(customer, iso) {
  if (!customer?.successWindow) return false;
  const h = istHour(iso);
  return h >= customer.successWindow[0] && h <= customer.successWindow[1];
}

async function callGateway(candidate, action) {
  const payment = store.paymentsById.get(candidate.paymentId);
  const customer = store.customers.get(candidate.customerId);
  const key = idempotencyKeyFor(candidate, action);

  switch (action) {
    case 'payment_link':
      return razorpay.createPaymentLink({
        amount: candidate.amount,
        customerName: customer?.name || 'Customer',
        description: `Recovery for payment ${candidate.paymentId}`,
        referenceId: candidate.id,
        idempotencyKey: key,
      });
    case 'capture':
      return razorpay.capturePayment({ paymentId: candidate.paymentId, amount: candidate.amount, idempotencyKey: key });
    case 'refund':
      return razorpay.refundPayment({ paymentId: candidate.paymentId, amount: candidate.amount, idempotencyKey: key });
    case 'retry':
    case 'retry_windowed':
      if (payment?.subscriptionId) {
        return razorpay.retrySubscriptionCharge({ subscriptionId: payment.subscriptionId, idempotencyKey: key });
      }
      return razorpay.createPaymentLink({
        amount: candidate.amount,
        customerName: customer?.name || 'Customer',
        description: `Retry for payment ${candidate.paymentId}`,
        referenceId: candidate.id,
        idempotencyKey: key,
      });
    default:
      return { id: id('noop'), status: 'skipped' };
  }
}

/** Samples the real-world result. Never consults the model. */
function sampleOutcome(candidate, action, { windowed }) {
  const payment = store.paymentsById.get(candidate.paymentId);
  const customer = store.customers.get(candidate.customerId);
  const p = trueRecoveryProbability({
    errorCode: candidate.errorCode || 'GATEWAY_ERROR',
    action: action === 'retry_windowed' ? 'retry' : action,
    priorSuccessRate: customer?.priorSuccessRate ?? 0.5,
    priorFailedAttempts: (customer?.priorFailures ?? 0) + ((payment?.attemptNo ?? 1) - 1),
    contactsLast30d: customer?.contactsLast30d ?? 0,
    inSuccessWindow: windowed ? true : inWindow(customer, store.meta.clock),
    outageActive: candidate.outageActive,
    amount: candidate.amount,
  });
  return { recovered: outcomeRand() < p, truthProbability: p };
}

export async function execute(candidate, { approvedBy = 'policy_engine', overrideAction = null } = {}) {
  const action = overrideAction || candidate.chosen.action;
  const key = idempotencyKeyFor(candidate, action);

  const guard = store.withIdempotency(key, () => ({ started: true, actionId: id('act') }));
  if (guard.replayed) {
    const prior = store.actions.find((a) => a.idempotencyKey === key);
    store.record({
      type: 'action_replayed',
      candidateId: candidate.id,
      paymentId: candidate.paymentId,
      idempotencyKey: key,
      note: 'Duplicate request suppressed. Returned the original result rather than acting twice.',
    });
    return prior;
  }

  let gatewayResponse = null;
  let error = null;
  try {
    gatewayResponse = await callGateway(candidate, action);
  } catch (e) {
    error = { message: e.message, code: e.code, retryable: !!e.retryable };
  }

  const windowed = action === 'retry_windowed';
  const payment = store.paymentsById.get(candidate.paymentId);
  const isReal = payment?.source === 'razorpay';

  // Does this action reach out to the shopper with a link they must pay?
  // If so, its outcome is not knowable at execution time — it depends on the
  // shopper. Both real and fake such actions go PENDING and are resolved later:
  //   - real  -> by the payment_link.paid webhook or a reconcile poll
  //   - fake  -> by the green/red buttons in the email simulator
  // Non-emailed fake actions (e.g. a silent capture) still settle immediately
  // via the sampled outcome, because no shopper interaction is involved.
  const isEmailedLink =
    (action === 'payment_link' || action === 'retry' || action === 'retry_windowed') &&
    !!gatewayResponse?.short_url;

  const outcome = error
    ? { recovered: false, truthProbability: 0, pending: false }
    : isReal
      ? { recovered: false, truthProbability: null, pending: true }
      : isEmailedLink
        ? { recovered: false, truthProbability: null, pending: true }
        : sampleOutcome(candidate, action, { windowed });

  const record = {
    id: guard.actionId,
    idempotencyKey: key,
    candidateId: candidate.id,
    paymentId: candidate.paymentId,
    merchantId: candidate.merchantId,
    customerId: candidate.customerId,
    arm: candidate.arm,
    leakType: candidate.leakType,
    action,
    approvedBy,
    amount: candidate.amount,
    modelProbability: candidate.chosen.probability,
    expectedValue: candidate.chosen.expectedValue,
    scheduledFor: candidate.chosen.scheduledFor,
    gatewayMode: razorpay.mode(),
    gatewayResponse: gatewayResponse
      ? { id: gatewayResponse.id, status: gatewayResponse.status, short_url: gatewayResponse.short_url || null }
      : null,
    // The recovery link URL, lifted out so the email simulator and the UI can
    // use it directly without re-reading the gateway response shape.
    recoveryLink: gatewayResponse?.short_url || null,
    error,
    recovered: outcome.recovered,
    pending: outcome.pending || false,
    recoveredAmount: outcome.recovered ? candidate.amount : 0,
    executedAt: new Date().toISOString(),
  };

  store.actions.push(record);
  if (candidate.chosen.costsContact) {
    const c = store.customers.get(candidate.customerId);
    if (c) c.contactsLast30d = (c.contactsLast30d || 0) + 1;
  }

  store.record({
    type: 'action_executed',
    candidateId: candidate.id,
    paymentId: candidate.paymentId,
    arm: candidate.arm,
    action,
    approvedBy,
    idempotencyKey: key,
    amount: candidate.amount,
    modelProbability: candidate.chosen.probability,
    recovered: outcome.recovered,
    recoveredAmount: record.recoveredAmount,
    gatewayMode: razorpay.mode(),
  });

  return record;
}

/**
 * Settle simulated recovery links that are waiting on a shopper.
 *
 * An emailed link cannot be resolved at execution time, because its outcome
 * depends on a human. In the UI that resolution comes from the green/red
 * buttons in the email simulator. In a headless run — the A/B harness, the test
 * suite — nobody is there to click, and without this the treatment arm's best
 * action would sit forever in the denominator as an unresolved failure while
 * the control arm's naive retries settled instantly. That is not a lift
 * measurement, it is a comparison between a settled arm and an unsettled one.
 *
 * So: for SIMULATED payments only, sample the shopper's response from the same
 * hidden dynamics every other outcome is drawn from. Real Razorpay payments are
 * untouched — their truth arrives over a webhook or not at all, and a harness is
 * never allowed to invent it.
 *
 * Returns a count so callers can assert that nothing was left dangling.
 */
export function settleSimulatedPending() {
  let settled = 0;
  for (const action of store.actions) {
    if (!action.pending) continue;
    const payment = store.paymentsById.get(action.paymentId);
    if (payment?.source === 'razorpay') continue; // real money, real webhook, not ours to decide

    const candidate = store.candidates.find((c) => c.id === action.candidateId);
    if (!candidate) continue;

    const outcome = sampleOutcome(candidate, action.action, { windowed: action.action === 'retry_windowed' });
    action.pending = false;
    action.recovered = outcome.recovered;
    action.recoveredAmount = outcome.recovered ? action.amount : 0;
    action.recoveredAt = outcome.recovered ? new Date().toISOString() : null;
    action.recoveredVia = outcome.recovered ? 'simulated_shopper' : null;
    action.expired = !outcome.recovered;

    const email = store.emails.find((e) => e.candidateId === action.candidateId && !e.real);
    if (email && email.status === 'sent') {
      email.status = outcome.recovered ? 'paid' : 'expired';
      email[outcome.recovered ? 'paidAt' : 'expiredAt'] = new Date().toISOString();
    }
    candidate.resolved = {
      by: 'simulated',
      at: new Date().toISOString(),
      outcome: outcome.recovered ? 'recovered' : 'not_recovered',
      reason: outcome.recovered ? null : 'simulated shopper did not complete the link',
    };

    store.record({
      type: 'simulated_link_settled',
      candidateId: candidate.id,
      paymentId: action.paymentId,
      arm: action.arm,
      recovered: outcome.recovered,
      recoveredAmount: action.recoveredAmount,
      truthProbability: outcome.truthProbability,
      note: 'Shopper response sampled from the hidden dynamics. Simulated payments only.',
    });
    settled += 1;
  }
  return settled;
}

/** The naive baseline: retry immediately, regardless of what the decline meant. */
export async function executeControl(candidate) {
  const retryable = DECLINE_TAXONOMY[candidate.errorCode]?.retryable ?? true;
  const key = `rw:control:${candidate.paymentId}`;
  const guard = store.withIdempotency(key, () => ({ actionId: id('act') }));
  if (guard.replayed) return store.actions.find((a) => a.idempotencyKey === key);

  // The naive path attempts everything, which is exactly why it wastes attempts
  // on dead instruments and retries into live outages.
  const outcome = retryable || candidate.chosen.action === 'capture'
    ? sampleOutcome(candidate, candidate.chosen.action === 'capture' ? 'capture' : 'retry', { windowed: false })
    : { recovered: false, truthProbability: 0.01 };

  const record = {
    id: guard.actionId,
    idempotencyKey: key,
    candidateId: candidate.id,
    paymentId: candidate.paymentId,
    merchantId: candidate.merchantId,
    customerId: candidate.customerId,
    arm: 'control',
    leakType: candidate.leakType,
    action: 'naive_retry',
    approvedBy: 'control_arm',
    amount: candidate.amount,
    modelProbability: null,
    expectedValue: null,
    gatewayMode: razorpay.mode(),
    recovered: outcome.recovered,
    recoveredAmount: outcome.recovered ? candidate.amount : 0,
    executedAt: new Date().toISOString(),
  };
  store.actions.push(record);
  store.record({
    type: 'control_executed',
    candidateId: candidate.id,
    paymentId: candidate.paymentId,
    arm: 'control',
    action: 'naive_retry',
    recovered: outcome.recovered,
    recoveredAmount: record.recoveredAmount,
  });
  return record;
}

/**
 * Verification. Re-reads the payment from the gateway and reconciles what the
 * system believed against what actually happened. In mock mode this closes the
 * loop locally; under a live key it is the same fetch against Razorpay.
 */
export async function verify(actionRecord) {
  let gatewayState = null;
  try {
    const p = await razorpay.fetchPayment(actionRecord.paymentId);
    gatewayState = p.status;
  } catch {
    gatewayState = 'unavailable';
  }
  const row = {
    actionId: actionRecord.id,
    paymentId: actionRecord.paymentId,
    believed: actionRecord.recovered ? 'recovered' : 'not_recovered',
    gatewayState,
    recoveredAmount: actionRecord.recoveredAmount,
    verifiedAt: new Date().toISOString(),
  };
  store.record({ type: 'verification', ...row });
  return row;
}

export function armTotals() {
  const treat = store.actions.filter((a) => a.arm === 'treatment');
  const ctrl = store.actions.filter((a) => a.arm === 'control');
  return {
    treatment: {
      n: treat.length,
      recovered: treat.filter((a) => a.recovered).length,
      amount: sum(treat, (a) => a.recoveredAmount),
      exposed: sum(treat, (a) => a.amount),
    },
    control: {
      n: ctrl.length,
      recovered: ctrl.filter((a) => a.recovered).length,
      amount: sum(ctrl, (a) => a.recoveredAmount),
      exposed: sum(ctrl, (a) => a.amount),
    },
  };
}
