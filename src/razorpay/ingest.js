import crypto from 'node:crypto';
import { store } from '../store.js';
import { config } from '../config.js';
import { sanitiseForModel } from '../agent/guard.js';

/**
 * Real Razorpay payments, translated into the shape the rest of the system
 * already speaks.
 *
 * Everything downstream of here — detectors, planner, model, policy engine,
 * agent tools — was written against an internal payment shape produced by the
 * synthetic generator. A real payment arriving over a webhook is a different
 * shape entirely, so this module is the boundary that converts one into the
 * other.
 *
 * The important property is that after conversion, a real payment is
 * indistinguishable to the pipeline from a simulated one EXCEPT for one field:
 * `source`. Nothing in detection or policy branches on `source`. Two things do:
 *
 *   - execute.js refuses to sample a fake outcome for a real payment. A real
 *     recovery is only ever marked recovered by a real webhook.
 *   - the UI labels it, so nobody demos a simulated number as a real one.
 */

/* --------------------------------------------------------- decline mapping -- */

/**
 * Razorpay's failure vocabulary, mapped onto the internal decline taxonomy.
 *
 * Razorpay reports failures across three fields — `error_code` (broad class),
 * `error_reason` (specific), and `error_description` (prose). `error_reason` is
 * the useful one, but it is not an exhaustive published enum, so this matches
 * on substrings and falls through to a safe default rather than throwing away
 * a payment it does not recognise.
 *
 * The default is GATEWAY_ERROR — class `soft`, retryable. That is the
 * conservative choice: treating an unknown failure as retryable risks one
 * wasted retry, whereas treating it as terminal risks abandoning recoverable
 * money in silence.
 */
const REASON_PATTERNS = [
  [/insufficient|low.?balance|not.?enough/i, 'INSUFFICIENT_FUNDS'],
  [/limit.?exceed|exceeds.?limit|max.?amount/i, 'LIMIT_EXCEEDED'],
  [/expired.?card|card.?expired/i, 'CARD_EXPIRED'],
  [/blocked|restricted.?card|card.?disabled/i, 'CARD_BLOCKED'],
  [/invalid.?vpa|vpa.?invalid|invalid.?upi/i, 'INVALID_VPA'],
  [/mandate|subscription.?cancel|autopay.?revoke/i, 'MANDATE_REVOKED'],
  [/account.?closed|account.?not.?found|invalid.?account/i, 'ACCOUNT_CLOSED'],
  [/fraud|risk|suspicious/i, 'FRAUD_SUSPECTED'],
  [/timeout|timed.?out|expired.?session/i, 'PAYMENT_TIMEOUT'],
  [/cancel|abandon|user.?dropped|closed.?by.?user/i, 'USER_DROPPED'],
  [/bank.?down|issuer.?down|bank.?unavailable|gateway.?down/i, 'BANK_DOWN'],
  [/network|connection/i, 'NETWORK_ERROR'],
  [/declin|denied|rejected/i, 'ISSUER_DECLINED_TEMP'],
];

export function mapDeclineCode(entity) {
  const haystack = [entity.error_reason, entity.error_description, entity.error_step, entity.error_code]
    .filter(Boolean)
    .join(' ');
  if (!haystack) return 'GATEWAY_ERROR';
  for (const [re, code] of REASON_PATTERNS) {
    if (re.test(haystack)) return code;
  }
  return 'GATEWAY_ERROR';
}

/* ---------------------------------------------------------- issuer mapping -- */

/**
 * Derive an issuer label from a real payment.
 *
 * The issuer is the unit the detectors group by, so it has to be stable across
 * payments. `bank` for netbanking, the VPA handle for UPI, wallet name for
 * wallets. Cards are the awkward case: the webhook payload does not always
 * carry the issuing bank, so unknown cards collapse into one bucket rather
 * than fragmenting into hundreds of one-payment groups that can never reach
 * significance.
 */
