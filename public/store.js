/* Leaf & Loom storefront.
 *
 * In LIVE mode: every Buy button opens a real Razorpay Checkout modal (test
 * keys, no real money). When you pay — or deliberately fail — a real webhook
 * arrives, the payment is ingested, and it appears in the watchdog within
 * seconds.
 *
 * In MOCK mode: checkout is simulated locally, exactly as before, so demos
 * work without any Razorpay keys.
 */

const rs = (p) => '\u20B9' + Math.round(p / 100).toLocaleString('en-IN');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const $ = (s) => document.querySelector(s);

let products = [];
let razorpayMode = 'mock'; // resolved from server on load

/* ---- deterministic woven swatch per product ------------------------------ */
function swatch(name, i) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  const warp = `hsl(${hue} 32% ${34 + (i % 3) * 6}%)`;
  const weft = `hsl(${(hue + 28) % 360} 24% ${72 - (i % 2) * 8}%)`;
  const w = 8 + (h % 5);
  return `
    <div class="swatch" style="background:${weft}">
      <svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 200 148" aria-hidden="true">
        <defs>
          <pattern id="w${i}" width="${w*2}" height="${w*2}" patternUnits="userSpaceOnUse">
            <rect width="${w*2}" height="${w*2}" fill="${weft}"/>
            <rect width="${w}" height="${w}" fill="${warp}"/>
            <rect x="${w}" y="${w}" width="${w}" height="${w}" fill="${warp}"/>
          </pattern>
        </defs>
        <rect width="200" height="148" fill="url(#w${i})" opacity=".92"/>
      </svg>
    </div>`;
}

/* ---- boot ---------------------------------------------------------------- */
async function load() {
  const [prodData, statusData] = await Promise.all([
    fetch('/api/products').then(r => r.json()),
    fetch('/api/agent-status').then(r => r.json()).catch(() => ({})),
  ]);
  products = prodData.products;
  razorpayMode = prodData.razorpayMode || 'mock';

  // Mode banner
  const chip = $('#modeChip');
  if (razorpayMode === 'live') {
    chip.innerHTML = `
      <span style="color:#16a34a;font-weight:600">&#9679; LIVE mode</span>
      &nbsp;— real Razorpay test-mode payments.
      Pay with test card <code>4111 1111 1111 1111</code> or UPI <code>failure@razorpay</code> to trigger a failure.
      ${statusData.driver ? `&nbsp;&middot;&nbsp;Agent: <strong>${statusData.driver}</strong> (${statusData.model || 'n/a'})` : ''}
      &nbsp;&middot;&nbsp;<a href="/">Watch in the console &rarr;</a>`;
  } else {
    chip.innerHTML = `
      <span style="color:#9a3412;font-weight:600">&#9679; MOCK mode</span>
      &nbsp;— simulated payments only. Set RAZORPAY_MODE=live in <code>.env</code> to use real Razorpay.
      &nbsp;&middot;&nbsp;<a href="/">Open the watchdog console &rarr;</a>`;
  }

  $('#grid').innerHTML = products.map((p, i) => `
    <article class="item">
      ${swatch(p.name, i)}
      <div class="item-body">
        <h3>${esc(p.name)}</h3>
        <p>${esc(p.detail)}</p>
        <div class="item-buy">
          <span class="price">${rs(p.price)}</span>
          <button class="btn" data-buy="${p.id}">Buy now</button>
        </div>
      </div>
    </article>`).join('');
}

/* ---- sheet --------------------------------------------------------------- */
function openSheet(product) {
  $('#sheet').hidden = false;
  renderSheet(product);
}

function renderSheet(product) {
  $('#sheetCard').innerHTML = `
    <h2>Checkout</h2>
    <p class="sub">One item, delivered in 3&ndash;5 days.</p>
    <div class="line"><span>${esc(product.name)}</span><em>${rs(product.price)}</em></div>
    <div class="line"><span>Shipping</span><em>Free</em></div>
    <div class="line"><span><strong>Total</strong></span><em><strong>${rs(product.price)}</strong></em></div>

    <div class="pay-label" style="margin-top:1.5rem">Your details (optional)</div>
    <input id="custName" class="text-input" placeholder="Name" style="width:100%;margin-bottom:.5rem">
    <input id="custEmail" class="text-input" placeholder="Email" style="width:100%;margin-bottom:.5rem">
    <input id="custPhone" class="text-input" placeholder="Phone (10 digits)" style="width:100%;margin-bottom:1rem">

    ${razorpayMode === 'live' ? `
      <div class="pay-label">Test credentials</div>
      <div style="font-size:.82rem;color:var(--text-dim);margin-bottom:1rem;line-height:1.6">
        Card: <code>4111 1111 1111 1111</code> &middot; Any future expiry &middot; Any CVV<br>
        UPI success: <code>success@razorpay</code><br>
        UPI failure: <code>failure@razorpay</code> &nbsp;&#8592; use this to trigger the watchdog
      </div>
    ` : `
      <div class="pay-label">Payment method</div>
      <div style="font-size:.82rem;color:var(--text-dim);margin-bottom:1rem">
        Mock mode: checkout is simulated without a real Razorpay Checkout popup.
      </div>
    `}

    <button class="btn btn-full" id="payBtn">
      ${razorpayMode === 'live' ? 'Pay with Razorpay' : 'Simulate payment'} &mdash; ${rs(product.price)}
    </button>
    <button class="btn btn-ghost btn-full" id="closeBtn" style="margin-top:.5rem">Cancel</button>
    <div id="payStatus" style="margin-top:1rem;min-height:1.5rem"></div>
  `;

  $('#closeBtn').onclick = () => { $('#sheet').hidden = true; };
  $('#payBtn').onclick = () => startPayment(product);
}

