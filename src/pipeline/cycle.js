import { store } from '../store.js';
import { config } from '../config.js';
import {
  detectInstrumentDegradation,
  correlateAcrossNetwork,
  detectRecurringFailures,
  detectStrandedPayments,
  detectRealFailures,
  newInvestigationId,
} from './detectors.js';
import { diagnoseDegradation, diagnoseRecurring, diagnoseStranded, polishNarrative } from './diagnose.js';
import { planRecovery } from './planner.js';
import { evaluate } from './policy.js';
import { execute, executeControl, verify, armTotals } from './execute.js';
import { fitModel } from './model.js';
import { twoProportionTest } from '../lib/stats.js';
import { sum, rupees } from '../lib/util.js';
import { razorpay } from '../razorpay/client.js';
import { composeRecoveryEmail, recoverabilityFor, markEmailPaid, expireEmailFor, resolveSimEmail } from './emails.js';

/**
 * One full cycle: watch, diagnose, quantify, plan, gate, act, verify.
 *
 * The ordering is the product. Detection is broad and cheap. Diagnosis is where
 * the cross-merchant signal turns a number into a cause. Planning is an
 * allocation problem under a contact budget. The policy engine is the only thing
 * that can authorise an action, and it never asks the model for permission.
 */
export async function runCycle({ merchantId = config.focusMerchantId, autoExecute = true } = {}) {
  const merchant = store.merchants.find((m) => m.id === merchantId);
  if (!store.model) fitModel();

  // Expire pending real recoveries that have gone unpaid for 24 hours.
  // A real payment link stays open while we wait for the shopper. If it has not
  // been paid within 24h, the link is treated as expired: the action becomes
  // not_recovered and its email is marked expired. This is what lets the
  // recovery queue "wait" instead of prematurely declaring failure.
  expireStalePendingActions();

  store.investigations = [];
  store.candidates = [];

  const investigations = [];

  // --- 0. Real payments from the Razorpay account ----------------------------
  // These are observed facts, not statistical inferences. Every real failed
  // payment becomes a candidate immediately, regardless of volume.
  const realFailures = detectRealFailures(merchantId);
  if (realFailures && realFailures.count > 0) {
    investigations.push({
      id: newInvestigationId(),
      merchantId,
      leakType: 'real_failures',
      title: `${realFailures.count} real payment${realFailures.count > 1 ? 's' : ''} failed on your Razorpay account`,
      severity: 'high',
      amountAtRisk: realFailures.amountAtRisk,
      detection: realFailures,
      network: null,
      diagnosis: {
        summary: `${realFailures.count} payment${realFailures.count > 1 ? 's' : ''} (₹${Math.round(realFailures.amountAtRisk / 100).toLocaleString('en-IN')}) failed on your live Razorpay account. These are confirmed failures reported over signed webhooks — not statistical estimates.`,
        verdict: 'real_failures',
        declineBreakdown: realFailures.byDecline,
        note: 'No significance test was applied. Each row here is an observed failure.',
      },
      paymentIds: realFailures.paymentIds,
      openedAt: new Date().toISOString(),
      real: true,
    });
  }

  // --- 1. Instrument degradation, with the network signal attached -----------
  const findings = detectInstrumentDegradation(merchantId);
  for (const finding of findings) {
    const network = correlateAcrossNetwork(finding.issuer, finding.changePoint);
    let diagnosis = diagnoseDegradation(finding, network, merchant);
    diagnosis = await polishNarrative(diagnosis, `Instrument degradation for ${merchant.name}`);

    investigations.push({
      id: newInvestigationId(),
      merchantId,
      leakType: network.verdict === 'upstream' ? 'instrument_degradation_upstream' : 'instrument_degradation_local',
      title:
        network.verdict === 'upstream'
          ? `${finding.issuer} is degraded across the network`
          : `${finding.issuer} is degraded on this account only`,
      severity: network.verdict === 'upstream' ? 'network' : 'high',
      amountAtRisk: finding.amountAtRisk,
      detection: finding,
      network,
      diagnosis,
      paymentIds: finding.failureIds,
      openedAt: store.meta.clock,
    });
  }

  // --- 2. Recurring charge failures -----------------------------------------
  const recurring = detectRecurringFailures(merchantId);
  if (recurring) {
    let diagnosis = diagnoseRecurring(recurring, merchant);
    diagnosis = await polishNarrative(diagnosis, `Recurring charge failures for ${merchant.name}`);
    investigations.push({
      id: newInvestigationId(),
      merchantId,
      leakType: 'recurring',
      title: `${recurring.count} recurring charges failed`,
      severity: 'high',
      amountAtRisk: recurring.amountAtRisk,
      detection: recurring,
      network: null,
      diagnosis,
      paymentIds: recurring.paymentIds,
      openedAt: store.meta.clock,
    });
  }

  // --- 3. Stranded money -----------------------------------------------------
  const stranded = detectStrandedPayments(merchantId);
  if (stranded.orphans.length || stranded.expiring.length) {
    let diagnosis = diagnoseStranded(stranded, merchant);
    diagnosis = await polishNarrative(diagnosis, `Stranded payments for ${merchant.name}`);
    investigations.push({
      id: newInvestigationId(),
      merchantId,
      leakType: 'stranded',
      title: `${stranded.orphans.length + stranded.expiring.length} payments stranded between bank and merchant`,
      severity: 'critical',
      amountAtRisk: stranded.orphanAmount + stranded.expiringAmount,
      detection: stranded,
      network: null,
      diagnosis,
      paymentIds: [...stranded.orphans.map((o) => o.id), ...stranded.expiring.map((e) => e.id)],
      openedAt: store.meta.clock,
    });
  }

  store.investigations = investigations;

  // --- 4. Plan a recovery for every affected payment -------------------------
  for (const inv of investigations) {
    // The instrument is degraded right now regardless of whose fault it is.
    // A retry on a bank that is failing 40% of attempts fails at 40% whether the
    // cause is the bank or the merchant's own checkout. The cause changes the
    // recommended fix, not the odds on an immediate retry.
    const outageActive = inv.leakType.startsWith('instrument_degradation');
    for (const pid of inv.paymentIds) {
      const payment = store.paymentsById.get(pid);
      if (!payment) continue;
      const leakType =
        inv.leakType === 'stranded'
          ? payment.status === 'authorized'
            ? 'stranded_expiring'
            : 'stranded_orphan'
          : inv.leakType === 'recurring'
            ? 'recurring'
            : 'degradation';
      const candidate = planRecovery(payment, { outageActive, leakType, investigationId: inv.id });
      candidate.policy = evaluate(candidate);

      // Carry forward any resolution from a previous cycle. Candidates are
      // rebuilt fresh every cycle with new ids, but the ACTIONS taken on a
      // payment persist. Without this, a payment that was already approved,
      // recovered, or rejected would reappear as an un-actioned candidate after
      // any refresh or restart — letting it be approved a second time and
      // sending a duplicate email. We key on paymentId, which is stable.
      const priorAction = store.actions.find((a) => a.paymentId === payment.id);
      if (priorAction) {
        candidate.actionId = priorAction.id;
        if (priorAction.recovered) {
          candidate.resolved = { by: priorAction.recoveredVia || 'system', at: priorAction.recoveredAt, outcome: 'recovered' };
        } else if (priorAction.expired) {
          candidate.resolved = { by: 'system', at: priorAction.expiredAt, outcome: 'not_recovered', reason: 'link expired' };
        } else if (priorAction.pending) {
          candidate.resolved = { by: priorAction.approvedBy || 'merchant', at: priorAction.executedAt, outcome: 'pending' };
        } else if (priorAction.error) {
          candidate.resolved = { by: 'system', at: priorAction.executedAt, outcome: 'not_recovered', reason: 'action errored' };
        } else {
          // An action ran and settled without recovering (e.g. fake path).
          candidate.resolved = { by: priorAction.approvedBy || 'merchant', at: priorAction.executedAt, outcome: priorAction.recovered ? 'recovered' : 'not_recovered' };
        }
      } else {
        // A prior rejection has no action but was recorded in the ledger.
        const priorReject = store.ledger.find((e) => e.type === 'rejected' && e.paymentId === payment.id);
        if (priorReject) {
          candidate.resolved = { by: 'merchant', at: priorReject.at || store.meta.clock, outcome: 'rejected', reason: priorReject.reason };
        }
      }

      store.candidates.push(candidate);
      store.record({
        type: 'decision',
        candidateId: candidate.id,
        investigationId: inv.id,
        paymentId: candidate.paymentId,
        leakType,
        amount: candidate.amount,
        declineClass: candidate.declineClass,
        chosenAction: candidate.chosen.action,
        modelProbability: candidate.chosen.probability,
        expectedValue: candidate.chosen.expectedValue,
        arm: candidate.arm,
        verdict: candidate.policy.verdict,
        rule: candidate.policy.rule,
        reason: candidate.policy.reason,
        foregoneValue: candidate.policy.foregoneValue,
      });
    }
  }

  // --- 5. Act, within the boundary ------------------------------------------
  // The holdout splits only the population the system would actually act on.
  //
  // Running the control arm across every candidate while the treatment arm only
  // gets the auto-approved ones would compare two different populations and
  // report the difference as lift. The question being asked is narrower and
  // answerable: among the actions this system chooses to take, does picking the
  // channel and the timing beat retrying immediately every time?
  if (autoExecute) {
    for (const c of store.candidates) {
      if (c.policy.verdict !== 'AUTO') continue;
      const rec = c.arm === 'control' ? await executeControl(c) : await execute(c);
      if (!rec) {
        store.record({
          type: 'execution_skipped',
          candidateId: c.id,
          paymentId: c.paymentId,
          note: 'execute() returned no record — likely a stale idempotency replay with no matching action after a data reset. Skipped verification for this cycle.',
        });
        continue;
      }
      await verify(rec);
    }
  }

  store.meta.lastCycleAt = new Date().toISOString();
  store.meta.cycles += 1;
  store.persist();

  return summarise(merchantId);
}

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Expire pending real recoveries older than 24 hours.
 *
 * When a real payment link is created it stays pending until the shopper pays
 * it (webhook flips it to recovered) or it goes stale. Without an expiry the
 * queue would wait forever. With one, an unpaid link is closed after 24h: the
 * action becomes not_recovered, the candidate resolves as expired, and the
 * matching email is flipped to "expired" so the simulator shows the link is
 * dead. Fake payments are never touched here — they resolve instantly.
 */
