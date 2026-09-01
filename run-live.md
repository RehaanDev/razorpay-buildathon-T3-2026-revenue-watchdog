# Running Revenue Watchdog in Live Mode

A step-by-step walkthrough for demonstrating the full recovery loop on **real Razorpay
test-mode payments** — from a real failed checkout to a real recovery, shown live.

Everything here uses Razorpay **test mode**. No real money moves at any point.

---

## What "live mode" actually means

Most of Revenue Watchdog runs on seeded practice data — 13,629 payments across six
merchants — which exists to prove the decision logic and the statistics. Live mode is
different. The focus merchant, **Leaf & Loom** (`acc_LEAFANDLOOM`), has a real
storefront. Payments made through it are **real Razorpay test-mode payments**:

- They are created through Razorpay's real `POST /v1/orders` API.
- They open the real Razorpay Checkout modal from `checkout.razorpay.com`.
- They carry a `source: razorpay` marker, so the system always keeps them separate
  from the seeded rows and never gives them a fake outcome.
- They stay `pending` until Razorpay itself tells us the result.

So the numbers on the live path are the only numbers in the whole system that are not
downstream of an assumption. That is the point of this mode.

---

## One-time setup

You only need to do this once.

### 1. Get your keys

| Key | Where to get it |
|---|---|
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Razorpay Dashboard → Settings → API Keys → **Test mode** |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay Dashboard → Settings → Webhooks |
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey |

### 2. Fill in `.env`

```bash
cp .env.example .env
# open .env and fill in the keys above, then set:
RAZORPAY_MODE=live
```

### 3. Confirm everything is wired

```bash
npm run gemini-check   # confirms the Gemini key and which model it selected
npm run secrets        # confirms no secrets are committed
```

### 4. (Optional but recommended) Expose a webhook tunnel

Razorpay needs to reach your machine to deliver payment results automatically. In a
second terminal:

```bash
npx cloudflared tunnel --url http://localhost:4000
```

Put the resulting URL in `.env` as `PUBLIC_BASE_URL`, then register
`https://<tunnel>/api/razorpay/webhook` in the Razorpay dashboard for these events:
`payment.failed`, `payment.captured`, and `payment_link.paid`.

> **No tunnel? No problem.** If you skip this step, results won't arrive
> automatically — but the **Sync real payments from Razorpay** button (used below)
> pulls them directly from your account instead. The demo still works end to end.

### 5. Start the server

```bash
npm start
```

Open **http://localhost:4000**.

---

## The demo cycle (the one to present)

This is the exact sequence to walk through on stage. Each step says what to click,
what happens behind the scenes, and what to point at on screen.

### Step 1 — Start traffic

Go to the **Control room** tab. Click **Start traffic**.

- Normal payments begin flowing for all six merchants.
- Watch the success rate settle around **93%** — this is a healthy day.
- This gives the system a live "present" instead of just a seeded past.

**Say:** "This is normal traffic. Everything is healthy — about 93% of payments
succeed."

### Step 2 — Clear the day (start fresh)

Reset the day so the leak map starts clean and only shows what happens from now on.
This makes the real failure you are about to create easy to see, instead of buried
under other traffic.

**Say:** "I'll clear the day so we start fresh, and everything you see next is real."

### Step 3 — Go to the store

Open the storefront at **`/store.html`** (Leaf & Loom).

- This is a real shop — real products, a real cart.
- Add an item and click **Buy**.

**Say:** "This is a real store, on a real Razorpay account. Let me buy something."

### Step 4 — Purchase, and choose Netbanking

