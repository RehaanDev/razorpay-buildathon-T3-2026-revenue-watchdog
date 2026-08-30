import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPolicy } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, '..', 'data');
const SNAPSHOT = path.join(DATA_DIR, 'snapshot.json');
const REAL_SNAPSHOT = path.join(DATA_DIR, 'real-payments.json');

/**
 * Small file-backed store. Deliberately not a database: the point of the
 * prototype is the decision pipeline, and a zero-dependency store means the
 * reviewer runs `node server.js` and it works.
 *
 * The one part that behaves like a real system is `ledger` and `actions`:
 * append-only, idempotency-keyed, and never mutated in place.
 */
class Store {
  constructor() {
    this.reset();
  }

  reset() {
    this.merchants = [];
    this.customers = new Map();
    this.payments = [];
    this.paymentsById = new Map();
    this.subscriptions = [];
    this.orders = new Map();
    this.trainingRows = [];
    this.groundTruth = { plantedLeaks: [] };

    this.investigations = [];
    this.candidates = [];
    this.actions = [];
    this.emails = [];
    this.ledger = [];
    this.webhookLog = [];
    this.seenWebhookIds = new Set();
    this.idempotency = new Map();
    this.policy = { ...defaultPolicy };
    this.policyHistory = [];
    this.model = null;
    this.meta = { seededAt: null, lastCycleAt: null, cycles: 0, clock: null };
    this._realDirty = false;
  }

  addPayment(p) {
    // Idempotent on id. Real payments arrive over webhooks, which are
    // at-least-once, so the same payment will be offered more than once.
    const existing = this.paymentsById.get(p.id);
    if (existing) {
      Object.assign(existing, p);
      return existing;
    }
    this.payments.push(p);
    this.paymentsById.set(p.id, p);
    return p;
  }

  /** Every payment that came from the real Razorpay account. */
  realPayments() {
    return this.payments.filter((p) => p.source === 'razorpay');
  }

  markRealDirty() {
    this._realDirty = true;
  }

  /**
   * Append-only audit record. Every decision the system makes ends up here,
   * including the ones where it decided to do nothing.
   */
  record(entry) {
    const row = {
      seq: this.ledger.length + 1,
      at: new Date().toISOString(),
      ...entry,
    };
    this.ledger.push(row);
    return row;
  }

  /**
   * Idempotency guard. A recovery action is money-adjacent, so replaying the
   * same request must return the original result rather than firing twice.
   */
  withIdempotency(key, fn) {
    if (this.idempotency.has(key)) {
      return { ...this.idempotency.get(key), replayed: true };
    }
    const result = fn();
    this.idempotency.set(key, result);
    return { ...result, replayed: false };
  }

  persist() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const snap = {
        policy: this.policy,
        policyHistory: this.policyHistory.slice(-50),
        ledger: this.ledger.slice(-4000),
        meta: this.meta,
      };
      fs.writeFileSync(SNAPSHOT, JSON.stringify(snap));
    } catch {
      /* persistence is best-effort in the prototype */
    }
    this.persistReal();
  }

  /**
   * Real payments have to survive a restart.
   *
   * Synthetic traffic is regenerated from a seed on every boot, so losing it
   * costs nothing. A real payment cannot be regenerated: you made it by hand,
   * it cost you a trip through Razorpay Checkout, and it is the only evidence
   * the live path works. So real payments, the customers behind them, the
   * actions taken on them and the webhook ids already seen are written to a
   * separate file and reloaded before the first cycle runs.
   *
   * Seen webhook ids are persisted with them for a specific reason: without
   * that, restarting the server reopens the deduplication window, and a
   * redelivered `payment_link.paid` would be counted as a second recovery.
   */
  persistReal() {
    if (!this._realDirty) return;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const realPayments = this.realPayments();
      const realCustomerIds = new Set(realPayments.map((p) => p.customerId));
      const snap = {
        version: 1,
        savedAt: new Date().toISOString(),
        payments: realPayments,
        customers: [...this.customers.values()].filter((c) => realCustomerIds.has(c.id) || c.real),
        actions: this.actions.filter((a) => this.paymentsById.get(a.paymentId)?.source === 'razorpay'),
        emails: this.emails.filter((e) => e.real),
        orders: [...this.orders.values()].filter((o) => o.real),
        seenWebhookIds: [...this.seenWebhookIds],
        webhookLog: this.webhookLog.slice(0, 200),
        idempotency: [...this.idempotency.entries()],
      };
      fs.writeFileSync(REAL_SNAPSHOT, JSON.stringify(snap, null, 2));
      this._realDirty = false;
    } catch (e) {
      console.error('[store] could not persist real payments:', e.message);
    }
  }

  /** Rehydrate real payments after seeding, so both streams coexist. */
  loadReal() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(REAL_SNAPSHOT, 'utf8'));
    } catch {
      return { payments: 0, actions: 0 };
    }
    for (const c of raw.customers || []) this.customers.set(c.id, c);
    for (const p of raw.payments || []) this.addPayment(p);
    for (const o of raw.orders || []) this.orders.set(o.id, o);
    for (const a of raw.actions || []) {
      if (!this.actions.some((x) => x.id === a.id)) this.actions.push(a);
    }
    for (const em of raw.emails || []) {
      if (!this.emails.some((x) => x.id === em.id)) this.emails.push(em);
    }
    for (const e of raw.seenWebhookIds || []) this.seenWebhookIds.add(e);
    for (const [k, v] of raw.idempotency || []) this.idempotency.set(k, v);
    this.webhookLog = [...(raw.webhookLog || []), ...this.webhookLog].slice(0, 200);
    return { payments: (raw.payments || []).length, actions: (raw.actions || []).length };
  }

  loadPolicy() {
    try {
      const raw = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
      if (raw.policy) this.policy = { ...defaultPolicy, ...raw.policy };
      if (raw.policyHistory) this.policyHistory = raw.policyHistory;
    } catch {
      /* first run */
    }
  }
}

export const store = new Store();