function expireStalePendingActions() {
  const now = Date.now();
  for (const action of store.actions) {
    if (!action.pending || action.recovered) continue;
    const age = now - new Date(action.executedAt).getTime();
    if (age < PENDING_TTL_MS) continue;

    action.pending = false;
    action.expired = true;
    action.expiredAt = new Date().toISOString();

    const candidate = store.candidates.find((c) => c.id === action.candidateId);
    if (candidate) {
      candidate.resolved = { by: 'system', at: action.expiredAt, outcome: 'not_recovered', reason: 'link expired unpaid after 24h' };
    }
    expireEmailFor(action.candidateId);

    store.record({
      type: 'recovery_link_expired',
      candidateId: action.candidateId,
      paymentId: action.paymentId,
      actionId: action.id,
      amount: action.amount,
      note: 'A real recovery link went unpaid for 24 hours and was expired.',
    });
  }
}

/**
 * Reconcile pending real recoveries by asking Razorpay directly.
 *
 * The webhook path is the real-time way to learn a link was paid, but it needs
 * a public tunnel. When there is no tunnel — which is the common case in a
 * local demo — a paid link would otherwise sit "pending" forever. This function
 * is the pull-side equivalent: it lists the account's payment links, finds the
 * ones matching our still-pending actions, and closes any that Razorpay reports
 * as paid. Same outcome as the webhook, just polled instead of pushed.
 *
 * Runs on every sync and on a light poll from the Emails/Queue views, so the
 * moment a shopper pays, the next sync flips it to recovered — no webhook, no
 * tunnel required.
 */
