import { config } from '../src/config.js';
import { razorpay, signPayload } from '../src/razorpay/client.js';
import { handleWebhook } from '../src/razorpay/webhooks.js';
import { id, rupees } from '../src/lib/util.js';

/**
 * Live-mode preflight.
 *
 * Run this once before the demo. It proves, against the real Razorpay API with
 * your test-mode keys, that:
 *
 *   1. The credentials authenticate.
 *   2. A recovery payment link can actually be created.
 *   3. The idempotency key genuinely suppresses a duplicate, so a double-click
 *      cannot charge a customer twice.
 *   4. The webhook receiver verifies a real HMAC signature and rejects a forged
 *      one.
 *
 * It creates one payment link for ₹1 and nothing else. It never captures, never
 * refunds, and never touches a live key: the script refuses to run if the key id
 * does not start with rzp_test_.
 *
 *   RAZORPAY_MODE=live RAZORPAY_KEY_ID=rzp_test_xxx RAZORPAY_KEY_SECRET=xxx \
 *     node scripts/live-check.js
 */

const ok = (s) => console.log(`  \u2713 ${s}`);
const bad = (s) => console.log(`  \u2717 ${s}`);

async function main() {
  console.log('\nRazorpay live-mode preflight\n');

  if (config.razorpayMode !== 'live') {
    bad('RAZORPAY_MODE is not "live". Nothing to check — set it and re-run.');
    process.exit(1);
  }

  if (!config.razorpayKeyId || !config.razorpayKeySecret) {
    bad('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set.');
    process.exit(1);
  }

  // Hard stop. A public repo plus a live key is how people lose real money.
  if (!config.razorpayKeyId.startsWith('rzp_test_')) {
    bad(`Key id is "${config.razorpayKeyId.slice(0, 12)}...", which is not a test key.`);
    bad('This script refuses to run against live credentials. Use rzp_test_ keys.');
    process.exit(1);
  }
  ok('Key is a test-mode key');

  const reference = `preflight_${Date.now()}`;
  const idemKey = `rw:preflight:${reference}`;

  console.log('\nPayment link');
  let link;
  try {
    link = await razorpay.createPaymentLink({
      amount: 100, // ₹1
      customerName: 'Preflight Check',
      customerEmail: 'preflight@example.com',
      description: 'Revenue Watchdog preflight — safe to ignore',
      referenceId: reference,
      idempotencyKey: idemKey,
    });
    ok(`Created ${link.id} for ${rupees(link.amount)}`);
    ok(`Payable at ${link.short_url}`);
  } catch (e) {
    bad(`Could not create a payment link: ${e.message}`);
    console.log('\n  Common causes: wrong secret, payment links not enabled on the account,');
    console.log('  or the account not activated for test mode.\n');
    process.exit(1);
  }

  console.log('\nIdempotency');
  try {
    const again = await razorpay.createPaymentLink({
      amount: 100,
      customerName: 'Preflight Check',
      customerEmail: 'preflight@example.com',
      description: 'Revenue Watchdog preflight — safe to ignore',
      referenceId: reference,
      idempotencyKey: idemKey,
    });
    if (again.id === link.id) {
      ok(`Replay returned the same link ${again.id}. A double-click cannot double-charge.`);
    } else {
      bad(`Replay created a second link (${again.id}). Investigate before demoing.`);
    }
  } catch (e) {
    bad(`Replay failed: ${e.message}`);
  }

  console.log('\nWebhook signature');
  const event = {
    id: id('evt'),
    event: 'payment_link.paid',
    created_at: Math.floor(Date.now() / 1000),
    payload: {
      payment_link: {
        entity: { id: link.id, reference_id: reference, status: 'paid', amount: 100, amount_paid: 100 },
      },
    },
  };
  const raw = JSON.stringify(event);

  const forged = handleWebhook({ rawBody: raw, signature: 'deadbeef' });
  if (forged.status === 401) ok('Forged signature rejected with 401');
  else bad(`Forged signature returned ${forged.status}. That is a security hole.`);

  const real = handleWebhook({ rawBody: raw, signature: signPayload(raw) });
  if (real.status === 200) ok(`Valid signature accepted (outcome: ${real.body.outcome})`);
  else bad(`Valid signature returned ${real.status}`);

  const replay = handleWebhook({ rawBody: raw, signature: signPayload(raw) });
  if (replay.body?.deduplicated) ok('Replayed event deduplicated on event id');
  else bad('Replayed event was processed twice');

  console.log('\nPreflight complete.');
  console.log(`Open ${link.short_url} and pay it with a test card to see the full loop close.`);
  console.log('Razorpay test cards: https://razorpay.com/docs/payments/payments/test-card-details/\n');
}

main().catch((e) => {
  console.error('\nPreflight crashed:', e.message, '\n');
  process.exit(1);
});