The real Razorpay Checkout modal opens (this is Razorpay's own screen, not a mock).

- Select **Netbanking** as the payment method.
- Netbanking shows a mock bank page with explicit **Success** and **Failure**
  buttons.

**Say:** "I'll pay with Netbanking — the same screen any real customer sees."

### Step 5 — Fail the payment on purpose

On the Netbanking page, click **Failure**.

*(Alternative for UPI: use the UPI ID `failure@razorpay` to force a failure. A card
`4111 1111 1111 1111` with any future expiry would succeed instead.)*

- Razorpay records this as a genuinely failed payment.
- If your webhook tunnel is set up, Razorpay sends `payment.failed` straight to
  Watchdog.

**Say:** "I'm failing this on purpose — because failed payments are exactly what this
system exists to recover."

### Step 6 — Come back to the Control room and sync

Return to Watchdog. In the **Control room**, click
**⟳ Sync real payments from Razorpay**.

- This pulls your account's payments directly from Razorpay.
- It works **even if the webhook tunnel isn't set up**, so the demo never depends on
  the tunnel.
- The failed payment you just made is ingested, tagged `source: razorpay`, and kept
  apart from all the seeded data.
- A message confirms how many payments were pulled and how many failed.

**Say:** "Now I sync from Razorpay. This pulls the real payments straight from the
account."

### Step 7 — See it become a recovery candidate

Open the **Leak map**, then the **Recovery queue**.

- The failed payment appears **immediately** as a recovery candidate — real failures
  are treated as facts, so they never wait for a statistical threshold.
- For that payment you now see: the decline reason, the model's estimated chance of
  recovery, and the policy engine's verdict — computed exactly the same way as for
  every seeded payment.

**Say:** "There it is. The system already knows why it failed and how likely we are to
get it back."

### Step 8 — Recover it

Approve the recovery action (or let an AUTO verdict run it).

- The system calls `POST /v1/payment_links` and gets back a **real `rzp.io` short
  link**, sent with an idempotency key so a retry can never double-charge.
- When that link is paid, Razorpay sends `payment_link.paid`.
- Watchdog verifies the signature, then marks the payment recovered — and attributes
  it back to the exact decision that caused it.

**Say:** "It creates a real payment link. When the customer pays it, we don't guess —
Razorpay tells us it's recovered, and we trace that rupee back to this exact decision."

### Step 9 — Check the Audit trail

Open the **Audit trail**.

- The full chain is recorded: the decision made, the guardrail that gated it, the
  action executed, and the recovery attributed to it.
- Decisions to *not* act are recorded too — a block is still a decision.

**Say:** "Everything is logged — even the times it chose to do nothing. Nothing is
hidden."

---

## About the Agent — "Gemini out of credits"

When you open the **Agent** tab and run an investigation, you may sometimes see a
message that **Gemini is out of credits** (or a quota / rate-limit error). This is
expected on the free tier and **it does not break the demo**.

**Why it happens:** the Agent uses Google's Gemini model (free tier). The free tier
has a daily limit. If you've run several investigations, or many people share the key,
Gemini can temporarily refuse with an "out of quota" / "resource exhausted" error.

**What the system does about it:** Watchdog is built so a model outage can never take
the investigation down with it. If Gemini fails for **any** reason — no key, out of
credits, rate limited, network error — the system automatically falls back to a
**deterministic investigator**. This fallback:

- Walks a fixed, rule-based path over the exact same read-only tools and data.
- Produces an investigation in the **same shape** as the Gemini one.
- Costs nothing and never fails on quota.
- Is clearly marked as `degraded: deterministic` with the reason, so you can see it
  switched.

**What to say if it happens on stage:** "That's Gemini's free-tier limit — and notice
the investigation still completed. The system falls back to a built-in investigator
automatically, so a model outage can never stop it from working. The AI is an
enhancement, not a dependency."

So whether Gemini answers or the fallback does, you always get a full investigation.
The only difference is that the Gemini version writes the reasoning in natural
language; the fallback follows fixed rules.

---

## How each moving part works (quick reference)

**The storefront (`/store.html`)** — a real Razorpay Checkout integration. Buying
creates a real test-mode order and payment on your account.

**Sync real payments from Razorpay** — pulls your account's full payment history
directly (paged, so nothing old is missed) and ingests every real payment. Use it
whenever a payment doesn't appear automatically. This is the reliable path that
doesn't need a webhook tunnel.

**detectRealFailures** — real failed payments become recovery candidates immediately,
with no time window and no volume threshold. They are observed facts, not statistical
guesses, so nothing gates whether your own test payment shows up.

**The model (recovery odds)** — estimates the chance of recovering each failed
payment, so the system can prioritise and choose a channel.

**The policy engine / guardrails** — the *only* thing that can authorise an action.
It is deterministic (fixed rules). It stops double-charging, over-contacting a
customer, and any action that fails a rule. The AI can suggest, but only this can
approve.

**Payment links** — recovery is done with a real `POST /v1/payment_links` call,
carrying an idempotency key so a retried request can never charge twice.

**Webhooks** — `payment.failed`, `payment.captured`, and `payment_link.paid` arrive
signed. Watchdog verifies the HMAC signature before reading them, ignores duplicates,
and ignores stale/out-of-order events. This is how an outcome stops being a guess.

**Attribution** — when a recovery lands, it is traced back to the specific decision
that produced it. Not "revenue went up" — *this* decision recovered *this* payment.

**The Agent (Gemini)** — investigates open leaks with eight **read-only** tools. It
can look and explain, but it physically cannot move money. If Gemini is unavailable,
the deterministic investigator takes over automatically.

**The Control room** — where you drive the live demo: start/pause traffic, and (in the
seeded simulator) break a bank on purpose to watch the system detect it. For the real
path, it's where you sync payments from Razorpay.

---

## Quick troubleshooting

| Symptom | Fix |
|---|---|
| Failed payment doesn't appear | Click **Sync real payments from Razorpay** in the Control room. |
| Agent says Gemini is out of credits | Expected on free tier — the deterministic fallback still completes the investigation. Wait for quota to reset, or add a fresh `GEMINI_API_KEY`. |
| Webhooks not arriving | Check the `cloudflared` tunnel is running and the webhook URL is registered in the Razorpay dashboard. Or just use Sync — it doesn't need the tunnel. |
| Nothing is live at all | Confirm `.env` has `RAZORPAY_MODE=live` and real test-mode keys, then restart `npm start`. |
| Real payment got a fake outcome | It shouldn't — real payments are tagged `source: razorpay` and stay `pending` until a webhook resolves them. If not, check the tunnel/sync. |

---

*All steps use Razorpay test mode. No real funds are moved at any point.*