export function deriveIssuer(entity) {
  const method = entity.method || 'unknown';

  if (method === 'upi') {
    const vpa = String(entity.vpa || entity.upi?.vpa || '');
    const handle = vpa.includes('@') ? vpa.split('@')[1] : '';
    return handle ? `UPI / ${handle}` : 'UPI / unknown handle';
  }
  if (method === 'netbanking') {
    const bank = entity.bank || 'unknown';
    return `${bank} Netbanking`;
  }
  if (method === 'wallet') {
    return `Wallet / ${entity.wallet || 'unknown'}`;
  }
  if (method === 'card') {
    const bank = entity.bank || entity.card?.issuer || '';
    const type = entity.card?.type ? ` ${entity.card.type}` : '';
    return bank ? `${bank}${type} Card` : 'Card / issuer not reported';
  }
  return `${method} / unknown`;
}

/* -------------------------------------------------------------- customers -- */

/**
 * Real customers are identified by contact details rather than a generated id,
 * so that a repeat buyer accumulates history across payments. That history is a
 * real feature of the recovery model: prior success rate and contact count both
 * move the estimate.
 *
 * Contact details are hashed into the id rather than stored raw in it, because
 * the customer id ends up in the audit ledger, in agent tool results, and in
 * the UI, and an email address does not need to be in any of those.
 */
/**
 * A name for the UI and nothing more.
 *
 * Derived from a handle only when the handle is real. Otherwise the payment is
 * labelled by how it was made, which is honest and still tells the operator
 * something, rather than inventing a person out of a placeholder.
 */
function displayName(entity, handle) {
  if (handle && handle.includes('@')) {
    const local = handle.split('@')[0].replace(/[._-]+/g, ' ').trim();
    if (local) return local.replace(/\b\w/g, (m) => m.toUpperCase());
  }
  if (handle) return handle; // a phone number is at least a real identifier
  const method = entity.method ? String(entity.method).toUpperCase() : 'Razorpay';
  const last4 = entity.card?.last4;
  return last4 ? `${method} shopper ····${last4}` : `${method} shopper`;
}

/**
 * Handles Razorpay substitutes when the shopper did not supply one.
 *
 * Test mode fills the email field with `void@razorpay.com` and the contact
 * field with a run of nines rather than leaving them empty. Both look like real
 * values and neither identifies anybody.
 */
const PLACEHOLDER_HANDLES = new Set([
  'void@razorpay.com',
  'void@razorpay',
  'void',
  '+919999999999',
  '9999999999',
  '+910000000000',
  '0000000000',
]);

const isPlaceholder = (v) =>
  !v || PLACEHOLDER_HANDLES.has(String(v).trim().toLowerCase());

/** The first handle that actually identifies someone, or null. */
function realHandle(entity) {
  for (const v of [entity.email, entity.contact, entity.vpa]) {
    if (!isPlaceholder(v)) return String(v).trim();
  }
  return null;
}