export async function reconcilePayments() {
  const pendingActions = store.actions.filter((a) => a.pending && !a.recovered);
  if (!pendingActions.length) return { checked: 0, recovered: 0 };

  let list;
  try {
    list = await razorpay.fetchPaymentLinks({ count: 100 });
  } catch (e) {
    return { checked: 0, recovered: 0, error: e.message };
  }
  const links = list.payment_links || list.items || [];

  // Index links by both their id and their reference_id (which we set to the
  // candidate id at creation), so either can match an action.
  const byRef = new Map();
  const byId = new Map();
  for (const l of links) {
    if (l.reference_id) byRef.set(l.reference_id, l);
    if (l.id) byId.set(l.id, l);
  }

  let recovered = 0;
  for (const action of pendingActions) {
    const link =
      byId.get(action.gatewayResponse?.id) ||
      byId.get(action.emailLinkId) ||
      byRef.get(action.candidateId);
    if (!link) continue;

    if (link.status === 'paid') {
      action.pending = false;
      action.recovered = true;
      action.recoveredAmount = link.amount_paid ?? link.amount ?? action.amount;
      action.recoveredAt = new Date().toISOString();
      action.recoveredVia = 'reconcile_poll';
      const candidate = store.candidates.find((c) => c.id === action.candidateId);
      if (candidate) candidate.resolved = { by: 'reconcile', at: action.recoveredAt, outcome: 'recovered' };
      markEmailPaid(action.candidateId);
      recovered += 1;
      store.record({
        type: 'recovery_confirmed',
        candidateId: action.candidateId,
        paymentId: action.paymentId,
        actionId: action.id,
        linkId: link.id,
        amount: action.recoveredAmount,
        note: 'Recovery confirmed by polling Razorpay (no webhook needed).',
      });
    } else if (link.status === 'expired' || link.status === 'cancelled') {
      action.pending = false;
      action.expired = true;
      action.expiredAt = new Date().toISOString();
      const candidate = store.candidates.find((c) => c.id === action.candidateId);
      if (candidate) candidate.resolved = { by: 'reconcile', at: action.expiredAt, outcome: 'not_recovered', reason: `link ${link.status}` };
      expireEmailFor(action.candidateId);
    }
  }

  if (recovered) store.markRealDirty();
  return { checked: pendingActions.length, recovered };
}

