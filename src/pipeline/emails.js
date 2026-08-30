import { store } from '../store.js';
import { config, DECLINE_TAXONOMY } from '../config.js';
import { rupees, id } from '../lib/util.js';

/**
 * Recovery email simulator.
 *
 * When a merchant approves a recovery on a failed payment, the real product
 * would email the shopper a link to complete it. This module simulates that
 * outbound email so it can be shown on screen — the "Shopper-side email
 * simulator" — without wiring up an SMTP server.
 *
 * Two rules make this honest rather than a gimmick:
 *
 *   1. Recoverability gate. An email is only ever composed for a failure the
 *      shopper can actually fix by trying again: a platform hiccup, a bank
 *      timeout, a temporary decline. It is NEVER sent for a dead instrument
 *      (expired card, invalid UPI), an exhausted balance treated as terminal,
 *      a revoked mandate, or a fraud/closed-account block. Emailing those is
 *      spam — the shopper cannot complete the payment no matter how nicely we
 *      ask — so the simulator refuses and says why.
 *
 *   2. Real vs simulated link. For a REAL Razorpay test-mode payment, the email
 *      carries the real payment-link URL created at Razorpay, which actually
 *      opens and can actually be paid. For a synthetic (fake merchant) payment,
 *      the email is composed with a clearly-marked non-working placeholder,
 *      because there is no real link behind it.
 */

/* --------------------------------------------------------- recoverability -- */

/**
 * How to treat each decline class for emailing:
 *
 *   soft, timing   -> retry email ("temporary issue, finish it in seconds")
 *   instrument     -> try-another-method email ("that card won't work, use
 *                     a different one within 24h") — recoverable via a NEW
 *                     instrument, not a retry of the dead one
 *   mandate        -> no email (needs re-authorisation, not a shopper link)
 *   terminal       -> no email (account closed / fraud — emailing is spam)
 */
const RETRY_CLASSES = new Set(['soft', 'timing']);
const ALT_METHOD_CLASSES = new Set(['instrument']);

export function recoverabilityFor(candidate) {
  const tax = DECLINE_TAXONOMY[candidate.errorCode] || { class: 'soft', retryable: true, label: 'Unknown failure' };

  if (RETRY_CLASSES.has(tax.class)) {
    return {
      emailable: true,
      variant: 'retry',
      declineClass: tax.class,
      reason:
        tax.class === 'soft'
          ? 'Failed due to a platform or bank-side issue. Retrying genuinely works, so a recovery email is appropriate.'
          : 'A fresh attempt later (funds, limits, or an abandoned session) can succeed, so a recovery email is appropriate.',
      label: tax.label,
    };
  }

  if (ALT_METHOD_CLASSES.has(tax.class)) {
    return {
      emailable: true,
      variant: 'try_another_method',
      declineClass: tax.class,
      reason:
        'The instrument used is dead (e.g. expired or blocked card, invalid UPI). A retry of it cannot work, but the shopper can complete the order with a different method — so a "try another method within 24h" email is appropriate.',
      label: tax.label,
    };
  }

  return {
    emailable: false,
    variant: 'none',
    declineClass: tax.class,
    reason:
      tax.class === 'mandate'
        ? 'The recurring mandate was revoked. This needs re-authorisation, not a shopper link, so no email is sent.'
        : 'This failure is terminal (e.g. account closed or flagged by risk). Emailing the shopper would be spam, so no email is sent.',
    label: tax.label,
  };
}

/* --------------------------------------------------------------- compose --- */

function merchantNameFor(merchantId) {
  return store.merchants.find((m) => m.id === merchantId)?.name || 'the store';
}

function composeBody({ merchantName, amount, link, real, variant }) {
  const amt = rupees(amount);

  if (variant === 'try_another_method') {
    // Non-recoverable by retry of the same instrument (e.g. expired card).
    // We still tell the shopper honestly and give them a fresh link to pay with
    // a DIFFERENT method, within a 24h window, then stop bothering them.
    const linkLine = real
      ? `Use a different card or payment method here:\n${link}`
      : `Use a different card or payment method here:\n${link}  (simulated link — fake-merchant demo, not a working URL)`;
    return [
      `Hi,`,
      ``,
      `Your recent payment of ${amt} to ${merchantName} didn't go through, and it looks like the card or method you used won't work this time (for example an expired card or a limit on the account).`,
      ``,
      `You can still complete your order — just use a different card or payment method:`,
      ``,
      linkLine,
      ``,
      `This link is valid for 24 hours. If you'd rather not, no problem — you can ignore this email and we won't send another.`,
      ``,
      `Thanks,`,
      `${merchantName}`,
    ].join('\n');
  }

  // Default: recoverable by retrying (platform / bank / temporary issue).
  const linkLine = real
    ? `Complete your payment securely here:\n${link}`
    : `Complete your payment securely here:\n${link}  (simulated link — fake-merchant demo, not a working URL)`;

  return [
    `Hi,`,
    ``,
    `Your recent payment of ${amt} to ${merchantName} didn't go through because of a temporary issue on the payment side — not anything you did.`,
    ``,
    `Good news: you can finish it in a few seconds.`,
    ``,
    linkLine,
    ``,
    `If you've already paid, please ignore this email.`,
    ``,
    `Thanks,`,
    `${merchantName}`,
  ].join('\n');
}

/**
 * Compose and store a recovery email for a candidate.
 *
 * `link` is the recovery URL (real Razorpay short URL, or a placeholder for
 * synthetic payments). `real` marks which kind it is. Returns the stored email.
 *
 * Does NOT decide recoverability itself — the caller checks recoverabilityFor()
 * first and only calls this when emailable. Kept separate so the reason for not
 * sending can be surfaced distinctly from the act of sending.
 */
