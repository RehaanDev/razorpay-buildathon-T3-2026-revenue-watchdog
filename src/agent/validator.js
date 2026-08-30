/**
 * Claim validation.
 *
 * The agent is allowed to decide what to investigate and how to describe what it
 * found. It is not allowed to be the source of a number.
 *
 * This matters because the failure mode of an LLM in a money system is not
 * refusing to answer, it is answering fluently with a figure that came from
 * nowhere. "Recovery probability is about 85%" reads exactly like a real
 * estimate. A merchant cannot tell the difference. So the system checks.
 *
 * Every claim the agent makes must cite a factId from a tool result, and every
 * number inside that claim must actually appear in that tool result. A claim
 * that fails either check is rejected and sent back for another attempt.
 */

/** Pulls every numeric literal out of a string, normalised for comparison. */
function numbersIn(text) {
  const out = [];
  const re = /-?\d[\d,]*\.?\d*/g;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    const raw = m[0].replace(/,/g, '');
    const n = Number(raw);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * Keys whose values are identifiers or timestamps, not quantities.
 *
 * This exists because of a real failure. Payment ids like `pay_223815981edb81`
 * contain digit runs, and harvesting those into the pool of "numbers this fact
 * supports" let a fabricated 87.3% validate against an 87 that was a fragment of
 * a random id. A validator that can be satisfied by coincidence is worse than no
 * validator, because it looks like a guarantee.
 */
const OPAQUE_KEY = /(^|_)(id|ids|at|point|url|token|key|hash|reference)$|^(created_at|change_point|starts_at|customer_id|payment_id|leak_id|merchant_id)$/i;

/** Values that are identifiers or timestamps regardless of the key. */
const OPAQUE_VALUE = /^[a-z]+_[0-9a-f]{8,}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/;

/**
 * Flattens a tool result into the numbers it genuinely asserts.
 *
 * Only real quantities count: numeric fields, and digits inside human-facing
 * display strings. Identifiers and timestamps are skipped.
 */
function numbersInValue(value, acc = new Set(), key = '') {
  if (value == null) return acc;
  if (OPAQUE_KEY.test(key)) return acc;

  if (typeof value === 'number') {
    acc.add(value);
    return acc;
  }
  if (typeof value === 'string') {
    if (OPAQUE_VALUE.test(value) || ISO_DATE.test(value)) return acc;
    for (const n of numbersIn(value)) acc.add(n);
    return acc;
  }
  if (Array.isArray(value)) {
    for (const v of value) numbersInValue(v, acc, key);
    return acc;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) numbersInValue(v, acc, k);
    return acc;
  }
  return acc;
}

/**
 * A number in a claim counts as supported if the cited fact contains it, or a
 * value close enough that the difference is rounding rather than invention.
 *
 * The tolerance exists because "93.4%" in a fact legitimately becomes "93%" in a
 * sentence. It is proportional, so it stays tight on small numbers and does not
 * accidentally bless a fabricated crore because a lakh was nearby.
 */
function supported(n, available) {
  if (available.has(n)) return true;

  // A claim quoting a decimal is quoting a specific figure, so it has to match a
  // specific figure. Loose tolerance on decimals is how invented precision slips
  // through: "87.3%" reads as computed even when nothing computed it.
  const hasDecimal = !Number.isInteger(n);
  const relTol = hasDecimal ? 0.005 : 0.02;
  const absFloor = hasDecimal ? 0.05 : 0.5;

  for (const a of available) {
    if (a === 0 && n === 0) return true;
    const tol = Math.max(Math.abs(a) * relTol, absFloor);
    if (Math.abs(a - n) <= tol) return true;
    // A rate held as a fraction in the fact, quoted as a percentage in the claim.
    if (a > 0 && a < 1) {
      const asPct = a * 100;
      if (Math.abs(asPct - n) <= Math.max(asPct * relTol, absFloor)) return true;
    }
  }
  return false;
}

/** Numbers that carry no evidentiary weight and are not worth policing. */
const TRIVIAL = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 24, 30, 100]);

export function validateProposal(proposal, ledger) {
  const problems = [];
  const factsById = new Map(ledger.facts.map((f) => [f.factId, f]));

  if (!proposal || typeof proposal !== 'object') {
    return { valid: false, problems: [{ kind: 'malformed', detail: 'No proposal was produced.' }] };
  }

  const findings = Array.isArray(proposal.findings) ? proposal.findings : [];
  if (findings.length === 0) {
    problems.push({
      kind: 'no_evidence',
      detail: 'The conclusion cites no findings. Every conclusion must rest on at least one tool result.',
    });
  }

  for (const [i, finding] of findings.entries()) {
    const factId = finding.fact_id || finding.factId;
    if (!factId) {
      problems.push({ kind: 'missing_citation', index: i, claim: finding.claim, detail: 'Claim has no fact_id.' });
      continue;
    }
    const fact = factsById.get(factId);
    if (!fact) {
      problems.push({
        kind: 'unknown_citation',
        index: i,
        claim: finding.claim,
        factId,
        detail: `${factId} does not correspond to any tool call made in this run.`,
      });
      continue;
    }

    const available = numbersInValue(fact.value);
    const claimed = numbersIn(finding.claim).filter((n) => !TRIVIAL.has(n));
    const unsupported = claimed.filter((n) => !supported(n, available));
    if (unsupported.length) {
      problems.push({
        kind: 'unsupported_number',
        index: i,
        claim: finding.claim,
        factId,
        numbers: unsupported,
        detail: `${unsupported.join(', ')} does not appear in ${factId} (${fact.tool}). Cite the tool call that produced it, or remove the figure.`,
      });
    }
  }

  // The rationale is prose for a human, but it is still not allowed to smuggle
  // in a figure nobody computed.
  const allFactNumbers = new Set();
  for (const f of ledger.facts) numbersInValue(f.value, allFactNumbers);
  const rationaleNumbers = numbersIn(proposal.rationale || '').filter((n) => !TRIVIAL.has(n));
  const badRationale = rationaleNumbers.filter((n) => !supported(n, allFactNumbers));
  if (badRationale.length) {
    problems.push({
      kind: 'unsupported_number',
      claim: proposal.rationale,
      numbers: badRationale,
      detail: `The rationale contains ${badRationale.join(', ')}, which no tool call produced.`,
    });
  }

  return { valid: problems.length === 0, problems };
}

/** Turns validator output into a correction the model can act on. */
export function correctionMessage(problems) {
  const lines = [
    'Your conclusion was rejected by the claim validator. Fix these and call propose_recovery_posture again.',
    '',
  ];
  for (const p of problems) {
    lines.push(`- ${p.detail}`);
  }
  lines.push(
    '',
    'Reminder: you are not the source of any figure. If you need a number, call the tool that computes it. If a tool did not produce it, do not state it.'
  );
  return lines.join('\n');
}
