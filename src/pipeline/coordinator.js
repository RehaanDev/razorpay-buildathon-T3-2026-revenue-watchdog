import { store } from '../store.js';
import { config, DECLINE_TAXONOMY, ISSUER_CAPACITY } from '../config.js';
import { predictRecovery } from './model.js';
import { correlateAcrossNetwork } from './detectors.js';
import { estimateCapacity } from './capacity.js';
import { sum, groupBy } from '../lib/util.js';

/**
 * Retry congestion control.
 *
 * This is the part of the system that only a payment gateway could build, and
 * the reason is a coordination failure that every individual merchant is
 * powerless to fix.
 *
 * When an issuer degrades, every merchant's dunning logic notices at roughly the
 * same moment and starts retrying. None of them can see each other. So a bank
 * that is already struggling receives a synchronised burst of retry traffic from
 * thousands of merchants at once, on top of its organic load. The retries make
 * the outage deeper and longer, every merchant's success rate drops further, and
 * the queue grows. Each merchant behaved rationally. Collectively they made
 * their own problem worse.
 *
 * A merchant-side tool cannot solve this. It has exactly one lever, its own
 * retries, and unilaterally holding back just means it recovers less while
 * everyone else still stampedes. The only place the problem is solvable is the
 * layer that can see all the merchants at once.
 *
 * So this scheduler does three things a single-merchant retry loop cannot:
 *
 *   - Meters total retry traffic to a degraded issuer against an estimated
 *     capacity, network-wide.
 *   - Spreads attempts across time slots instead of firing them together.
 *   - Allocates the scarce early slots by expected value, so the highest-value
 *     recoveries go first rather than whoever happened to run their cron job
 *     at :00.
 *
 * WHAT IS MODELLED VS MEASURED
 *
 * The congestion response below is a model, not an observation. Real issuer
 * behaviour under load is not published and would have to be learned from
 * production traffic. What is defensible here is the shape: success probability
 * degrades as offered load exceeds capacity, and it degrades faster once the
 * queue starts building. The parameters live in config.js as
 * `ISSUER_CAPACITY` and are explicitly labelled as assumptions. The comparison
 * is honest because both arms use the same model; what is being demonstrated is
 * that scheduling beats not scheduling under any plausible congestion curve,
 * not that a particular number of attempts per minute is correct.
 */

const SLOT_MINUTES = 1;

/**
 * Degradation of per-attempt success probability as offered load exceeds
 * capacity. At or below capacity there is no penalty. Above it, the multiplier
 * falls off superlinearly: an overloaded issuer does not fail gracefully, it
 * starts timing out, and timeouts consume capacity without completing work.
 */
export function congestionMultiplier(load, capacity) {
  if (capacity <= 0) return 1;
  const ratio = load / capacity;
  if (ratio <= 1) return 1;
  const excess = ratio - 1;
  return 1 / (1 + excess * excess * 1.6 + excess * 0.9);
}

/**
 * Capacity for an issuer.
 *
 * Prefers an estimate learned from observed traffic; falls back to the
 * documented assumption when the traffic could not identify one. The returned
 * object carries `learned` and `source` either way, so every surface that shows
 * a capacity figure can also show where it came from. Nothing downstream is
 * allowed to display the number without the provenance.
 *
 * Imported lazily to keep the module cycle (capacity.js needs
 * congestionMultiplier from here) from biting at load time.
 */
function capacityFor(issuer) {
  try {
    return estimateCapacity(issuer);
  } catch {
    return { ...(ISSUER_CAPACITY[issuer] || ISSUER_CAPACITY.default), learned: false };
  }
}

/**
 * Every failed payment across the whole network that is waiting on this issuer
 * and could legitimately be retried.
 *
 * Deliberately network-wide. A merchant asking "how many of MY payments are
 * queued" gets a number that cannot tell them anything about congestion, because
 * congestion is caused by everyone else.
 */
