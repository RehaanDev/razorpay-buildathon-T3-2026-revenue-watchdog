import { callGemini, readGeminiResponse } from '../agent/gemini.js';
import { config } from '../config.js';
import { rupees } from '../lib/util.js';

/**
 * Diagnosis.
 *
 * The narrative is generated from structured evidence that was already computed
 * deterministically. The model is never the source of a number; it is the source
 * of a sentence. If no model key is set, the template writer produces
 * the same claims in slightly stiffer prose and nothing else changes.
 *
 * Every diagnosis carries `evidence`, which is what the "Why?" panel renders.
 * The merchant should be able to check every clause against a row of data.
 */

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const timeOf = (iso) =>
  new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });

export function diagnoseDegradation(finding, network, merchant) {
  const evidence = [
    `${finding.issuer} succeeded ${pct(finding.baselineRate)} of the time over the last 30 days for ${merchant.name}.`,
    `Since ${timeOf(finding.changePoint)} it is succeeding ${pct(finding.currentRate)} (95% interval ${pct(finding.currentInterval[0])}–${pct(finding.currentInterval[1])}).`,
    `A beta-binomial test puts the probability of a real drop of 6 points or more at ${pct(finding.significance)}, on ${finding.attemptsInWindow} attempts.`,
    `${finding.affectedFailures} payments have failed since the change point, worth ${rupees(finding.amountAtRisk)}.`,
  ];

  if (network.verdict === 'upstream') {
    evidence.push(
      `The same issuer is degraded for ${network.merchantsDegraded} of ${network.merchantsObserved} merchants on the network in the same window.`,
      `Network-wide success rate for ${finding.issuer} is ${pct(network.networkRate)}, which rules out a change on ${merchant.name}'s side.`
    );
  } else if (network.verdict === 'merchant_local') {
    evidence.push(
      `${merchant.name} is the only merchant on the network showing this drop for ${finding.issuer}.`,
      `Other merchants are running at ${pct(network.networkRate)} on the same instrument in the same window, so this is local to this account.`
    );
  } else {
    evidence.push(`Cross-merchant signal is inconclusive: ${network.merchantsDegraded} of ${network.merchantsObserved} merchants affected.`);
  }

  const summary =
    network.verdict === 'upstream'
      ? `${finding.issuer} is failing across the network, not just here. It broke at about ${timeOf(finding.changePoint)} and is running at ${pct(finding.currentRate)} against a normal ${pct(finding.baselineRate)}. Nothing changed in ${merchant.name}'s checkout. Retrying into a live outage will mostly manufacture second failures, so the useful moves are routing customers to a working instrument now and recovering the affected payments once the issuer stabilises.`
      : network.verdict === 'merchant_local'
        ? `${finding.issuer} is failing for ${merchant.name} and for nobody else on the network. That points at something in this account rather than at the bank: a checkout or configuration change around ${timeOf(finding.changePoint)} is the most likely cause. Recovery of the affected payments is worth doing, but it treats the symptom.`
        : `${finding.issuer} has dropped to ${pct(finding.currentRate)} since ${timeOf(finding.changePoint)}. There is not yet enough cross-merchant volume to say whether the cause is upstream or local.`;

  const action =
    network.verdict === 'upstream'
      ? 'Suppress retries on this instrument until the issuer recovers. Recover affected payments through an alternate instrument.'
      : 'Recover affected payments, and check what changed in this account around the change point.';

  return { summary, evidence, recommendedPosture: action, verdict: network.verdict };
}

