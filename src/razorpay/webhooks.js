import { store } from '../store.js';
import { verifyWebhookSignature } from './client.js';
import { scanForInjection } from '../agent/guard.js';
import { ingestRealPayment, mapDeclineCode, deriveIssuer } from './ingest.js';
import { markEmailPaid } from '../pipeline/emails.js';

/**
 * Webhook ingestion.
 *
 * Payment webhooks are the part of this system most likely to be got wrong, and
 * three properties matter more than throughput:
 *
 *   Authenticity - HMAC over the raw body, checked before parsing. Anything that
 *                  parses first has already trusted the payload.
 *   At-least-once - the same event will arrive twice. Deduplicate on event id.
 *   Out-of-order  - `captured` can land before `authorized`. State transitions
 *                   are guarded by rank, not by arrival order, so a late event
 *                   can never walk a payment backwards.
 */

const STATE_RANK = { created: 0, authorized: 1, captured: 2, refunded: 3, failed: 2, voided: 3 };

export function handleWebhook({ rawBody, signature }) {
  if (!verifyWebhookSignature(rawBody, signature)) {
    return { status: 401, body: { error: 'signature mismatch' } };
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'malformed body' } };
  }

  const eventId = event.id || event.event_id;
  if (!eventId) return { status: 400, body: { error: 'missing event id' } };

  if (store.seenWebhookIds.has(eventId)) {
    store.webhookLog.unshift({ eventId, event: event.event, outcome: 'duplicate_ignored', at: new Date().toISOString() });
    return { status: 200, body: { received: true, deduplicated: true } };
  }
  store.seenWebhookIds.add(eventId);

  const entity = event?.payload?.payment?.entity;
  const linkEntity = event?.payload?.payment_link?.entity;
  let outcome = 'noop';

  /**
   * Recovery link paid. This is the event that closes the loop: the system sent
   * a link because a payment failed, and the customer has now paid it. Under a
   * live test-mode key this is the moment simulated money becomes real money.
   *
   * The link's reference_id is the candidate id the system set when it created
   * the link, which is what lets a payment arriving from outside be matched back
   * to the decision that caused it. Without that, a recovered rupee cannot be
   * attributed to the action that recovered it, and the whole lift measurement
   * is guesswork.
   *
   * Notes on a payment link are merchant- and customer-visible free text, so
   * they are scanned before anything reads them.
   */
  if (linkEntity) {
    const referenceId = linkEntity.reference_id;
    const action = store.actions.find(
      (a) => a.candidateId === referenceId || a.gatewayResponse?.id === linkEntity.id
    );

    if (linkEntity.notes) {
      for (const [k, v] of Object.entries(linkEntity.notes)) {
        scanForInjection(String(v), { source: `payment_link.notes.${k}`, paymentId: action?.paymentId || null });
      }
    }

    if (!action) {
      outcome = 'link_not_recognised';
    } else if (event.event === 'payment_link.paid' || linkEntity.status === 'paid') {
      if (action.recovered) {
        outcome = 'already_recovered';
      } else {
        action.recovered = true;
        action.pending = false;
        action.recoveredAmount = linkEntity.amount_paid ?? linkEntity.amount ?? action.amount;
        action.recoveredAt = new Date().toISOString();
        action.recoveredVia = 'payment_link_webhook';
        const candidate = store.candidates.find((c) => c.id === action.candidateId);
        if (candidate) {
          candidate.resolved = { by: 'customer', at: action.recoveredAt, outcome: 'recovered' };
        }
        // Flip the shopper-side email to "paid" so the simulator shows the loop closing.
        markEmailPaid(action.candidateId);
        outcome = 'recovery_confirmed';
        store.record({
          type: 'recovery_confirmed',
          candidateId: action.candidateId,
          paymentId: action.paymentId,
          actionId: action.id,
          linkId: linkEntity.id,
          amount: action.recoveredAmount,
          arm: action.arm,
          note: 'A recovery link this system created was paid. Attributed to the decision that created it.',
        });
      }
    } else if (linkEntity.status === 'cancelled' || linkEntity.status === 'expired') {
      outcome = 'link_' + linkEntity.status;
      store.record({
        type: 'recovery_link_' + linkEntity.status,
        candidateId: action.candidateId,
        paymentId: action.paymentId,
        linkId: linkEntity.id,
      });
    }

    store.webhookLog.unshift({
      eventId,
      event: event.event,
      paymentId: action?.paymentId || null,
      linkId: linkEntity.id,
      outcome,
      at: new Date().toISOString(),
    });
    store.webhookLog = store.webhookLog.slice(0, 200);
    store.record({ type: 'webhook', eventId, event: event.event, linkId: linkEntity.id, outcome });
    return { status: 200, body: { received: true, outcome } };
  }

  if (entity?.id) {
    if (entity.description) {
      scanForInjection(String(entity.description), { source: 'payment.description', paymentId: entity.id });
    }
    if (entity.notes) {
      for (const [k, v] of Object.entries(entity.notes)) {
        scanForInjection(String(v), { source: `payment.notes.${k}`, paymentId: entity.id });
      }
    }
    const existing = store.paymentsById.get(entity.id);
    const incomingState = entity.status;

    if (!existing) {
      // A real Razorpay payment we have not seen before. Ingest it so it
      // enters the pipeline rather than being silently discarded.
      ingestRealPayment(entity, { via: `webhook:${event.event}` });
      outcome = 'real_payment_ingested';

      // If this is a failed payment, schedule a cycle immediately so it
      // appears in the leak map and the Recovery queue without waiting for
      // the next timed cycle. The cycle is kicked off in a microtask so the
      // webhook response returns promptly.
      if (incomingState === 'failed') {
        setTimeout(() => {
          import('../pipeline/cycle.js').then(({ runCycle }) => runCycle({})).catch(() => {});
        }, 0);
      }
    } else if ((STATE_RANK[incomingState] ?? -1) < (STATE_RANK[existing.status] ?? -1)) {
      // Late event describing an earlier state. Record it, do not apply it.
      outcome = 'out_of_order_ignored';
    } else {
      existing.status = incomingState;
      if (entity.error_code) {
        existing.errorCode = mapDeclineCode(entity);
        existing.razorpayError = {
          code: entity.error_code || null,
          reason: entity.error_reason || null,
          description: entity.error_description || null,
          source: entity.error_source || null,
          step: entity.error_step || null,
        };
      }
      if (incomingState === 'captured' && !existing.orderId) {
        existing.webhookDelivery = { attempts: 1, acknowledged: true, lastError: null };
      }

      // If a pending action was waiting for this payment to resolve, close it.
      if (incomingState === 'captured') {
        const pendingAction = store.actions.find(
          (a) => a.paymentId === entity.id && a.pending && !a.recovered
        );
        if (pendingAction) {
          pendingAction.pending = false;
          pendingAction.recovered = true;
          pendingAction.recoveredAmount = entity.amount || existing.amount;
          pendingAction.recoveredAt = new Date().toISOString();
          pendingAction.recoveredVia = `webhook:${event.event}`;
          const candidate = store.candidates.find((c) => c.id === pendingAction.candidateId);
          if (candidate) candidate.resolved = { by: 'webhook', at: pendingAction.recoveredAt, outcome: 'recovered' };
          markEmailPaid(pendingAction.candidateId);
          store.record({
            type: 'recovery_confirmed',
            candidateId: pendingAction.candidateId,
            paymentId: entity.id,
            actionId: pendingAction.id,
            amount: pendingAction.recoveredAmount,
            note: 'Pending real action resolved — payment captured event received.',
          });
        }
      }

      outcome = 'state_updated';
      store.markRealDirty();
    }
  }

  store.webhookLog.unshift({
    eventId,
    event: event.event,
    paymentId: entity?.id || null,
    outcome,
    at: new Date().toISOString(),
  });
  store.webhookLog = store.webhookLog.slice(0, 200);

  store.record({
    type: 'webhook',
    eventId,
    event: event.event,
    paymentId: entity?.id || null,
    outcome,
  });

  return { status: 200, body: { received: true, outcome } };
}