/** Approve a candidate the policy engine sent for review. */
export async function approveCandidate(candidateId, { action = null, approvedBy = 'merchant' } = {}) {
  const c = store.candidates.find((x) => x.id === candidateId);
  if (!c) return { error: 'candidate not found' };
  if (c.policy.verdict === 'BLOCK') return { error: 'blocked candidates cannot be approved without a policy change' };

  // Guard: never act twice on the same payment. If an action already exists for
  // this payment (from a previous approval, before a refresh rebuilt the
  // candidate), return that action instead of creating a second one. This is
  // what stops a duplicate recovery email being sent when the same recovered
  // payment is re-approved after a page refresh or restart.
  const existingAction = store.actions.find((a) => a.paymentId === c.paymentId);
  if (existingAction) {
    c.resolved = c.resolved || {
      by: existingAction.approvedBy || 'merchant',
      at: existingAction.recoveredAt || existingAction.executedAt,
      outcome: existingAction.recovered ? 'recovered' : existingAction.pending ? 'pending' : existingAction.expired ? 'not_recovered' : 'not_recovered',
    };
    return { ...existingAction, alreadyActioned: true };
  }

  const rec = await execute(c, { approvedBy, overrideAction: action });
  await verify(rec);
  // A real payment that just had a link created is not "not recovered" — it is
  // waiting for the shopper to pay. Only a fake payment gets an immediate
  // recovered/not-recovered verdict; a real one stays pending until its webhook
  // arrives (paid) or its link expires after 24h.
  c.resolved = {
    by: approvedBy,
    at: new Date().toISOString(),
    outcome: rec.pending ? 'pending' : rec.recovered ? 'recovered' : 'not_recovered',
  };

  // Recovery email simulation.
  //
  // Whether an email goes out is decided by recoverabilityFor(), not by which
  // action the planner picked:
  //   - retry / try_another_method  -> email the shopper a link
  //   - none (mandate / terminal)   -> no email, with a stated reason
  //
  // For the try-another-method case (e.g. expired card) the planner may not have
  // produced a link, so we mint one here specifically for the email, because the
  // shopper genuinely can complete the order with a different instrument.
  const payment = store.paymentsById.get(c.paymentId);
  const isReal = payment?.source === 'razorpay';
  const check = recoverabilityFor(c);

  const alreadyEmailed = store.emails.some((e) => e.paymentId === c.paymentId);
  if (check.emailable && !rec.error && !alreadyEmailed) {
    let link = rec.recoveryLink;
    if (!link) {
      // No link from the action itself — create one just for the email.
      try {
        const made = await razorpay.createPaymentLink({
          amount: c.amount,
          customerName: c.customerName || 'Customer',
          description: `Complete your ${rupees(c.amount)} order`,
          referenceId: c.id,
          idempotencyKey: `rw:email:${c.paymentId}:v${store.policy.version}`,
        });
        link = made?.short_url || null;
        if (made?.id) rec.emailLinkId = made.id;
      } catch (e) {
        rec.emailLinkError = e.message;
      }
    }
    if (link || !isReal) {
      const email = composeRecoveryEmail(c, {
        link: link || 'https://rzp.io/i/simulated-demo-link',
        real: isReal,
        actionId: rec.id,
        variant: check.variant,
      });
      rec.emailId = email.id;
      rec.emailedTo = email.to;
      rec.emailVariant = check.variant;
    }
  } else if (!check.emailable) {
    rec.emailSkipped = check.reason;
  }

  store.persist();
  return rec;
}