export function diagnoseRecurring(recurring, merchant) {
  const seg = (k) => recurring.segments.find((s) => s.class === k);
  const evidence = [
    `${recurring.count} recurring charges failed for ${merchant.name} in the last 24 hours, worth ${rupees(recurring.amountAtRisk)}.`,
  ];
  for (const s of recurring.segments) {
    evidence.push(
      `${s.count} failed with ${s.class} declines (${s.codes.join(', ')}), worth ${rupees(s.amount)}. ${s.retryable ? 'Retryable.' : 'Not retryable — a retry cannot succeed on the same instrument.'}`
    );
  }

  const timing = seg('timing');
  const instrument = seg('instrument');
  const mandate = seg('mandate');

  const parts = [`${recurring.count} renewals failed, and they are not one problem.`];
  if (timing) parts.push(`${timing.count} are balance or limit declines from customers who normally pay without trouble; those recover on a retry placed in the window where that customer has historically succeeded.`);
  if (instrument) parts.push(`${instrument.count} are dead instruments. Retrying those is pure waste — the card cannot succeed no matter how many times it is presented. The only path is a link that lets the customer put in a different card.`);
  if (mandate) parts.push(`${mandate.count} had the mandate revoked, which means the customer withdrew authorisation. That is a re-consent conversation for the merchant, not a payments action.`);

  return {
    summary: parts.join(' '),
    evidence,
    recommendedPosture: 'Segment by decline class. Retry only what can succeed, and spend a customer contact only where it changes the outcome.',
    verdict: 'segmented',
  };
}

export function diagnoseStranded(stranded, merchant) {
  const evidence = [];
  if (stranded.orphans.length) {
    evidence.push(
      `${stranded.orphans.length} payments were captured but the merchant endpoint never acknowledged the webhook, worth ${rupees(stranded.orphanAmount)}.`
    );
    for (const o of stranded.orphans) {
      evidence.push(
        `${o.id}: ${rupees(o.amount)} captured ${o.hoursStranded}h ago, ${o.webhookDelivery.attempts} delivery attempts, last response "${o.webhookDelivery.lastError}".`
      );
    }
  }
  if (stranded.expiring.length) {
    evidence.push(
      `${stranded.expiring.length} authorisations are approaching auto-void, worth ${rupees(stranded.expiringAmount)}. Once voided this money is gone without anyone deciding to let it go.`
    );
  }

  return {
    summary: `${rupees(stranded.orphanAmount + stranded.expiringAmount)} is stranded between the customer's bank and the merchant's system. The captured-but-unacknowledged payments mean a customer has paid and, from their side, received nothing. The system will not refund these automatically: it cannot see the merchant's order table, so it cannot know whether fulfilment happened by some other route, and a wrong refund is a second failure on top of the first. It needs a person.`,
    evidence,
    recommendedPosture: 'Capture the expiring authorisations if the goods shipped. Escalate the unacknowledged captures for a human decision.',
    verdict: 'requires_human',
  };
}

/**
 * Optional: rewrite the summary with the configured model, given the same
 * structured evidence.
 *
 * The model is asked for phrasing and never for a number. If the key is absent,
 * the call fails, or the rewrite tries to introduce a figure that is not in the
 * evidence, the caller keeps the deterministic text. A prettier sentence is
 * never worth a fabricated statistic.
 */
export async function polishNarrative(diagnosis, context) {
  if (!config.geminiApiKey) return diagnosis;
  try {
    const data = await callGemini({
      systemPrompt:
        'You explain payment anomalies to a merchant operations lead. You are given verified evidence lines. Restate the situation in at most four sentences of plain English. Never introduce a number that is not in the evidence. Never soften a recommendation to do nothing.',
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `Context: ${context}\n\nEvidence:\n${diagnosis.evidence.map((e) => `- ${e}`).join('\n')}\n\nCurrent draft: ${diagnosis.summary}`,
            },
          ],
        },
      ],
    });
    const { text } = readGeminiResponse(data);
    const clean = (text || '').trim();
    if (!clean) return diagnosis;

    // Same rule the agent's claims live under: the narrative may rephrase the
    // evidence, it may not add to it. Any number in the rewrite has to already
    // appear somewhere in the evidence lines or the draft it replaced.
    const supported = [...diagnosis.evidence, diagnosis.summary].join(' ');
    const invented = (clean.match(/\d+(?:\.\d+)?/g) || []).filter((n) => !supported.includes(n));
    if (invented.length) return { ...diagnosis, narrativeRejected: invented };

    return { ...diagnosis, summary: clean, narrativeSource: 'gemini' };
  } catch {
    return diagnosis;
  }
}