export function upsertRealCustomer(entity) {
  // Two things went wrong here and only one of them was visible.
  //
  // The visible one: the display name was the local part of the email, so a
  // shopper who supplied nothing showed up in the UI as "void" — the first half
  // of the `void@razorpay.com` placeholder Razorpay fills in. Sometimes a real
  // name appeared instead, which is simply the case where the shopper did give
  // an email, and that inconsistency was the tell.
  //
  // The one that mattered more: the customer id is a hash of the same handle.
  // With every anonymous payment hashing `void@razorpay.com`, they all collapsed
  // into a SINGLE customer. Their successes and failures accumulated together,
  // so `priorSuccessRate` and `contactsLast30d` — both features the recovery
  // model reads — described a fictional composite shopper rather than any of
  // the real ones. A placeholder must never be used as an identity.
  const handle = realHandle(entity);
  const identity = handle || `payment:${entity.id}`; // no handle: keep them distinct
  const hash = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12);
  const customerId = `cust_rzp_${hash}`;

  let customer = store.customers.get(customerId);
  if (!customer) {
    customer = {
      id: customerId,
      name: sanitiseForModel(displayName(entity, handle)),
      merchantId: config.focusMerchantId,
      priorSuccesses: 0,
      priorFailures: 0,
      priorSuccessRate: 0.5,
      // No observed paying window yet. Left null so the planner does not
      // pretend to know when this person usually pays.
      successWindow: null,
      contactsLast30d: 0,
      real: true,
      // The real email is kept here so the recovery email simulator can address
      // the shopper. It is server-side only: it is never placed in the model
      // context, the agent tools, or the audit ledger.
      email: isPlaceholder(entity.email) ? null : entity.email,
      contact: isPlaceholder(entity.contact) ? null : entity.contact,
    };
    store.customers.set(customerId, customer);
  }

  // Placeholders are not contact details and must not be stored as if they are:
  // the recovery email simulator would otherwise cheerfully address a link to
  // void@razorpay.com.
  if (!isPlaceholder(entity.email) && !customer.email) customer.email = entity.email;
  if (!isPlaceholder(entity.contact) && !customer.contact) customer.contact = entity.contact;

  if (entity.status === 'captured' || entity.status === 'authorized') customer.priorSuccesses += 1;
  if (entity.status === 'failed') customer.priorFailures += 1;
  const total = customer.priorSuccesses + customer.priorFailures;
  customer.priorSuccessRate = total ? customer.priorSuccesses / total : 0.5;

  return customer;
}

/* ----------------------------------------------------------- the converter -- */

/**
 * Convert a Razorpay payment entity into an internal payment and put it in the
 * store. Returns the internal payment.
 *
 * Idempotent on payment id: a webhook that arrives twice updates the existing
 * row rather than creating a second one.
 */
export function ingestRealPayment(entity, { via = 'webhook' } = {}) {
  const existing = store.paymentsById.get(entity.id);
  const customer = upsertRealCustomer(entity);

  const createdAt = entity.created_at
    ? new Date(entity.created_at * 1000).toISOString()
    : new Date().toISOString();

  // Untrusted: written by whoever created the order or the checkout.
  const description = entity.description ? String(entity.description) : null;
  const notes = {};
  for (const [k, v] of Object.entries(entity.notes || {})) notes[k] = String(v);

  const payment = {
    id: entity.id,
    merchantId: config.focusMerchantId,
    customerId: customer.id,
    amount: entity.amount,
    currency: entity.currency || 'INR',
    method: entity.method || 'unknown',
    issuer: deriveIssuer(entity),
    status: entity.status,
    errorCode: entity.status === 'failed' ? mapDeclineCode(entity) : null,
    // The raw failure fields are kept verbatim alongside the mapped code. The
    // mapping is a judgement call and an operator needs to be able to check it.
    razorpayError: entity.status === 'failed'
      ? {
          code: entity.error_code || null,
          reason: entity.error_reason || null,
          description: entity.error_description || null,
          source: entity.error_source || null,
          step: entity.error_step || null,
        }
      : null,
    createdAt: existing?.createdAt || createdAt,
    orderId: entity.order_id || null,
    subscriptionId: entity.subscription_id || null,
    attemptNo: existing ? (existing.attemptNo || 1) : 1,
    recurring: false,
    degradedAtSource: false,
    description,
    notes: Object.keys(notes).length ? notes : null,
    source: 'razorpay',
    ingestedVia: via,
    ingestedAt: new Date().toISOString(),
  };

  if (existing) {
    Object.assign(existing, payment);
    store.markRealDirty();
    return existing;
  }

  store.addPayment(payment);
  store.record({
    type: 'real_payment_ingested',
    paymentId: payment.id,
    status: payment.status,
    method: payment.method,
    issuer: payment.issuer,
    amount: payment.amount,
    declineCode: payment.errorCode,
    razorpayReason: payment.razorpayError?.reason || null,
    via,
    note: 'A real payment from the Razorpay account entered the pipeline.',
  });
  store.markRealDirty();
  return payment;
}