import { store } from '../store.js';
import { istHour, rupees } from '../lib/util.js';

/**
 * Policy engine.
 *
 * Deterministic, ordered, and completely separate from the model. It takes a
 * candidate and returns one of three verdicts with the rule that produced it.
 *
 *   AUTO   - run it without asking
 *   REVIEW - propose it, wait for a person
 *   BLOCK  - do not do this
 *
 * Two design choices worth defending in a review:
 *
 * 1. Refunds are never automatic at any probability. There is no confidence
 *    level at which an unattended system should move money out of a merchant's
 *    account, because the failure mode is unrecoverable and the upside is a few
 *    saved minutes.
 *
 * 2. Every BLOCK is costed. The engine records what the blocked action was
 *    expected to earn, so the merchant can see the price of their own caution
 *    instead of assuming safety is free.
 */

export function evaluate(candidate, policy = store.policy) {
  const reasons = [];
  const fired = [];
  const ev = candidate.chosen.expectedValue;
  const p = candidate.chosen.probability;

  const block = (rule, reason) => {
    fired.push({ rule, verdict: 'BLOCK', reason });
    return { verdict: 'BLOCK', rule, reason };
  };
  const review = (rule, reason) => {
    fired.push({ rule, verdict: 'REVIEW', reason });
    return { verdict: 'REVIEW', rule, reason };
  };

  let decision = null;

  // --- Hard blocks -----------------------------------------------------------
  if (candidate.chosen.action === 'none') {
    decision = block('no_viable_action', 'No recovery channel can succeed for this decline class.');
  } else if (!candidate.retryable && candidate.chosen.action.startsWith('retry')) {
    decision = block(
      'terminal_decline',
      `${candidate.errorCode} cannot succeed on a retry. Retrying would burn a gateway call and a customer contact for a guaranteed failure.`
    );
  } else if (candidate.chosen.action === 'refund' && !policy.allowAutomaticRefund) {
    decision = block('refund_never_automatic', 'Money leaving the account always needs a person, regardless of confidence.');
  } else if (candidate.leakType === 'stranded_orphan') {
    decision = review(
      'orphan_needs_human',
      'The payment succeeded but the merchant never acknowledged it. Fulfil or refund is a business call the payments side cannot make.'
    );
  }

  // --- Suppression during a live upstream outage -----------------------------
  if (!decision && policy.suppressDuringNetworkOutage && candidate.outageActive && candidate.chosen.action === 'retry') {
    decision = block(
      'upstream_outage_active',
      'The issuer is currently degraded across the network. An immediate retry would most likely produce a second failure and a worse customer experience.'
    );
  }

  // --- Contact budget --------------------------------------------------------
  const customer = store.customers.get(candidate.customerId);
  const contacts = customer?.contactsLast30d ?? 0;
  if (!decision && candidate.chosen.costsContact && contacts >= policy.maxContactsPer30d) {
    decision = block(
      'contact_budget_exhausted',
      `This customer has already been contacted ${contacts} times in 30 days. The budget is ${policy.maxContactsPer30d}.`
    );
  }

  // --- Economic floor --------------------------------------------------------
  if (!decision && ev < policy.minExpectedValuePaise) {
    decision = block(
      'below_value_floor',
      `Expected recovery is ${rupees(ev)}, under the ${rupees(policy.minExpectedValuePaise)} floor. Not worth the attention it costs.`
    );
  }

  // --- Review gates ----------------------------------------------------------
  if (!decision && candidate.amount > policy.autoActionCeilingPaise) {
    decision = review(
      'above_auto_ceiling',
      `${rupees(candidate.amount)} is above the ${rupees(policy.autoActionCeilingPaise)} automatic ceiling.`
    );
  }
  if (!decision && p < policy.minRecoveryProbability) {
    decision = review(
      'below_probability_gate',
      `Modelled recovery probability is ${(p * 100).toFixed(0)}%, under the ${(policy.minRecoveryProbability * 100).toFixed(0)}% automatic threshold.`
    );
  }
  if (!decision && candidate.chosen.action === 'payment_link' && !policy.allowAutomaticPaymentLink) {
    decision = review('link_requires_approval', 'Automatic payment links are switched off for this account.');
  }
  if (!decision && candidate.chosen.action === 'capture' && !policy.allowAutomaticCapture) {
    decision = review('capture_requires_approval', 'Automatic capture is switched off for this account.');
  }
  if (!decision && candidate.chosen.action.startsWith('retry') && !policy.allowAutomaticSubscriptionRetry && candidate.leakType === 'recurring') {
    decision = review('subscription_retry_requires_approval', 'Automatic subscription retries are switched off for this account.');
  }

  // --- Quiet hours -----------------------------------------------------------
  if (!decision && candidate.chosen.costsContact) {
    const h = istHour(candidate.chosen.scheduledFor);
    const { start, end } = policy.quietHours;
    const quiet = start > end ? h >= start || h < end : h >= start && h < end;
    if (quiet) {
      decision = review('quiet_hours', `Scheduled for ${h}:00, inside quiet hours (${start}:00\u2013${end}:00).`);
    }
  }

  if (!decision) {
    fired.push({ rule: 'auto_eligible', verdict: 'AUTO', reason: 'Clears every gate.' });
    decision = {
      verdict: 'AUTO',
      rule: 'auto_eligible',
      reason: `Probability ${(p * 100).toFixed(0)}% at or above the ${(policy.minRecoveryProbability * 100).toFixed(0)}% gate, expected recovery ${rupees(ev)}, within limits.`,
    };
  }

  return {
    ...decision,
    policyVersion: policy.version,
    rulesFired: fired,
    // Costing a block is what keeps the safety story honest. Guardrails are not
    // free and this is the invoice.
    foregoneValue: decision.verdict === 'BLOCK' ? ev : 0,
  };
}

/**
 * Backtest. Replays every decision already in the ledger against a candidate
 * policy and reports what would have changed, before the merchant turns it on.
 */
export function simulate(candidatePolicy) {
  const merged = { ...store.policy, ...candidatePolicy };
  const rows = store.candidates.map((c) => {
    const before = c.policy;
    const after = evaluate(c, merged);
    return { candidate: c, before, after, changed: before.verdict !== after.verdict };
  });

  const tally = (key) =>
    rows.reduce((acc, r) => {
      const v = r[key].verdict;
      acc[v] = (acc[v] || 0) + 1;
      return acc;
    }, {});

  const movedToAuto = rows.filter((r) => r.before.verdict !== 'AUTO' && r.after.verdict === 'AUTO');
  const movedOffAuto = rows.filter((r) => r.before.verdict === 'AUTO' && r.after.verdict !== 'AUTO');

  return {
    policy: merged,
    counts: { before: tally('before'), after: tally('after') },
    changedCount: rows.filter((r) => r.changed).length,
    newlyAutomatic: {
      count: movedToAuto.length,
      expectedValue: movedToAuto.reduce((s, r) => s + r.candidate.chosen.expectedValue, 0),
      sample: movedToAuto.slice(0, 6).map((r) => ({
        paymentId: r.candidate.paymentId,
        amount: r.candidate.amount,
        was: r.before.rule,
        now: r.after.rule,
      })),
    },
    newlyWithheld: {
      count: movedOffAuto.length,
      expectedValue: movedOffAuto.reduce((s, r) => s + r.candidate.chosen.expectedValue, 0),
      sample: movedOffAuto.slice(0, 6).map((r) => ({
        paymentId: r.candidate.paymentId,
        amount: r.candidate.amount,
        was: r.before.rule,
        now: r.after.rule,
      })),
    },
  };
}