export function pendingRetriesFor(issuer, { windowHours = 2 } = {}) {
  const since = new Date(store.meta.clock).getTime() - windowHours * 36e5;
  const rows = store.payments.filter(
    (p) =>
      p.issuer === issuer &&
      p.status === 'failed' &&
      new Date(p.createdAt).getTime() >= since &&
      (DECLINE_TAXONOMY[p.errorCode]?.retryable ?? true)
  );

  return rows.map((p) => {
    const customer = store.customers.get(p.customerId);
    const probability = predictRecovery({
      errorCode: p.errorCode || 'GATEWAY_ERROR',
      amount: p.amount,
      priorSuccessRate: customer?.priorSuccessRate ?? 0.5,
      priorFailedAttempts: (customer?.priorFailures ?? 0) + ((p.attemptNo ?? 1) - 1),
      contactsLast30d: customer?.contactsLast30d ?? 0,
      inSuccessWindow: false,
      outageActive: true,
      action: 'retry',
    });
    return {
      paymentId: p.id,
      merchantId: p.merchantId,
      amount: p.amount,
      baseProbability: probability,
      expectedValue: probability * p.amount,
    };
  });
}

/** What the agent's check_congestion tool reports. */
export function assessCongestion(issuer) {
  const pending = pendingRetriesFor(issuer);
  const capacity = capacityFor(issuer);
  const byMerchant = groupBy(pending, (r) => r.merchantId);
  const network = pending.length
    ? correlateAcrossNetwork(issuer, new Date(new Date(store.meta.clock).getTime() - 36e5).toISOString())
    : null;

  const load = pending.length;
  const multiplier = congestionMultiplier(load, capacity.attemptsPerMinute);

  return {
    issuer,
    pending_retries_network_wide: load,
    merchants_with_queued_retries: byMerchant.size,
    per_merchant: [...byMerchant.entries()].map(([mid, rows]) => ({
      merchant: store.merchants.find((m) => m.id === mid)?.name || mid,
      queued: rows.length,
      amount_paise: sum(rows, (r) => r.amount),
    })),
    estimated_issuer_capacity_per_minute: capacity.attemptsPerMinute,
    capacity_source: capacity.source,
    // Provenance travels with the number. An agent that can read a capacity
    // figure without being told whether it was measured or assumed will state
    // it as fact, which is the failure mode this whole system is built around.
    capacity_is_measured: capacity.learned === true,
    capacity_confidence_interval: capacity.interval || null,
    capacity_caveat: capacity.learned
      ? 'Estimated from observed traffic. The interval is a 90% bootstrap over minute-buckets; quote it alongside the point estimate.'
      : `NOT measured. This is the configured assumption because ${capacity.reason || 'the traffic could not identify a capacity'}. Do not present it as an observation.`,
    if_everyone_retries_at_once: {
      offered_load: load,
      success_multiplier: Number(multiplier.toFixed(3)),
      interpretation:
        multiplier < 0.75
          ? 'Simultaneous retry would push offered load well past estimated capacity and materially reduce the success rate of every attempt, including attempts from merchants that did nothing wrong.'
          : multiplier < 0.95
            ? 'Simultaneous retry would exceed estimated capacity and modestly depress success rates network-wide.'
            : 'Current queue is within estimated capacity. Coordination buys little here.',
    },
    network_verdict: network?.verdict ?? 'unknown',
    fairness: fairnessCurve(issuer),
    note:
      'Both scheduling arms use the same capacity figure and the same congestion curve, so the comparison between them holds regardless of whether that figure was measured or assumed. What the figure being assumed does affect is the absolute claim about how much load the issuer can take — that one is only as good as its source, which is reported above.',
  };
}

/* ------------------------------------------------------------- scheduling -- */

/**
 * Uncoordinated: what happens today. Every merchant's retry logic fires as soon
 * as it notices, so everything lands in the first slot.
 */
function scheduleUncoordinated(pending) {
  return pending.map((r) => ({ ...r, slot: 0 }));
}

/**
 * Coordinated: a shared token bucket for the issuer.
 *
 * Highest expected value first, because the early slots are the scarce resource
 * and the queue may not drain before the customer gives up. Then a per-merchant
 * cap inside each slot, so one high-volume merchant cannot monopolise the
 * window and starve everyone else — fairness is not decoration here, it is the
 * reason the other merchants would tolerate being metered at all.
 */