export function composeRecoveryEmail(candidate, { link, real, actionId, variant = 'retry' }) {
  const customer = store.customers.get(candidate.customerId);
  const to = customer?.email || (real ? 'shopper@example.com' : `${candidate.customerName || 'shopper'}@example.com`);
  const merchantName = merchantNameFor(candidate.merchantId);

  const subject =
    variant === 'try_another_method'
      ? `Your ${rupees(candidate.amount)} payment to ${merchantName} — try a different method to complete it`
      : `Your ${rupees(candidate.amount)} payment to ${merchantName} — one quick step to complete it`;

  const email = {
    id: id('email'),
    at: new Date().toISOString(),
    to,
    from: `no-reply@${merchantName.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`,
    subject,
    body: composeBody({ merchantName, amount: candidate.amount, link, real, variant }),
    link,
    real,
    variant,
    candidateId: candidate.id,
    paymentId: candidate.paymentId,
    actionId: actionId || null,
    merchantId: candidate.merchantId,
    amount: candidate.amount,
    declineCode: candidate.errorCode,
    status: 'sent', // 'sent' -> 'paid' | 'expired'
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };

  store.emails.unshift(email);
  if (store.emails.length > 200) store.emails.length = 200;

  // A real recovery email is part of the real account's state and has to
  // survive a restart. persistReal() early-returns unless the store is marked
  // dirty, and composing an email did not mark it — so a genuine payment link
  // sent to a genuine shopper lived in memory only, and vanished the next time
  // the process came up. The webhook that eventually pays that link would then
  // arrive with no email to attribute it to.
  //
  // Simulated emails are deliberately NOT persisted. They belong to seeded
  // candidates whose ids are regenerated on every boot, so restoring them would
  // produce mail pointing at candidates that no longer exist.
  if (real) store.markRealDirty();

  store.record({
    type: 'recovery_email_sent',
    emailId: email.id,
    candidateId: candidate.id,
    paymentId: candidate.paymentId,
    to: real ? to : '[simulated]',
    real,
    amount: candidate.amount,
    note: real
      ? 'A recovery email with a real Razorpay payment link was sent to the shopper (shown in the email simulator).'
      : 'A simulated recovery email was composed for a fake-merchant payment (no working link).',
  });

  return email;
}

/**
 * Mark the email(s) for a candidate as paid, once recovery is confirmed.
 * Called from the webhook path and from synthetic recovery confirmation.
 */
export function markEmailPaid(candidateId) {
  let changed = 0;
  for (const e of store.emails) {
    if (e.candidateId === candidateId && e.status !== 'paid') {
      e.status = 'paid';
      e.paidAt = new Date().toISOString();
      changed += 1;
    }
  }
  return changed;
}

/** Mark the email(s) for a candidate as expired (link went unpaid for 24h). */
export function expireEmailFor(candidateId) {
  let changed = 0;
  for (const e of store.emails) {
    if (e.candidateId === candidateId && e.status === 'sent') {
      e.status = 'expired';
      e.expiredAt = new Date().toISOString();
      changed += 1;
    }
  }
  return changed;
}

/**
 * Manually resolve a SIMULATED (fake-merchant) email from the UI buttons.
 *
 * Fake-merchant emails have no real link and no webhook will ever arrive to
 * confirm them, so the simulator gives the operator a green/red control to say
 * "pretend the shopper paid" or "pretend they didn't". Real emails ignore this:
 * their truth comes only from Razorpay, never from a button.
 */
export function resolveSimEmail(emailId, outcome) {
  const email = store.emails.find((e) => e.id === emailId);
  if (!email) return { error: 'email not found' };
  if (email.real) return { error: 'real emails are resolved by Razorpay, not by hand' };

  if (outcome === 'paid') {
    email.status = 'paid';
    email.paidAt = new Date().toISOString();
    const action = store.actions.find((a) => a.candidateId === email.candidateId);
    if (action) {
      action.pending = false;
      action.recovered = true;
      action.recoveredAmount = email.amount;
      action.recoveredAt = email.paidAt;
      action.recoveredVia = 'simulated_email_button';
    }
    const candidate = store.candidates.find((c) => c.id === email.candidateId);
    if (candidate) candidate.resolved = { by: 'simulated', at: email.paidAt, outcome: 'recovered' };
    store.record({ type: 'sim_email_marked_paid', emailId, candidateId: email.candidateId, amount: email.amount, note: 'Simulated shopper marked as paid via the email button.' });
  } else {
    email.status = 'expired';
    email.expiredAt = new Date().toISOString();
    const action = store.actions.find((a) => a.candidateId === email.candidateId);
    if (action) { action.pending = false; action.recovered = false; action.expired = true; }
    const candidate = store.candidates.find((c) => c.id === email.candidateId);
    if (candidate) candidate.resolved = { by: 'simulated', at: email.expiredAt, outcome: 'not_recovered', reason: 'simulated shopper did not pay' };
    store.record({ type: 'sim_email_marked_failed', emailId, candidateId: email.candidateId, note: 'Simulated shopper marked as not paid via the email button.' });
  }
  store.markRealDirty();
  return { ok: true, status: email.status };
}

/** Read model for the UI. Newest first. */
export function outbox() {
  return store.emails.map((e) => ({
    id: e.id,
    at: e.at,
    to: e.to,
    from: e.from,
    subject: e.subject,
    body: e.body,
    link: e.link,
    real: e.real,
    variant: e.variant || 'retry',
    candidateId: e.candidateId,
    status: e.status,
    paidAt: e.paidAt || null,
    expiredAt: e.expiredAt || null,
    expiresAt: e.expiresAt || null,
    amount: e.amount,
    declineCode: e.declineCode,
    paymentId: e.paymentId,
  }));
}