export function rejectCandidate(candidateId, { reason = 'merchant declined' } = {}) {
  const c = store.candidates.find((x) => x.id === candidateId);
  if (!c) return { error: 'candidate not found' };
  c.resolved = { by: 'merchant', at: new Date().toISOString(), outcome: 'rejected', reason };
  store.record({ type: 'rejected', candidateId, paymentId: c.paymentId, reason, foregoneValue: c.chosen.expectedValue });
  store.persist();
  return c;
}

/** The leak map, the safety ledger, and the lift readout. */
export function summarise(merchantId = config.focusMerchantId) {
  const clock = store.meta.clock ? new Date(store.meta.clock).getTime() : Date.now();

  // Real-data mode: if any real Razorpay payments exist for this merchant, the
  // leak map is about the real account, so the river must reflect real captured
  // revenue only. Otherwise a clean/healthy day would still show ~13k synthetic
  // payments as "processed", which is a lie next to a handful of real ones.
  // With no real payments at all, we fall back to the synthetic stream so the
  // demo's leak map still has a river to show.
  const realForMerchant = store.payments.filter(
    (p) => p.merchantId === merchantId && p.source === 'razorpay'
  );
  const realMode = realForMerchant.length > 0;

  // Processed revenue for the river. Split by source (real vs synthetic) via
  // realMode, but NOT time-boxed: the previous `clock - 24h` cutoff meant any
  // captured payment older than a day silently vanished from "processed", so a
  // test-mode account whose payments span several days showed only the last
  // day's captures. Every captured payment in the active stream now counts.
  const dayPayments = store.payments.filter(
    (p) =>
      p.merchantId === merchantId &&
      (realMode ? p.source === 'razorpay' : p.source !== 'razorpay')
  );
  const processed = sum(dayPayments.filter((p) => p.status === 'captured'), (p) => p.amount);

  const byLeak = new Map();
  for (const c of store.candidates) {
    const key = c.leakType;
    if (!byLeak.has(key)) byLeak.set(key, { leakType: key, atRisk: 0, recoverable: 0, count: 0 });
    const row = byLeak.get(key);
    row.atRisk += c.amount;
    row.count += 1;
    if (c.policy.verdict !== 'BLOCK') row.recoverable += c.chosen.expectedValue;
  }

  const atRisk = sum(store.candidates, (c) => c.amount);
  const recoverable = sum(store.candidates.filter((c) => c.policy.verdict !== 'BLOCK'), (c) => c.chosen.expectedValue);
  const recovered = sum(store.actions, (a) => a.recoveredAmount);

  // Face-value buckets for the flow diagram. Every stream has to be the same
  // kind of number: mixing face value with expected value in one picture makes
  // the widths incomparable and the picture a lie.
  const actedIds = new Set(store.actions.map((a) => a.candidateId));
  const flow = {
    recovered: sum(store.actions.filter((a) => a.recovered), (a) => a.amount),
    attemptedNotRecovered: sum(store.actions.filter((a) => !a.recovered), (a) => a.amount),
    awaiting: sum(
      store.candidates.filter((c) => c.policy.verdict !== 'BLOCK' && !actedIds.has(c.id)),
      (c) => c.amount
    ),
    blocked: sum(store.candidates.filter((c) => c.policy.verdict === 'BLOCK'), (c) => c.amount),
  };

  const verdicts = store.candidates.reduce((acc, c) => {
    acc[c.policy.verdict] = (acc[c.policy.verdict] || 0) + 1;
    return acc;
  }, {});

  const blocked = store.candidates.filter((c) => c.policy.verdict === 'BLOCK');
  const blockedByRule = [...new Map(
    blocked.map((c) => [c.policy.rule, { rule: c.policy.rule, count: 0, foregone: 0 }])
  ).values()];
  for (const c of blocked) {
    const row = blockedByRule.find((r) => r.rule === c.policy.rule);
    row.count += 1;
    row.foregone += c.policy.foregoneValue;
  }

  const arms = armTotals();
  const controlRate = arms.control.n ? arms.control.recovered / arms.control.n : 0;
  const treatmentRate = arms.treatment.n ? arms.treatment.recovered / arms.treatment.n : 0;
  const test = twoProportionTest(arms.control.recovered, arms.control.n, arms.treatment.recovered, arms.treatment.n);
  // Value the treatment arm would have produced at the control arm's rate.
  const counterfactual = Math.round(arms.treatment.exposed * (arms.control.amount / (arms.control.exposed || 1)));

  return {
    merchantId,
    clock: store.meta.clock,
    leakMap: {
      processed,
      atRisk,
      recoverable,
      recovered,
      flow,
      byLeak: [...byLeak.values()].sort((a, b) => b.atRisk - a.atRisk),
    },
    investigations: store.investigations.map((i) => ({
      id: i.id,
      leakType: i.leakType,
      title: i.title,
      severity: i.severity,
      amountAtRisk: i.amountAtRisk,
      summary: i.diagnosis.summary,
      verdict: i.diagnosis.verdict,
      candidateCount: store.candidates.filter((c) => c.investigationId === i.id).length,
    })),
    safety: {
      verdicts,
      blockedByRule: blockedByRule.sort((a, b) => b.foregone - a.foregone),
      totalForegone: sum(blocked, (c) => c.policy.foregoneValue),
      unauthorisedActions: store.actions.filter((a) => a.approvedBy === 'unknown').length,
    },
    experiment: {
      holdoutFraction: config.holdoutFraction,
      control: { ...arms.control, rate: controlRate },
      treatment: { ...arms.treatment, rate: treatmentRate },
      absoluteLift: treatmentRate - controlRate,
      relativeLift: controlRate ? (treatmentRate - controlRate) / controlRate : null,
      incrementalAmount: arms.treatment.amount - counterfactual,
      counterfactualAmount: counterfactual,
      significance: test,
      // A single day rarely reaches significance, and saying so is the point.
      // A product that reports "+50%" off forty attempts is reporting noise.
      requiredNPerArm: requiredSampleSize(controlRate, treatmentRate),
    },
    detectionScore: scoreDetection(),
    model: store.model
      ? {
        brier: store.model.brier,
        skillScore: store.model.skillScore,
        trainedOn: store.model.trainedOn,
        testedOn: store.model.testedOn,
        topFeatures: store.model.features.slice(0, 6),
        calibration: store.model.calibration,
      }
      : null,
  };
}