function scheduleCoordinated(pending, capacity, { slots = 30, fairnessFloor = config.fairnessFloor ?? 0 } = {}) {
  // Pure expected value is not a neutral default, it is a policy.
  //
  // `probability × amount` means a ₹50,000 order from a large merchant takes an
  // early slot ahead of a ₹200 order every single time. During a long outage
  // that is not a tie-break, it is a rule that the smallest merchants on the
  // network are served last and, if the queue never drains, not at all. The
  // gateway is metering traffic those merchants did not create; being throttled
  // into last place as well is the thing that would make coordination
  // politically impossible to actually ship.
  //
  // `fairnessFloor` is the number of attempts every merchant is guaranteed in
  // every slot. Reserving that room for everyone else is what caps how much of
  // a slot any one merchant may take:
  //
  //   floor 0  -> no cap. Pure expected value. Maximum rupees, worst coverage.
  //   floor k  -> a merchant may take at most perSlot - k*(others) attempts,
  //               so every other merchant still fits.
  //
  // The dial is not set here. `fairnessCurve()` sweeps it and publishes what
  // each setting costs in recovered rupees, so the chosen value is an argued
  // number rather than a constant someone picked and never revisited.
  const queue = [...pending].sort((a, b) => b.expectedValue - a.expectedValue);
  const merchants = new Set(pending.map((p) => p.merchantId)).size;
  const perSlot = Math.max(1, Math.floor(capacity.attemptsPerMinute * capacity.retryShare));
  const perMerchantPerSlot = fairnessFloor <= 0
    ? perSlot
    : Math.max(1, perSlot - fairnessFloor * Math.max(0, merchants - 1));

  // Fill each slot by walking the remaining queue and taking the best item
  // whose merchant has not yet hit its per-slot cap.
  //
  // The obvious implementation — walk the queue once and advance a slot
  // whenever the current item does not fit — is wrong, and wrong in a way that
  // is easy to miss because the output still looks like a schedule. When a
  // high-volume merchant hits its cap, advancing the slot abandons the
  // remaining capacity in that slot even though other merchants had attempts
  // waiting that would have fit. That discarded most of the window and cost
  // roughly a fifth of recoverable value. It surfaced only because a fairness
  // floor that was supposed to cost recovery was improving it: interleaving
  // happened to route around the bug. A knob behaving backwards is worth
  // chasing down rather than reversing the sign on.
  const out = [];
  const remaining = queue.map((item) => ({ item, taken: false }));
  let placed = 0;

  for (let slot = 0; slot < slots && placed < remaining.length; slot++) {
    let inSlot = 0;
    const merchantCount = new Map();

    for (const entry of remaining) {
      if (entry.taken) continue;
      if (inSlot >= perSlot) break;
      const used = merchantCount.get(entry.item.merchantId) || 0;
      if (used >= perMerchantPerSlot) continue; // skip this one, not the whole slot
      out.push({ ...entry.item, slot });
      merchantCount.set(entry.item.merchantId, used + 1);
      entry.taken = true;
      inSlot += 1;
      placed += 1;
    }
  }

  for (const entry of remaining) {
    if (!entry.taken) out.push({ ...entry.item, slot: null, deferred: true });
  }
  return out;
}

/**
 * Scores a schedule under the congestion model.
 *
 * Organic (non-retry) traffic is included in the offered load, because the
 * issuer does not distinguish a retry from a first attempt and neither should
 * the capacity calculation.
 */
function scoreSchedule(schedule, capacity) {
  const bySlot = groupBy(schedule.filter((s) => s.slot != null), (s) => s.slot);
  const organic = capacity.organicPerMinute;

  let expectedRecovered = 0;
  let attempts = 0;
  const slots = [];

  for (const [slot, rows] of [...bySlot.entries()].sort((a, b) => a[0] - b[0])) {
    const load = rows.length + organic;
    const multiplier = congestionMultiplier(load, capacity.attemptsPerMinute);
    const slotRecovered = sum(rows, (r) => r.baseProbability * multiplier * r.amount);
    expectedRecovered += slotRecovered;
    attempts += rows.length;
    slots.push({
      slot,
      minute: slot * SLOT_MINUTES,
      attempts: rows.length,
      offeredLoad: load,
      successMultiplier: Number(multiplier.toFixed(3)),
      expectedRecovered: Math.round(slotRecovered),
    });
  }

  const deferred = schedule.filter((s) => s.slot == null);

  return {
    attempts,
    deferred: deferred.length,
    expectedRecovered: Math.round(expectedRecovered),
    spanMinutes: slots.length ? slots[slots.length - 1].minute + SLOT_MINUTES : 0,
    worstMultiplier: slots.length ? Math.min(...slots.map((s) => s.successMultiplier)) : 1,
    slots,
  };
}

