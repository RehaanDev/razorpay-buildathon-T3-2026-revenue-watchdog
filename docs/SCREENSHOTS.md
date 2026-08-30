# Screenshot checklist — 25 images

The README references every file below. Until all of them exist, the repo landing
page shows broken icons. Capture them before pushing, or comment the tags out.

**Shoot them as a set.** Same browser width (1440px), same zoom (100%), same
theme throughout. PNG. Crop to the panel, not the whole window. Nothing looks
more unfinished than a README of screenshots at eight different sizes.

**Before you start:** run `npm run evals` so the guardrails log has real
quarantined entries, and `npm run accumulate` so you can capture the terminal.

**Before you push:** check every frame for a visible `rzp_test_` key, tunnel URL,
or `GEMINI_API_KEY`. `npm run secrets` scans the repo, not your images.

---

## Two per section

| File | Section | What must be visible |
|---|---|---|
| `leak-map-1.png` | Leak map | The landing view on boot, at-risk revenue bucketed by cause. |
| `leak-map-2.png` | Leak map | A bucket expanded to the payments underneath it. |
| `recovery-queue-1.png` | Recovery queue | AUTO, REVIEW and BLOCK badges together in one frame. |
| `recovery-queue-2.png` | Recovery queue | One candidate expanded, showing the policy engine's reasoning. |
| `guardrails-1.png` | Guardrails | A quarantined injection attempt with its verdict. |
| `guardrails-2.png` | Guardrails | An injected description replaced rather than passed through. |
| `agent-1.png` | Agent | The tool-call trace: which of the eight tools, in what order. |
| `agent-2.png` | Agent | The conclusion, with claims carrying their factIds. |
| `congestion-1.png` | Congestion | Offered load against estimated issuer capacity. |
| `congestion-2.png` | Congestion | The coordinated schedule, with deferrals visible. |
| `proof-1.png` | Proof | Control and treatment arms, holdout split, significance gate. |
| `proof-2.png` | Proof | Terminal output of `npm run accumulate` with the pooled block. |
| `audit-1.png` | Audit trail | One full chain: decision, gate, execution, attribution. |
| `audit-2.png` | Audit trail | A ledger entry for a blocked action. |
| `control-room-1.png` | Control room | Scenario planting and the policy thresholds. |
| `control-room-2.png` | Control room | A policy change simulated before being applied. |
| `inbox-1.png` | Shopper Side Email INBOX | A generated recovery link sitting in the inbox. |
| `inbox-2.png` | Shopper Side Email INBOX | The mail opened, showing what the shopper receives. |
| `capacity.png` | Congestion, "What is assumed here" | The estimator declining, with its stated reason. |
| `webhook-log.png` | Webhooks | A duplicate ignored and a late event logged but not applied. |

**`inbox-1` and `inbox-2` need a setup step.** AUTO will not fill the inbox:
soft declines are retried silently and never generate mail. Approve a REVIEW
candidate whose action is a payment link first. This is correct behaviour, and
worth saying out loud in the video rather than letting an empty inbox read as a
bug.

**`guardrails-1` and `guardrails-2` need `npm run evals` first**, or the
injection log is empty.

## Live path, Leaf & Loom, real Razorpay test mode

Requires `RAZORPAY_MODE=live`, a tunnel, and webhooks registered. Shoot these in
order in one sitting; they tell a single story and mismatched state between
frames will show.

| File | What must be visible |
|---|---|
| `live-storefront.png` | Leaf & Loom storefront, item in cart, before checkout. |
| `live-checkout.png` | The real Razorpay Checkout modal. Enter UPI `failure@razorpay`. |
| `live-payment.png` | The payment under Real payments, tagged `source: razorpay`. |
| `live-candidate.png` | The same payment as a candidate, with decline class and verdict. |
| `live-link.png` | The generated link showing its `rzp.io` short URL. |
| `live-webhook.png` | `payment_link.paid` in the webhook log, HMAC verified. |
| `live-attributed.png` | The recovery attributed back to the deciding action. |

---

## If you run out of time

Capture these six and comment the rest of the tags out:
`leak-map-1`, `congestion-1`, `agent-1`, `proof-2`, `live-checkout`,
`live-webhook`.

Those six carry the whole argument: the problem, the coordination fix, the agent,
the measured result, and proof the Razorpay integration is real on both the
outbound and the inbound side.