/**
 * Sample size per arm to detect the currently observed effect at 80% power and
 * 5% alpha. Rendered next to the lift figure so nobody reads a first-day number
 * as a result.
 */
function requiredSampleSize(p1, p2) {
  if (!p1 || !p2 || p1 === p2) return null;
  const zA = 1.96;
  const zB = 0.84;
  const pBar = (p1 + p2) / 2;
  const n =
    ((zA * Math.sqrt(2 * pBar * (1 - pBar)) + zB * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2) /
    (p2 - p1) ** 2;
  return Math.ceil(n);
}

/**
 * Detection scored against the leaks that were actually planted.
 *
 * This is the number a reviewer should ask for, and it is uncomfortable to
 * publish, which is the point. A demo that only shows what it caught is not
 * evidence of anything.
 */
export function scoreDetection() {
  const truth = store.groundTruth.plantedLeaks;
  const found = store.investigations;
  const results = [];

  for (const t of truth) {
    let matched = null;
    if (t.kind === 'network_issuer_outage' || t.kind === 'merchant_local_degradation') {
      matched = found.find((f) => f.detection?.issuer === t.issuer);
      const verdictOk = matched
        ? (t.expectVerdict === 'upstream' && matched.network?.verdict === 'upstream') ||
        (t.expectVerdict === 'merchant_local' && matched.network?.verdict === 'merchant_local')
        : false;
      results.push({
        groundTruth: t.id,
        kind: t.kind,
        issuer: t.issuer,
        detected: !!matched,
        causeCorrect: verdictOk,
        detail: matched
          ? `Change point found at ${new Date(matched.detection.changePoint).toISOString()}, planted at ${t.startsAt}`
          : 'missed',
      });
    } else if (t.kind === 'recurring_failures') {
      matched = found.find((f) => f.leakType === 'recurring');
      results.push({
        groundTruth: t.id,
        kind: t.kind,
        detected: !!matched,
        causeCorrect: matched ? matched.detection.count === t.count : false,
        detail: matched ? `${matched.detection.count} of ${t.count} planted` : 'missed',
      });
    } else if (t.kind === 'orphan_captured' || t.kind === 'authorized_not_captured') {
      matched = found.find((f) => f.leakType === 'stranded');
      const n = matched
        ? t.kind === 'orphan_captured'
          ? matched.detection.orphans.length
          : matched.detection.expiring.length
        : 0;
      results.push({
        groundTruth: t.id,
        kind: t.kind,
        detected: n > 0,
        causeCorrect: n === t.count,
        detail: matched ? `${n} of ${t.count} planted` : 'missed',
      });
    }
  }

  const detected = results.filter((r) => r.detected).length;
  // Anything raised that does not map to a planted leak is a false positive.
  const mappedTitles = new Set();
  for (const r of results) if (r.issuer) mappedTitles.add(r.issuer);
  const falsePositives = found.filter(
    (f) => f.detection?.issuer && !mappedTitles.has(f.detection.issuer)
  ).length;

  return {
    plantedLeaks: truth.length,
    detected,
    recall: truth.length ? detected / truth.length : 0,
    precision: found.length ? (found.length - falsePositives) / found.length : 1,
    falsePositives,
    causeAccuracy: results.length ? results.filter((r) => r.causeCorrect).length / results.length : 0,
    results,
  };
}