/**
 * The headline comparison. Same payments, same model, same congestion curve.
 * The only difference is whether anyone is coordinating.
 */
export function compareSchedules(issuer) {
  const pending = pendingRetriesFor(issuer);
  const capacity = capacityFor(issuer);

  if (!pending.length) {
    return {
      issuer,
      pending: 0,
      note: 'Nothing is queued for this issuer right now. Trigger a network-wide degradation in the control room first.',
    };
  }

  const uncoordinated = scoreSchedule(scheduleUncoordinated(pending), capacity);
  const coordinated = scoreSchedule(scheduleCoordinated(pending, capacity), capacity);

  const delta = coordinated.expectedRecovered - uncoordinated.expectedRecovered;

  return {
    issuer,
    pending: pending.length,
    merchantsInvolved: new Set(pending.map((p) => p.merchantId)).size,
    faceValueQueued: sum(pending, (p) => p.amount),
    capacity,
    uncoordinated,
    coordinated,
    delta,
    deltaPct: uncoordinated.expectedRecovered
      ? Number(((delta / uncoordinated.expectedRecovered) * 100).toFixed(1))
      : null,
    assumptions: [
      `Issuer capacity is assumed at ${capacity.attemptsPerMinute} attempts/minute with ${capacity.organicPerMinute} organic attempts/minute already arriving. Source: ${capacity.source}.`,
      'Success probability degrades superlinearly once offered load exceeds capacity. The functional form is an assumption; the direction is not.',
      'Both arms use identical per-payment base probabilities from the fitted model. Only the arrival schedule differs.',
      'Customer patience is not modelled. In reality, deferring an attempt costs something, which would narrow the gap. This comparison therefore overstates the coordinated arm slightly.',
    ],
  };
}

/**
 * How well the smallest merchant on the network is served.
 *
 * Reported as the minimum, across merchants, of the fraction of that merchant's
 * queue that lands in the first quarter of the scheduling window. A network
 * where one merchant gets nothing early scores 0 no matter how much total value
 * it recovers, which is the point: the aggregate figure is exactly the number
 * that hides this.
 */
function worstServedMerchant(schedule, spanSlots) {
  const cutoff = Math.max(1, Math.ceil(spanSlots / 4));
  const byMerchant = groupBy(schedule, (s) => s.merchantId);
  let worst = 1;
  let who = null;
  for (const [mid, rows] of byMerchant) {
    const early = rows.filter((s) => s.slot != null && s.slot < cutoff).length;
    const share = early / rows.length;
    if (share < worst) {
      worst = share;
      who = mid;
    }
  }
  return { share: Number(worst.toFixed(3)), merchantId: who };
}

/**
 * The fairness/recovery trade-off, published rather than assumed.
 *
 * Sweeps the per-merchant floor and reports what each setting costs. This exists
 * because "we allocate by expected value" sounds like an optimisation and is
 * actually a distributional choice, and the only honest way to make a
 * distributional choice is to show the curve and say where on it you sat and
 * why. A reviewer who disagrees with the chosen floor can read the cost of
 * their preferred one off the same table.
 */
