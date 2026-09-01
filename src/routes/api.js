import { store } from '../store.js';
import { config, DECLINE_TAXONOMY, defaultPolicy } from '../config.js';
import { runCycle, summarise, approveCandidate, rejectCandidate, scoreDetection } from '../pipeline/cycle.js';
import { simulate } from '../pipeline/policy.js';
import { fitModel } from '../pipeline/model.js';
import { seed } from '../seed/generator.js';
import { handleWebhook } from '../razorpay/webhooks.js';
import { signPayload, razorpay } from '../razorpay/client.js';
import { id } from '../lib/util.js';
import { startLive, stopLive, setSwitch, liveStatus, checkout, createOrder, PRODUCTS, scenario } from '../live.js';
import { investigate, driverStatus } from '../agent/loop.js';
import { injectionLog } from '../agent/guard.js';
import { compareSchedules, assessCongestion, fairnessCurve } from '../pipeline/coordinator.js';
import { capacityReport } from '../pipeline/capacity.js';

const json = (body, status = 200) => ({ status, body });

export async function route(method, pathname, query, body, raw, headers) {
  /* ---------------------------------------------------------------- state -- */
  if (method === 'GET' && pathname === '/api/overview') {
    return json({
      ...summarise(query.merchantId || config.focusMerchantId),
      merchants: store.merchants.map((m) => ({ id: m.id, name: m.name, category: m.category })),
      gatewayMode: razorpay.mode(),
      policy: store.policy,
      cycles: store.meta.cycles,
      lastCycleAt: store.meta.lastCycleAt,
      totalEvents: store.payments.length,
    });
  }

  if (method === 'GET' && pathname === '/api/investigations') {
    return json(
      store.investigations.map((i) => ({
        ...i,
        candidates: store.candidates
          .filter((c) => c.investigationId === i.id)
          .map(compactCandidate),
      }))
    );
  }

  if (method === 'GET' && pathname === '/api/investigation') {
    const inv = store.investigations.find((i) => i.id === query.id);
    if (!inv) return json({ error: 'not found' }, 404);
    return json({
      ...inv,
      candidates: store.candidates.filter((c) => c.investigationId === inv.id).map(compactCandidate),
    });
  }

  if (method === 'GET' && pathname === '/api/candidates') {
    let rows = store.candidates;
    if (query.verdict) rows = rows.filter((c) => c.policy.verdict === query.verdict);
    if (query.leakType) rows = rows.filter((c) => c.leakType === query.leakType);
    return json(rows.map(compactCandidate));
  }

  if (method === 'GET' && pathname === '/api/ledger') {
    const limit = Number(query.limit || 200);
    const type = query.type;
    let rows = store.ledger.slice().reverse();
    if (type) rows = rows.filter((r) => r.type === type);
    return json({ total: store.ledger.length, rows: rows.slice(0, limit) });
  }

  if (method === 'GET' && pathname === '/api/actions') {
    return json(store.actions.slice().reverse().slice(0, Number(query.limit || 200)));
  }

  if (method === 'GET' && pathname === '/api/webhooks') {
    return json({ log: store.webhookLog.slice(0, 60), secretConfigured: !!config.razorpayWebhookSecret });
  }

  if (method === 'GET' && pathname === '/api/model') {
    if (!store.model) fitModel();
    return json(store.model);
  }

  if (method === 'GET' && pathname === '/api/detection-score') {
    return json(scoreDetection());
  }

  if (method === 'GET' && pathname === '/api/taxonomy') {
    return json(DECLINE_TAXONOMY);
  }

  /* --------------------------------------------------------------- actions -- */
  if (method === 'GET' && pathname === '/api/emails') {
    const { outbox } = await import('../pipeline/emails.js');
    return json({ emails: outbox() });
  }

  if (method === 'POST' && pathname === '/api/emails/resolve') {
    const { resolveSimEmail } = await import('../pipeline/emails.js');
    const res = resolveSimEmail(body?.emailId, body?.outcome === 'paid' ? 'paid' : 'failed');
    if (res.error) return json(res, 400);
    const { summarise } = await import('../pipeline/cycle.js');
    return json({ ...res, summary: summarise() });
  }

  if (method === 'POST' && pathname === '/api/cycle') {
    const result = await runCycle({ merchantId: body?.merchantId || config.focusMerchantId });
    return json(result);
  }

  if (method === 'POST' && pathname === '/api/reseed') {
    seed({ clean: !!body?.clean });
    // seed() calls store.reset(), which clears real Razorpay payments too.
    // Those cannot be regenerated, so reload them from disk immediately. This
    // is what makes "Start from a healthy day" keep every real payment: the
    // synthetic leaks vanish, the real ones stay, and every downstream section
    // (leak map, recovery queue, agent, proof, audit) keeps working on them.
    const restored = store.loadReal();
    fitModel();
    const result = await runCycle({});
    return json({ ...result, realPaymentsRestored: restored.payments });
  }

  if (method === 'POST' && pathname === '/api/approve') {
    const res = await approveCandidate(body.candidateId, { action: body.action || null });
    return res?.error ? json(res, 400) : json({ ok: true, action: res, summary: summarise() });
  }

  if (method === 'POST' && pathname === '/api/reject') {
    const res = rejectCandidate(body.candidateId, { reason: body.reason });
    return res?.error ? json(res, 400) : json({ ok: true, summary: summarise() });
  }

  /**
   * Deliberate duplicate. Fires the same approval twice so a reviewer can watch
   * the idempotency key suppress the second one instead of charging twice.
   */
  if (method === 'POST' && pathname === '/api/approve-twice') {
    const first = await approveCandidate(body.candidateId, { action: body.action || null });
    const second = await approveCandidate(body.candidateId, { action: body.action || null });
    return json({
      first: first?.id,
      second: second?.id,
      sameAction: first?.id === second?.id,
      note:
        first?.id === second?.id
          ? 'The second request returned the first result. The customer was charged once.'
          : 'Two distinct actions were created, which would be a double charge.',
    });
  }

  /* ----------------------------------------------------------------- agent -- */
  if (method === 'POST' && pathname === '/api/agent/investigate') {
    const run = await investigate({
      merchantId: body?.merchantId || config.focusMerchantId,
      question: body?.question || null,
    });
    return json(run);
  }

  if (method === 'GET' && pathname === '/api/agent/runs') {
    return json({
      ...driverStatus(),
      runs: (store.agentRuns || []).map((r) => ({
        runId: r.runId,
        startedAt: r.startedAt,
        driver: r.driver,
        toolCalls: r.toolCalls,
        rejections: r.rejections,
        durationMs: r.durationMs,
        cost: r.cost,
        cause: r.proposal?.cause ?? null,
        posture: r.proposal?.posture ?? null,
        valid: r.validation?.valid ?? false,
      })),
    });
  }

  if (method === 'GET' && pathname === '/api/agent/run') {
    const run = (store.agentRuns || []).find((r) => r.runId === query.id) || (store.agentRuns || [])[0];
    if (!run) return json({ error: 'no runs yet' }, 404);
    return json(run);
  }

  if (method === 'GET' && pathname === '/api/injections') {
    return json({ attempts: injectionLog(50) });
  }

  /* ------------------------------------------------------------ congestion -- */
  if (method === 'GET' && pathname === '/api/congestion') {
    const issuer = query.issuer;
    if (!issuer) {
      // Whichever degraded issuer currently has the deepest network-wide queue.
      const issuers = [...new Set(store.payments.filter((p) => p.status === 'failed').map((p) => p.issuer))];
      const ranked = issuers
        .map((i) => ({ issuer: i, ...assessCongestion(i) }))
        .sort((a, b) => b.pending_retries_network_wide - a.pending_retries_network_wide);
      return json({ issuers: ranked.slice(0, 6) });
    }
    return json(assessCongestion(issuer));
  }

  if (method === 'GET' && pathname === '/api/congestion/capacity') {
    return json({
      issuers: capacityReport(),
      note:
        'Capacity is estimated from observed traffic where the traffic can identify it, and falls back to the documented assumption where it cannot. Every row says which, and why.',
    });
  }

  if (method === 'GET' && pathname === '/api/congestion/fairness') {
    const issuer = query.issuer || 'HDFC Netbanking';
    return json(fairnessCurve(issuer));
  }

  if (method === 'GET' && pathname === '/api/congestion/compare') {
    const issuer = query.issuer || 'HDFC Netbanking';
    return json(compareSchedules(issuer));
  }

  /* ------------------------------------------------------ live + storefront -- */
  if (method === 'GET' && pathname === '/api/products') {
    return json({ merchant: 'Leaf & Loom', products: PRODUCTS, razorpayMode: config.razorpayMode });
  }

  if (method === 'GET' && pathname === '/api/live') {
    return json(liveStatus());
  }

  if (method === 'POST' && pathname === '/api/live/start') {
    startLive();
    return json(liveStatus());
  }

  if (method === 'POST' && pathname === '/api/live/stop') {
    stopLive();
    return json(liveStatus());
  }

  if (method === 'POST' && pathname === '/api/scenario') {
    setSwitch(body.key, body.on);
    return json(liveStatus());
  }

  if (method === 'POST' && pathname === '/api/create-order') {
    const result = await createOrder(body);
    return json(result);
  }

  if (method === 'GET' && pathname === '/api/agent-status') {
    
    return json(driverStatus());
  }

  if (method === 'GET' && pathname === '/api/real-payments') {
    const real = store.realPayments().slice(-50).reverse();
    return json({ count: real.length, payments: real.map((p) => ({
      id: p.id, amount: p.amount, method: p.method, issuer: p.issuer,
      status: p.status, errorCode: p.errorCode, createdAt: p.createdAt, ingestedAt: p.ingestedAt,
    })) });
  }

  if (method === 'POST' && pathname === '/api/sync-payments') {
    // Webhook-free fallback: pull recent payments straight from Razorpay and
    // ingest any we don't already have. Use this if your webhook tunnel isn't
    // set up — click "Sync from Razorpay" in the UI and failed payments appear.
    try {
      const { ingestRealPayment } = await import('../razorpay/ingest.js');
      // Pull the full history (paged 100 at a time inside the client), not just
      // the most recent 30 — otherwise older failures never get ingested.
      const list = await razorpay.fetchRecentPayments({ count: 100 });
      const items = list.items || [];
      let ingested = 0;
      let failed = 0;
      for (const entity of items) {
        const existed = store.paymentsById.has(entity.id);
        ingestRealPayment(entity, { via: 'manual_sync' });
        if (!existed) ingested += 1;
        if (entity.status === 'failed') failed += 1;
      }
      const { runCycle, reconcilePayments } = await import('../pipeline/cycle.js');
      await runCycle({});
      // Also confirm any pending recovery links that have been paid, so Sync
      // closes the loop for recoveries too — not just new failures.
      const rec = await reconcilePayments();
      return json({ synced: items.length, newlyIngested: ingested, failedPayments: failed, recoveriesConfirmed: rec.recovered || 0 });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  if (method === 'POST' && pathname === '/api/reconcile') {
    // Lightweight: just check pending recovery links against Razorpay and
    // close any that were paid. Called by the UI poll and the "Check payments"
    // button. No reseed, no full cycle.
    try {
      const { reconcilePayments, summarise } = await import('../pipeline/cycle.js');
      const rec = await reconcilePayments();
      return json({ ...rec, summary: summarise() });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  if (method === 'POST' && pathname === '/api/checkout') {
    const result = checkout(body);
    if (result.error) return json(result, 400);
    return json(result);
  }

  /* -------------------------------------------------------------- policy --- */
  if (method === 'GET' && pathname === '/api/policy') {
    return json({ policy: store.policy, defaults: defaultPolicy, history: store.policyHistory });
  }

  if (method === 'POST' && pathname === '/api/policy/simulate') {
    return json(simulate(body || {}));
  }

  if (method === 'POST' && pathname === '/api/policy/apply') {
    const before = { ...store.policy };
    store.policy = { ...store.policy, ...body, version: store.policy.version + 1 };
    store.policyHistory.unshift({ at: new Date().toISOString(), before, after: { ...store.policy } });
    store.record({ type: 'policy_changed', before, after: store.policy });
    const result = await runCycle({});
    return json({ ok: true, policy: store.policy, summary: result });
  }

  /* ------------------------------------------------------------- webhooks -- */
  if (method === 'POST' && pathname === '/api/razorpay/webhook') {
    const sig = headers['x-razorpay-signature'];
    const res = handleWebhook({ rawBody: raw, signature: sig });
    return json(res.body, res.status);
  }

  /** Emits a correctly signed test webhook so the receiver can be exercised. */
  if (method === 'POST' && pathname === '/api/razorpay/simulate-webhook') {
    const payment = store.paymentsById.get(body?.paymentId) || store.payments.find((p) => p.status === 'captured');
    const event = {
      id: body?.eventId || id('evt'),
      event: body?.event || 'payment.captured',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: payment.id,
            amount: payment.amount,
            status: body?.status || 'captured',
            method: payment.method,
            error_code: body?.errorCode || null,
          },
        },
      },
    };
    const rawBody = JSON.stringify(event);
    const signature = body?.badSignature ? 'deadbeef' : signPayload(rawBody);
    const res = handleWebhook({ rawBody, signature });
    return json({ sent: event, result: res.body, status: res.status });
  }

  return json({ error: 'no route', pathname }, 404);
}

function compactCandidate(c) {
  return {
    id: c.id,
    investigationId: c.investigationId,
    leakType: c.leakType,
    paymentId: c.paymentId,
    customerName: c.customerName,
    amount: c.amount,
    errorCode: c.errorCode,
    declineClass: c.declineClass,
    declineLabel: c.declineLabel,
    retryable: c.retryable,
    arm: c.arm,
    chosen: c.chosen,
    alternatives: c.alternatives,
    policy: c.policy,
    resolved: c.resolved || null,
  };
}