/* ---- payment flow -------------------------------------------------------- */
async function startPayment(product) {
  const btn = $('#payBtn');
  const status = $('#payStatus');
  btn.disabled = true;
  btn.textContent = 'Creating order…';
  status.textContent = '';

  const customerName = $('#custName').value.trim();
  const customerEmail = $('#custEmail').value.trim();
  const customerContact = $('#custPhone').value.trim();

  try {
    const order = await fetch('/api/create-order', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: product.id, customerName, customerEmail, customerContact }),
    }).then(r => r.json());

    if (order.error) throw new Error(order.error);

    if (order.mock) {
      // Mock mode: call the old simulated endpoint directly
      btn.textContent = 'Processing…';
      const result = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ productId: product.id, method: 'upi', issuer: 'UPI / Google Pay', customerName }),
      }).then(r => r.json());
      showResult(status, btn, result, product);
      return;
    }

    // Live mode — open Razorpay Checkout modal
    btn.textContent = 'Opening checkout…';
    openRazorpayCheckout(order, product, status, btn, customerName, customerEmail, customerContact);

  } catch (e) {
    status.innerHTML = `<span style="color:var(--red)">Error: ${esc(e.message)}</span>`;
    btn.disabled = false;
    btn.textContent = razorpayMode === 'live' ? 'Pay with Razorpay' : 'Simulate payment';
    btn.textContent += ` \u2014 ${rs(product.price)}`;
  }
}

function openRazorpayCheckout(order, product, statusEl, btn, name, email, contact) {
  const options = {
    key: order.keyId,
    amount: order.amount,
    currency: order.currency || 'INR',
    name: 'Leaf & Loom',
    description: order.product,
    image: '',
    order_id: order.orderId,
    prefill: { name, email, contact },
    notes: { product: order.product, source: 'leaf-and-loom-storefront' },
    theme: { color: '#1a1a1a' },
    handler: function(response) {
      // Payment succeeded
      statusEl.innerHTML = `
        <div style="color:var(--green);font-weight:600">&#10003; Payment successful!</div>
        <div style="font-size:.82rem;margin-top:.5rem;color:var(--text-dim)">
          Payment ID: <code>${esc(response.razorpay_payment_id)}</code><br>
          The watchdog received this over a signed webhook. Check the <a href="/?view=queue">Recovery queue</a>
          and <a href="/?view=audit">Audit trail</a>.
        </div>`;
      btn.textContent = 'Done';
      btn.disabled = true;
    },
    modal: {
      ondismiss: function() {
        statusEl.innerHTML = `<span style="color:var(--text-dim)">Payment cancelled.</span>`;
        btn.disabled = false;
        btn.textContent = `Pay with Razorpay \u2014 ${rs(order.amount)}`;
      }
    },
  };

  const rzp = new Razorpay(options);
  rzp.on('payment.failed', function(response) {
    statusEl.innerHTML = `
      <div style="color:var(--amber);font-weight:600">&#9888; Payment failed</div>
      <div style="font-size:.82rem;margin-top:.5rem;color:var(--text-dim)">
        Error: ${esc(response.error.description || response.error.reason || 'unknown')}<br>
        The watchdog will receive this failure over a webhook and add it to the Recovery queue.
        Check the <a href="/?view=map">Leak map</a> in a few seconds.
      </div>`;
    btn.disabled = false;
    btn.textContent = `Try again \u2014 ${rs(order.amount)}`;
  });

  rzp.open();
  btn.disabled = false;
  btn.textContent = `Pay with Razorpay \u2014 ${rs(order.amount)}`;
}

function showResult(statusEl, btn, result, product) {
  if (result.status === 'captured') {
    statusEl.innerHTML = `<span style="color:var(--green);font-weight:600">&#10003; Simulated payment captured. Check the watchdog.</span>`;
  } else {
    statusEl.innerHTML = `
      <span style="color:var(--amber);font-weight:600">&#9888; Simulated failure: ${esc(result.errorCode)}</span>
      <span style="display:block;font-size:.82rem;color:var(--text-dim);margin-top:.25rem">
        This appears in the Recovery queue in the watchdog.
      </span>`;
  }
  btn.disabled = false;
  btn.textContent = `${razorpayMode === 'live' ? 'Pay with Razorpay' : 'Simulate payment'} \u2014 ${rs(product.price)}`;
}

/* ---- event delegation ---------------------------------------------------- */
document.addEventListener('click', (e) => {
  const productId = e.target.dataset?.buy;
  if (productId) {
    const product = products.find(p => p.id === productId);
    if (product) openSheet(product);
  }
});

load();