export function fairnessCurveFor(pending, capacity, { maxFloor = 6 } = {}) {
  const points = [];

  // A floor is only meaningful while it is feasible. Guaranteeing every
  // merchant k attempts per slot requires k * merchants <= perSlot; past that
  // the guarantee cannot be honoured, the cap clamps to 1, and slots go out
  // part-empty — fairness and recovery both get worse. Sweeping into that
  // region would print a curve that turns back on itself and invite the reader
  // to conclude the trade-off is non-monotone, when really the constraint was
  // simply unsatisfiable. So the sweep stops where feasibility does.
  const merchants = new Set(pending.map((p) => p.merchantId)).size;
  const perSlot = Math.max(1, Math.floor(capacity.attemptsPerMinute * capacity.retryShare));
  const maxFeasible = Math.max(0, Math.floor(perSlot / Math.max(1, merchants)));
  const top = Math.min(maxFloor, maxFeasible);

  for (let floor = 0; floor <= top; floor++) {
    const schedule = scheduleCoordinated(pending, capacity, { fairnessFloor: floor });
    const scored = scoreSchedule(schedule, capacity);
    const fairness = worstServedMerchant(schedule, Math.max(1, scored.slots.length));
    points.push({
      fairnessFloor: floor,
      expectedRecovered: scored.expectedRecovered,
      worstServedShare: fairness.share,
      worstServedMerchant: store.merchants.find((m) => m.id === fairness.merchantId)?.name || fairness.merchantId,
      deferred: scored.deferred,
    });
  }

  const base = points[0].expectedRecovered;
  for (const p of points) {
    p.recoveryCost = base ? Number((((base - p.expectedRecovered) / base) * 100).toFixed(2)) : 0;
    p.maxFeasibleFloor = maxFeasible;
  }
  return points;
}

export function fairnessCurve(issuer, { maxFloor = 6 } = {}) {
  const pending = pendingRetriesFor(issuer);
  const capacity = capacityFor(issuer);
  if (!pending.length) return { issuer, points: [], note: 'Nothing queued for this issuer.' };

  const merchants = new Set(pending.map((p) => p.merchantId)).size;
  const points = fairnessCurveFor(pending, capacity, { maxFloor });
  const baseline = points[0].expectedRecovered;

  const chosen = points.find((p) => p.fairnessFloor === (config.fairnessFloor ?? 0)) || points[0];
  const binds = points.some((p) => p.expectedRecovered !== baseline);

  // When the whole queue fits inside capacity, ordering is free: every attempt
  // lands in an uncongested slot regardless of who goes first, so fairness costs
  // nothing. Saying "0% cost" without saying why would read as a claim that
  // fairness is always free, which is the opposite of the point.
  if (!binds) {
    return {
      issuer,
      merchants,
      queued: pending.length,
      points,
      chosen: chosen.fairnessFloor,
      binds: false,
      note:
        `The queue for this issuer (${pending.length} attempts across ${merchants} merchants) fits inside estimated capacity, ` +
        `so every attempt lands in an uncongested slot and ordering costs nothing. Fairness is free here. ` +
        `The trade-off only appears once the queue exceeds what the issuer can absorb, which is the situation the scheduler exists for.`,
    };
  }

  return {
    issuer,
    merchants,
    queued: pending.length,
    points,
    chosen: chosen.fairnessFloor,
    binds: true,
    note:
      `Floor 0 is pure expected value and maximises recovered rupees while serving the smallest merchant worst. ` +
      `Each additional guaranteed slot per merchant costs recovery and buys floor coverage. ` +
      `This system runs at floor ${chosen.fairnessFloor}, costing ${chosen.recoveryCost}% of expected recovery ` +
      `to raise the worst-served merchant to ${(chosen.worstServedShare * 100).toFixed(0)}% early-slot coverage. ` +
      `That is a policy choice, not an optimum, and it is stated here so it can be argued with.`,
  };
}

/**
 * Applied at planning time: when the network verdict is upstream and the queue
 * is over capacity, a candidate gets a coordinated slot instead of firing now.
 */
export function coordinatedDelayFor(issuer, paymentId) {
  if (!config.coordinateRetries) return null;
  const pending = pendingRetriesFor(issuer);
  const capacity = capacityFor(issuer);
  if (pending.length + capacity.organicPerMinute <= capacity.attemptsPerMinute) return null;

  const scheduled = scheduleCoordinated(pending, capacity);
  const mine = scheduled.find((s) => s.paymentId === paymentId);
  if (!mine || mine.slot == null || mine.slot === 0) return null;

  return {
    delayMinutes: mine.slot * SLOT_MINUTES,
    reason: `Issuer is degraded network-wide with ${pending.length} retries queued across ${
      new Set(pending.map((p) => p.merchantId)).size
    } merchants against an estimated ${capacity.attemptsPerMinute}/min capacity. This attempt is metered into minute ${
      mine.slot
    } so the network does not stampede a recovering bank.`,
  };
}
