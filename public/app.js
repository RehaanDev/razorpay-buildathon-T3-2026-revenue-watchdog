/* Revenue Watchdog console. No framework: one state object, one render call. */

const S = { overview: null, investigations: [], view: 'map', openInvestigation: null, ledger: null, live: null, agentRun: null, agentMeta: null, injections: [], congestion: null, emails: [] };

const $ = (sel) => document.querySelector(sel);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

const rs = (paise) => '\u20B9' + Math.round(paise / 100).toLocaleString('en-IN');
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hhmm = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
const dt = (iso) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

async function api(path, opts) {
  const res = await fetch(path, opts);
  return res.json();
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3600);
}

/* ------------------------------------------------------------------ load -- */
async function load() {
  S.overview = await api('/api/overview');
  S.investigations = await api('/api/investigations');
  const o = S.overview;
  $('#gatewayMode').textContent = o.gatewayMode;
  $('#eventCount').textContent = o.totalEvents.toLocaleString('en-IN');
  $('#cycleCount').textContent = o.cycles;
  $('#clock').textContent = dt(o.clock);
  $('#queueCount').textContent = o.safety.verdicts.REVIEW || 0;
  try {
    const em = await api('/api/emails');
    S.emails = em.emails || [];
    const ic = $('#inboxCount');
    if (ic) {
      const unread = S.emails.filter((e) => e.status === 'sent').length;
      ic.textContent = S.emails.length;
      ic.style.background = unread > 0 ? '#2563eb' : '#9ca3af';
    }
  } catch { /* emails endpoint optional */ }
  const m = o.merchants.find((x) => x.id === o.merchantId);
  $('#railMerchant').textContent = m ? m.name : o.merchantId;
  render();
}

/* ------------------------------------------------------- leak river (SVG) -- */
/*
  Widths are proportional to rupees. Processed volume enters left; the at-risk
  slice is drawn against it at true scale, which is the honest picture: leakage
  is a thin ribbon off a wide river, and it still adds up to real money.
*/
function river(map) {
  const W = 980, H = 178;
  const f = map.flow;
  const streams = [
    { label: 'Recovered', value: f.recovered, color: 'var(--green)' },
    { label: 'Waiting on a decision', value: f.awaiting, color: 'var(--blue)' },
    { label: 'Stopped by a guardrail', value: f.blocked, color: 'var(--rose)' },
    { label: 'Tried, did not come back', value: f.attemptedNotRecovered, color: 'var(--dimmer)' },
  ].filter((s) => s.value > 0);

  const total = streams.reduce((a, s) => a + s.value, 0) || 1;
  const trunkH = 96;
  const scale = map.processed > 0 ? Math.max(trunkH * (map.atRisk / map.processed), 26) : 26;
  const bandH = Math.min(Math.max(scale, 34), 118);

  const x0 = 118, x1 = 400, x2 = 640, x3 = 940;
  const midY = H / 2;
  let y = midY - bandH / 2;

  const paths = streams.map((s) => {
    const h = Math.max((s.value / total) * bandH, 3);
    const yStart = midY;
    const yEnd = y + h / 2;
    y += h + 4;
    return `
      <path d="M ${x1} ${yStart} C ${(x1 + x2) / 2} ${yStart}, ${(x1 + x2) / 2} ${yEnd}, ${x2} ${yEnd}"
            fill="none" stroke="${s.color}" stroke-width="${h}" stroke-linecap="round" opacity=".72"/>
      <path class="flowline" d="M ${x2} ${yEnd} L ${x3 - 118} ${yEnd}" fill="none" stroke="${s.color}" stroke-width="${h}" stroke-linecap="round" opacity=".9"/>
      <text x="${x3 - 108}" y="${yEnd - 3}" fill="var(--ink)" font-family="IBM Plex Mono" font-size="12">${rs(s.value)}</text>
      <text x="${x3 - 108}" y="${yEnd + 11}" fill="var(--dimmer)" font-family="IBM Plex Sans" font-size="10.5">${esc(s.label)}</text>
    `;
  }).join('');

  return `
  <div class="river">
    <div class="river-head">
      <h2>Where the money went in the last 24 hours</h2>
      <span>band heights are proportional to rupees</span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Flow of processed revenue into recovered, recoverable, held and lost streams">
      <path d="M 8 ${midY} L ${x1} ${midY}" stroke="var(--line)" stroke-width="${trunkH}" stroke-linecap="round" opacity=".55"/>
      <text x="20" y="${midY - 6}" fill="var(--ink)" font-family="IBM Plex Mono" font-size="14">${rs(map.processed)}</text>
      <text x="20" y="${midY + 12}" fill="var(--dim)" font-family="IBM Plex Sans" font-size="11">processed</text>
      <path class="flowline" d="M ${x0 + 190} ${midY} L ${x1} ${midY}" stroke="var(--amber)" stroke-width="${bandH}" stroke-linecap="round" opacity=".8"/>
      <text x="${x1 - 96}" y="${midY - bandH / 2 - 10}" fill="var(--amber)" font-family="IBM Plex Mono" font-size="13">${rs(map.atRisk)} at risk</text>
      ${paths}
    </svg>
    <div class="river-legend">
      ${streams.map((s) => `<div><i style="background:${s.color}"></i>${esc(s.label)} <b>${rs(s.value)}</b></div>`).join('')}
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ views -- */
function viewMap() {
  const o = S.overview;
  const v = o.safety.verdicts;
  return `
    ${river(o.leakMap)}

    <div class="tiles">
      <div class="tile risk"><label>At risk</label><div class="v">${rs(o.leakMap.atRisk)}</div><div class="sub">${(v.AUTO || 0) + (v.REVIEW || 0) + (v.BLOCK || 0)} payments across ${o.investigations.length} leaks</div></div>
      <div class="tile"><label>Judged recoverable</label><div class="v">${rs(o.leakMap.recoverable)}</div><div class="sub">expected value, not face value</div></div>
      <div class="tile good"><label>Recovered so far</label><div class="v">${rs(o.leakMap.recovered)}</div><div class="sub">verified against the gateway</div></div>
      <div class="tile stop"><label>Held by guardrails</label><div class="v">${rs(o.safety.totalForegone)}</div><div class="sub">${v.BLOCK || 0} actions stopped</div></div>
    </div>

    <div class="section-label">Open investigations</div>
    ${S.investigations.map(investigationCard).join('') || '<div class="card"><div class="empty">Nothing is leaking right now.</div></div>'}
  `;
}

function investigationCard(inv) {
  const chip =
    inv.leakType === 'real_failures' ? '<span class="chip" style="background:#dcfce7;color:#166534;border-color:#86efac">● REAL — from your Razorpay account</span>'
    : inv.network?.verdict === 'upstream' ? '<span class="chip network">upstream, network-wide</span>'
    : inv.network?.verdict === 'merchant_local' ? '<span class="chip local">local to this account</span>'
    : inv.diagnosis.verdict === 'requires_human' ? '<span class="chip human">needs a person</span>'
    : '<span class="chip">segmented by decline</span>';

  return `
  <div class="card">
    <div class="card-head">
      <div>
        <h3>${esc(inv.title)}</h3>
        <div style="margin-top:7px;display:flex;gap:7px;flex-wrap:wrap">
          ${chip}
          <span class="chip">${inv.candidates.length} payments</span>
          ${inv.detection.changePoint ? `<span class="chip">started ${hhmm(inv.detection.changePoint)}</span>` : ''}
        </div>
      </div>
      <div class="amount-flag">${rs(inv.amountAtRisk)}</div>
    </div>
    <p class="lead">${esc(inv.diagnosis.summary)}</p>
    <div class="rowbtns">
      <button class="btn btn-primary" data-open="${inv.id}">Why?</button>
    </div>
  </div>`;
}

function viewInvestigation(inv) {
  const auto = inv.candidates.filter((c) => c.policy.verdict === 'AUTO').length;
  const review = inv.candidates.filter((c) => c.policy.verdict === 'REVIEW').length;
  const block = inv.candidates.filter((c) => c.policy.verdict === 'BLOCK').length;

  return `
  <button class="back" data-back="1">&larr; Back to the leak map</button>

  <div class="card">
    <div class="card-head">
      <h3>${esc(inv.title)}</h3>
      <div class="amount-flag">${rs(inv.amountAtRisk)}</div>
    </div>
    <p class="lead">${esc(inv.diagnosis.summary)}</p>

    <div class="section-label" style="margin-top:22px">The evidence, in order</div>
    <ul class="evidence">${inv.diagnosis.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>

    ${inv.network ? networkStrip(inv) : ''}

    <div class="note"><strong style="color:var(--ink)">What to do:</strong> ${esc(inv.diagnosis.recommendedPosture)}</div>
  </div>

  <div class="section-label">Recovery plan &mdash; ${auto} automatic, ${review} for review, ${block} stopped</div>
  ${candidateTable(inv.candidates)}
  `;
}

function networkStrip(inv) {
  const n = inv.network;
  const self = S.overview.merchantId;
  return `
  <div class="netstrip">
    <div class="section-label" style="margin:0 0 10px">${esc(n.issuer)} across every merchant on the network, same window</div>
    ${n.perMerchant.map((m) => {
      const w = Math.max(m.rate * 100, 2);
      const colour = m.degraded ? 'var(--amber)' : 'var(--green)';
      return `
      <div class="netrow ${m.merchantId === self ? 'is-self' : ''}">
        <span>${esc(m.merchantName)}${m.merchantId === self ? ' (you)' : ''}</span>
        <div class="netbar"><i style="width:${w}%;background:${colour}"></i><u style="left:${(m.baselineRate * 100).toFixed(1)}%"></u></div>
        <em style="color:${colour}">${pct(m.rate)}</em>
      </div>`;
    }).join('')}
    <p style="font-size:12.5px;color:var(--dimmer);margin-top:11px">
      The tick on each bar is that merchant's own 30-day baseline for this instrument.
      ${n.verdict === 'upstream'
        ? `${n.merchantsDegraded} of ${n.merchantsObserved} merchants dropped together, which is what makes this the bank and not your checkout.`
        : `Only you dropped. Everyone else is at their baseline, which is what makes this your account and not the bank.`}
    </p>
  </div>`;
}

function candidateTable(cands, { actions = false } = {}) {
  if (!cands.length) return '<div class="table-wrap"><div class="empty">Nothing here.</div></div>';
  return `
  <div class="table-wrap"><div class="table-scroll">
  <table class="table">
    <thead><tr>
      <th>Customer</th><th>Amount</th><th>Why it failed</th><th>Chosen action</th>
      <th>Recovery odds</th><th>Expected</th><th>Verdict</th>${actions ? '<th></th>' : ''}
    </tr></thead>
    <tbody>
    ${cands.map((c) => `
      <tr>
        <td>${esc(c.customerName)}<div class="arm ${c.arm}">${c.arm === 'control' ? 'holdout \u2014 naive path' : 'treatment'}</div></td>
        <td class="n">${rs(c.amount)}</td>
        <td>${esc(c.declineLabel)}<div style="font-size:11px;color:var(--dimmer);font-family:var(--mono)">${esc(c.errorCode || '\u2014')} \u00b7 ${esc(c.declineClass)}${c.retryable ? '' : ' \u00b7 not retryable'}</div></td>
        <td>${esc(c.chosen.label)}${c.chosen.costsContact ? `<div style="font-size:11px;color:var(--dimmer)">sends ${hhmm(c.chosen.scheduledFor)}</div>` : ''}</td>
        <td class="n">${pct(c.chosen.probability, 0)}</td>
        <td class="n">${rs(c.chosen.expectedValue)}</td>
        <td><span class="verdict ${c.policy.verdict}">${c.policy.verdict}</span><div style="font-size:11px;color:var(--dimmer);margin-top:3px;max-width:210px">${esc(c.policy.reason)}</div></td>
        ${actions ? `<td style="white-space:nowrap">${c.resolved
            ? (c.resolved.outcome === 'pending'
                ? '<span class="chip" style="background:#fef9c3;color:#854d0e;border-color:#fde047">&#8987; waiting for payment</span>'
                : c.resolved.outcome === 'recovered'
                  ? '<span class="chip" style="background:#dcfce7;color:#166534;border-color:#86efac">&#10003; recovered</span>'
                  : c.resolved.outcome === 'rejected'
                    ? '<span class="chip">rejected</span>'
                    : '<span class="chip" style="background:#fee2e2;color:#991b1b;border-color:#fca5a5">not recovered</span>')
            : `<button class="btn btn-primary" data-approve="${c.id}">Approve</button> <button class="btn btn-quiet" data-reject="${c.id}">Reject</button>`}</td>` : ''}
      </tr>`).join('')}
    </tbody>
  </table>
  </div></div>`;
}

function viewQueue() {
  const all = S.investigations.flatMap((i) => i.candidates);
  const review = all.filter((c) => c.policy.verdict === 'REVIEW' && !c.resolved);
  const blocked = all.filter((c) => c.policy.verdict === 'BLOCK');
  const pending = all.filter((c) => c.resolved?.outcome === 'pending');
  const recovered = all.filter((c) => c.resolved?.outcome === 'recovered');
  const notRecovered = all.filter((c) => c.resolved && (c.resolved.outcome === 'not_recovered' || c.resolved.outcome === 'rejected'));

  const recoveredTotal = recovered.reduce((a, c) => a + c.amount, 0);

  return `
  <div class="card">
    <p class="lead" style="margin:0">Actions the system will not take on its own. Each names the gate it failed to clear, so approving is a decision about that specific gate. Once approved, an emailed recovery waits for the shopper to pay before it counts as recovered.</p>
  </div>

  <div class="section-label">Waiting on you &mdash; ${review.length} actions, ${rs(review.reduce((a, c) => a + c.chosen.expectedValue, 0))} expected</div>
  ${candidateTable(review, { actions: true })}

  ${pending.length ? `
  <div class="section-label" style="color:#854d0e">&#8987; Waiting for the shopper to pay &mdash; ${pending.length}</div>
  ${candidateTable(pending, { actions: true })}` : ''}

  ${recovered.length ? `
  <div class="section-label" style="color:#166534">&#10003; Recovered &mdash; ${recovered.length} payments, ${rs(recoveredTotal)} back</div>
  ${candidateTable(recovered, { actions: true })}` : ''}

  ${notRecovered.length ? `
  <div class="section-label" style="color:#991b1b">Not recovered &mdash; ${notRecovered.length}</div>
  ${candidateTable(notRecovered, { actions: true })}` : ''}

  <div class="section-label">Stopped outright &mdash; ${blocked.length} actions</div>
  ${candidateTable(blocked)}
  `;
}

function viewEmails() {
  const emails = S.emails || [];
  const real = emails.filter((e) => e.real);
  const sim = emails.filter((e) => !e.real);

  const statusChip = (e) => {
    if (e.status === 'paid') return '<span class="chip" style="background:#dcfce7;color:#166534;border-color:#86efac">&#10003; PAID</span>';
    if (e.status === 'expired') return '<span class="chip" style="background:#fee2e2;color:#991b1b;border-color:#fca5a5">&#10005; EXPIRED (24h)</span>';
    return '<span class="chip" style="background:#fef9c3;color:#854d0e;border-color:#fde047">&#8987; WAITING FOR PAYMENT</span>';
  };

  const card = (e) => {
    const paid = e.status === 'paid';
    const expired = e.status === 'expired';
    const borderColor = paid ? '#16a34a' : expired ? '#dc2626' : e.real ? '#2563eb' : '#9ca3af';
    const linkBlock = e.real
      ? `<a href="${esc(e.link || '#')}" target="_blank" rel="noopener" class="btn btn-primary" style="text-decoration:none;display:inline-block;margin-top:10px${expired ? ';opacity:.5;pointer-events:none' : ''}">Open real payment link &rarr;</a>`
      : `<div class="chip" style="margin-top:10px">Simulated link (no working URL for fake merchants)</div>`;

    // Green/red controls only for SIMULATED emails still waiting.
    const simControls = (!e.real && e.status === 'sent')
      ? `<div style="display:flex;gap:8px;margin-top:12px">
           <button class="btn" data-sim-paid="${e.id}" style="background:#16a34a;color:#fff;border-color:#16a34a">&#10003; Shopper paid &rarr; Recovered</button>
           <button class="btn" data-sim-failed="${e.id}" style="background:#dc2626;color:#fff;border-color:#dc2626">&#10005; Didn't pay &rarr; Failed</button>
         </div>
         <div style="font-size:.72rem;color:var(--dimmer);margin-top:6px">Simulated shoppers have no real link, so you decide the outcome here. Real payments resolve automatically from Razorpay.</div>`
      : '';

    return `
    <div class="card" style="border-left:4px solid ${borderColor}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
        <div>
          <div style="font-size:.78rem;color:var(--dim)">To: <strong style="color:var(--ink)">${esc(e.to)}</strong></div>
          <div style="font-size:.78rem;color:var(--dim)">From: ${esc(e.from)}</div>
        </div>
        <div style="text-align:right">
          ${e.real
            ? '<span class="chip" style="background:#dbeafe;color:#1e40af;border-color:#93c5fd">REAL link</span>'
            : '<span class="chip">SIMULATED</span>'}
          ${e.variant === 'try_another_method' ? '<span class="chip" style="margin-left:6px;background:#fef3c7;color:#92400e;border-color:#fcd34d">try another method</span>' : ''}
          <div style="margin-top:6px">${statusChip(e)}</div>
        </div>
      </div>
      <div style="font-weight:600;margin:10px 0 6px;color:var(--ink)">${esc(e.subject)}</div>
      <pre style="white-space:pre-wrap;font-family:inherit;font-size:.85rem;color:var(--dim);margin:0;line-height:1.6">${esc(e.body)}</pre>
      ${linkBlock}
      ${simControls}
      <div style="font-size:.72rem;color:var(--dimmer);margin-top:10px">${esc(e.paymentId)} &middot; sent ${dt(e.at)}${paid && e.paidAt ? ' &middot; paid ' + dt(e.paidAt) : ''}${expired && e.expiredAt ? ' &middot; expired ' + dt(e.expiredAt) : ''}</div>
    </div>`;
  };

  return `
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
      <h3 style="margin:0">Email INBOX &mdash; shopper-side simulator</h3>
      <button class="btn btn-primary" id="reconcileBtn">&#8635; Check for payments now</button>
    </div>
    <p class="lead" style="margin:10px 0 0">When you approve a recovery, the shopper gets an email with a link to complete the payment. This is that outbox. An email is only ever composed for a failure the shopper can actually act on:</p>
    <div style="margin-top:10px;font-size:.82rem;color:var(--dim);line-height:1.8">
      &bull; <strong style="color:var(--ink)">Platform / bank / temporary failure</strong> &rarr; "finish it in seconds" email with a link.<br>
      &bull; <strong style="color:var(--ink)">Dead card / invalid UPI</strong> &rarr; "that method won't work, try another within 24h" email.<br>
      &bull; <strong style="color:var(--ink)">Revoked mandate / account closed / fraud</strong> &rarr; <strong>no email</strong> (nothing the shopper can do).
    </div>
    <div style="margin-top:10px;font-size:.82rem;color:var(--dim)">
      Real Razorpay payments carry a real working link and resolve automatically when paid (or expire after 24h unpaid). Fake-merchant emails carry a placeholder and are resolved with the green/red buttons.
    </div>
  </div>

  <div class="section-label">Real Razorpay emails &mdash; ${real.length}</div>
  ${real.length ? real.map(card).join('') : '<div class="card"><div class="empty">No real recovery emails yet. Fail a real payment on the storefront, sync it, then approve it in the Recovery queue.</div></div>'}

  <div class="section-label">Simulated (fake merchant) emails &mdash; ${sim.length}</div>
  ${sim.length ? sim.map(card).join('') : '<div class="card"><div class="empty">No simulated emails yet. Approve a recoverable fake-merchant candidate in the Recovery queue.</div></div>'}
  `;
}

function viewSafety() {
  const o = S.overview;
  const v = o.safety.verdicts;
  const p = o.policy;
  return `
  <div class="tiles">
    <div class="tile good"><label>Ran automatically</label><div class="v">${v.AUTO || 0}</div><div class="sub">every gate cleared</div></div>
    <div class="tile risk"><label>Sent for review</label><div class="v">${v.REVIEW || 0}</div><div class="sub">a person decides</div></div>
    <div class="tile stop"><label>Stopped</label><div class="v">${v.BLOCK || 0}</div><div class="sub">${rs(o.safety.totalForegone)} of expected value given up</div></div>
    <div class="tile"><label>Unauthorised actions</label><div class="v">${o.safety.unauthorisedActions}</div><div class="sub">nothing ran without a rule permitting it</div></div>
  </div>

  <div class="card">
    <h3>What the guardrails cost</h3>
    <p>Safety is usually presented as free. It is not. Every stopped action had expected value attached, and this is the bill for the caution. A merchant who thinks the number is too high can move a gate below and see exactly what changes before turning it on.</p>
    <div style="margin-top:15px">
      ${o.safety.blockedByRule.map((r) => `
        <div class="kv"><span>${esc(r.rule.replace(/_/g, ' '))} <span class="chip" style="margin-left:6px">${r.count}</span></span><em style="color:var(--rose)">${rs(r.foregone)} given up</em></div>
      `).join('') || '<div class="empty">Nothing was stopped this cycle.</div>'}
    </div>
  </div>

  <div class="card">
    <h3>Policy studio</h3>
    <p>Change a gate, then replay every decision in today's cycle against it. Nothing takes effect until you apply it.</p>
    <div style="margin-top:14px">
      <div class="field"><label>Minimum recovery probability for automatic action</label>
        <input type="range" id="pMinProb" min="0.3" max="0.95" step="0.01" value="${p.minRecoveryProbability}">
        <output id="oMinProb">${pct(p.minRecoveryProbability, 0)}</output></div>
      <div class="field"><label>Minimum expected value worth acting on</label>
        <input type="range" id="pMinEV" min="0" max="100000" step="2500" value="${p.minExpectedValuePaise}">
        <output id="oMinEV">${rs(p.minExpectedValuePaise)}</output></div>
      <div class="field"><label>Automatic action ceiling per payment</label>
        <input type="range" id="pCeil" min="100000" max="10000000" step="100000" value="${p.autoActionCeilingPaise}">
        <output id="oCeil">${rs(p.autoActionCeilingPaise)}</output></div>
      <div class="field"><label>Contacts allowed per customer per 30 days</label>
        <input type="range" id="pContacts" min="0" max="6" step="1" value="${p.maxContactsPer30d}">
        <output id="oContacts">${p.maxContactsPer30d}</output></div>
      <div class="field"><label>Suppress retries while the instrument is degraded</label>
        <input type="checkbox" id="pSuppress" ${p.suppressDuringNetworkOutage ? 'checked' : ''}></div>
      <div class="field"><label>Allow automatic refunds</label>
        <input type="checkbox" id="pRefund" ${p.allowAutomaticRefund ? 'checked' : ''} disabled>
        <output style="color:var(--dimmer)">locked off</output></div>
    </div>
    <div class="rowbtns">
      <button class="btn" id="simulate">Replay today against this</button>
      <button class="btn btn-primary" id="applyPolicy">Apply and re-run</button>
    </div>
    <div id="simOut"></div>
    <div class="note">Automatic refunds are not a slider. There is no probability at which an unattended process should move money out of a merchant's account: a wrong retry costs a failed attempt, a wrong refund costs the money and the goods.</div>
  </div>`;
}

function viewProof() {
  const e = S.overview.experiment;
  const d = S.overview.detectionScore;
  const m = S.overview.model;
  const sig = e.significance;

  return `
  <div class="card">
    <h3>Does any of this actually work</h3>
    <p>A fixed ${pct(e.holdoutFraction, 0)} of the payments this system decides to act on are permanently withheld and given the naive treatment instead: retry immediately, every time, whatever the decline code said. Without that arm, "we recovered ${rs(S.overview.leakMap.recovered)}" is a number with no denominator, because some of those payments would have come back on their own.</p>
    <div class="split" style="margin-top:16px">
      <div>
        <div class="kv"><span>Control &mdash; naive retry</span><em class="arm control">holdout</em></div>
        <div class="kv"><span>Attempts</span><em>${e.control.n}</em></div>
        <div class="kv"><span>Recovered</span><em>${e.control.recovered}</em></div>
        <div class="kv"><span>Recovery rate</span><em>${pct(e.control.rate, 1)}</em></div>
      </div>
      <div>
        <div class="kv"><span>Treatment &mdash; chosen channel and timing</span><em class="arm">live</em></div>
        <div class="kv"><span>Attempts</span><em>${e.treatment.n}</em></div>
        <div class="kv"><span>Recovered</span><em>${e.treatment.recovered}</em></div>
        <div class="kv"><span>Recovery rate</span><em style="color:var(--green)">${pct(e.treatment.rate, 1)}</em></div>
      </div>
    </div>
    <div class="kv" style="margin-top:14px"><span>Incremental revenue over the counterfactual</span><em style="color:var(--green)">${rs(e.incrementalAmount)}</em></div>
    <div class="kv"><span>Two-proportion test</span><em>z = ${sig.z.toFixed(2)}, p = ${sig.pValue.toFixed(3)}</em></div>
    <div class="note">
      ${sig.significant
        ? 'This difference clears the 5% bar.'
        : `This is <strong style="color:var(--ink)">not yet significant</strong>. At the effect size observed so far it needs about ${e.requiredNPerArm || '\u2014'} attempts per arm, and the control arm has ${e.control.n}. One day of traffic cannot answer this question, and a product that reported the headline lift anyway would be reporting noise.`}
    </div>
  </div>

  <div class="split">
    <div class="card">
      <h3>Detection, scored against planted leaks</h3>
      <p>The synthetic day has known faults injected into it, labelled before detection runs. Reporting only what was caught would prove nothing, so misses count.</p>
      <div style="margin-top:12px">
        <div class="kv"><span>Recall</span><em>${pct(d.recall, 0)} &mdash; ${d.detected} of ${d.plantedLeaks}</em></div>
        <div class="kv"><span>Precision</span><em>${pct(d.precision, 0)}</em></div>
        <div class="kv"><span>False positives</span><em>${d.falsePositives}</em></div>
        <div class="kv"><span>Cause correctly attributed</span><em>${pct(d.causeAccuracy, 0)}</em></div>
      </div>
      <div style="margin-top:14px">
        ${d.results.map((r) => `<div class="kv"><span>${esc(r.kind.replace(/_/g, ' '))}</span><em style="color:${r.detected ? 'var(--green)' : 'var(--rose)'};font-size:11.5px">${esc(r.detail)}</em></div>`).join('')}
      </div>
    </div>

    <div class="card">
      <h3>Is the probability honest</h3>
      <p>The gate is a fitted model, not a language model's opinion of itself. If it says 70%, roughly 70% of those attempts should succeed. The diagonal is perfect calibration.</p>
      ${calibrationChart(m.calibration)}
      <div class="kv" style="margin-top:10px"><span>Brier score</span><em>${m.brier.toFixed(4)}</em></div>
      <div class="kv"><span>Skill over base rate</span><em>${pct(m.skillScore, 1)}</em></div>
      <div class="kv"><span>Held-out rows</span><em>${m.testedOn} of ${m.trainedOn + m.testedOn}</em></div>
    </div>
  </div>

  <div class="card">
    <h3>What the model leans on</h3>
    <p>Weights from the fitted logistic regression, largest absolute value first. These are inspectable, which is the point of not using a black box for the number that authorises money.</p>
    <div style="margin-top:12px">
      ${m.topFeatures.map((f) => {
        const w = Math.min(Math.abs(f.weight) / 6, 1) * 100;
        const c = f.weight > 0 ? 'var(--green)' : 'var(--rose)';
        return `<div class="netrow"><span>${esc(f.feature.replace(/_/g, ' '))}</span><div class="netbar"><i style="width:${w}%;background:${c}"></i></div><em style="color:${c}">${f.weight.toFixed(2)}</em></div>`;
      }).join('')}
    </div>
  </div>`;
}

function calibrationChart(cal) {
  const W = 300, H = 200, pad = 30;
  const x = (v) => pad + v * (W - pad * 2);
  const y = (v) => H - pad - v * (H - pad * 2);
  const pts = cal.map((c) => `${x(c.predicted)},${y(c.observed)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;margin-top:12px">
    <line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}" stroke="var(--line)" stroke-width="1" stroke-dasharray="4 4"/>
    <line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(0)}" stroke="var(--line)" stroke-width="1"/>
    <line x1="${x(0)}" y1="${y(0)}" x2="${x(0)}" y2="${y(1)}" stroke="var(--line)" stroke-width="1"/>
    <polyline points="${pts}" fill="none" stroke="var(--blue)" stroke-width="2"/>
    ${cal.map((c) => `<circle cx="${x(c.predicted)}" cy="${y(c.observed)}" r="3.5" fill="var(--blue)"><title>predicted ${pct(c.predicted)}, observed ${pct(c.observed)}, n=${c.n}</title></circle>`).join('')}
    <text x="${x(0.5)}" y="${H - 6}" fill="var(--dimmer)" font-size="10" text-anchor="middle" font-family="IBM Plex Sans">predicted</text>
    <text x="10" y="${y(0.5)}" fill="var(--dimmer)" font-size="10" text-anchor="middle" font-family="IBM Plex Sans" transform="rotate(-90 10 ${y(0.5)})">observed</text>
  </svg>`;
}

function viewAudit() {
  const rows = S.ledger?.rows || [];
  return `
  <div class="card">
    <h3>Every decision, including the ones to do nothing</h3>
    <p>Append-only. A decision that was blocked is logged with the same weight as one that ran, because "why did nothing happen to my ₹4,100" is a question a merchant is entitled to an answer to.</p>
    <div class="rowbtns">
      <button class="btn" id="testWebhook">Send a signed webhook</button>
      <button class="btn" id="testBadWebhook">Send one with a bad signature</button>
      <button class="btn" id="testIdem">Fire the same approval twice</button>
    </div>
    <div id="auditOut"></div>
  </div>

  <div class="section-label">Ledger &mdash; ${S.ledger?.total || 0} entries</div>
  <div class="table-wrap"><div class="table-scroll">
  <table class="table">
    <thead><tr><th>#</th><th>Type</th><th>Payment</th><th>Detail</th><th>Value</th></tr></thead>
    <tbody>
    ${rows.slice(0, 160).map((r) => `
      <tr>
        <td class="n">${r.seq}</td>
        <td><span class="chip">${esc(r.type)}</span></td>
        <td class="n" style="font-size:11px">${esc(r.paymentId || '\u2014')}</td>
        <td style="max-width:420px">${esc(r.reason || r.note || r.outcome || r.chosenAction || r.action || r.event || '')}
          ${r.verdict ? `<span class="verdict ${r.verdict}" style="margin-left:6px">${r.verdict}</span>` : ''}
          ${r.idempotencyKey ? `<div style="font-family:var(--mono);font-size:10.5px;color:var(--dimmer);margin-top:3px">${esc(r.idempotencyKey)}</div>` : ''}
        </td>
        <td class="n">${r.recoveredAmount ? `<span style="color:var(--green)">+${rs(r.recoveredAmount)}</span>` : r.foregoneValue ? `<span style="color:var(--rose)">-${rs(r.foregoneValue)}</span>` : r.amount ? rs(r.amount) : ''}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  </div></div>`;
}

function viewControl() {
  const l = S.live;
  if (!l) return '<div class="card"><div class="empty">Loading the simulator\u2026</div></div>';

  return `
  <div class="card">
    <div class="card-head">
      <div>
        <h3>Live payment traffic</h3>
        <p style="margin-top:8px">Six merchants, real time. Each tick advances the clock three minutes and generates the payments that would have arrived in that window. Leave it running while you break things.</p>
      </div>
      <div style="text-align:right">
        <div class="tile" style="border:0;padding:0;background:none">
          <div class="v" style="color:${l.running ? 'var(--green)' : 'var(--dimmer)'}">${l.running ? 'live' : 'paused'}</div>
          <div class="sub">${l.generated.toLocaleString('en-IN')} events generated</div>
        </div>
      </div>
    </div>
    <div class="split-3" style="margin-top:16px">
      <div class="kv"><span>Simulated clock</span><em>${dt(l.clock)}</em></div>
      <div class="kv"><span>Attempts, last hour</span><em>${l.lastHour.attempts}</em></div>
      <div class="kv"><span>Success rate, last hour</span><em style="color:${l.lastHour.successRate != null && l.lastHour.successRate < 0.88 ? 'var(--amber)' : 'var(--green)'}">${l.lastHour.successRate != null ? pct(l.lastHour.successRate) : '\u2014'}</em></div>
    </div>
    <div class="rowbtns">
      <button class="btn ${l.running ? '' : 'btn-primary'}" id="liveToggle">${l.running ? 'Pause traffic' : 'Start traffic'}</button>
      <a class="btn" href="/store.html">Open the shop and buy something</a>
      <button class="btn btn-quiet" id="cleanDay">Start from a healthy day</button>
    </div>
  </div>

  <div class="card">
    <h3>Break something</h3>
    <p>Nothing here tells the watchdog anything. These switches change how the banks behave, exactly as a real outage would. The system has to work out on its own that something is wrong, and whose fault it is.</p>
    <div style="margin-top:16px">
      ${l.switches.map((sw) => `
        <div class="field">
          <label>${esc(sw.label)}
            <div style="font-size:11.5px;color:var(--dimmer);margin-top:2px">correct diagnosis: ${sw.scope === 'network' ? 'upstream, affects every merchant' : 'local to this account'}</div>
          </label>
          <input type="checkbox" data-switch="${sw.key}" ${sw.on ? 'checked' : ''}>
        </div>`).join('')}
    </div>
    <div class="rowbtns">
      <button class="btn btn-primary" id="controlCycle">Run the watchdog now</button>
      <button class="btn btn-solid" id="syncReal" style="margin-left:8px">⟳ Sync real payments from Razorpay</button>
    </div>
    <div class="note">
      <strong style="color:var(--ink)">For real payments:</strong> after you pay (or fail) something on the storefront, if it doesn't show up automatically, click <em style="font-style:normal;color:var(--ink)">Sync real payments from Razorpay</em>. This pulls your account's recent payments directly, so it works even if your webhook tunnel isn't set up.
    </div>
    <div class="note">
      Turn on the HDFC switch, let traffic run for a minute or two, then run the watchdog. It should find the drop, put the change point at roughly the minute you flipped the switch, and call it upstream because four other merchants dropped with you. Turn on the Google Pay switch instead and it should call that one local, because nobody else moved.
    </div>
    <div id="controlOut"></div>
  </div>

  <div class="card">
    <h3>Suggested run for a judge</h3>
    <ul class="evidence">
      <li>Press <em style="font-style:normal;color:var(--ink)">Start from a healthy day</em>. The leak map should be empty. Nothing is wrong yet, so anything that appears next is something you caused.</li>
      <li>Start traffic. Watch the success rate sit around 93%.</li>
      <li>Switch on the HDFC Netbanking outage. Wait about ninety seconds.</li>
      <li>Run the watchdog. Open the new investigation and press Why?</li>
      <li>Look at the network strip: four of six merchants dropped together, which is the evidence that this is the bank and not the checkout.</li>
      <li>Switch HDFC off and the Google Pay one on, wait, run again. Same detector, opposite verdict, because this time nobody else moved. The HDFC investigation stays for a while: detection looks back twenty-four hours, so a bank that was down an hour ago is still part of today.</li>
      <li>Switch on the webhook failure, go to the shop, buy something with UPI. If it succeeds you will see the money taken with no order created, and the watchdog will refuse to refund it without you.</li>
    </ul>
  </div>`;
}

/* ----------------------------------------------------------------- render -- */
const TITLES = {
  map: ['Leak map', 'What this account is losing right now, and what has been done about it.'],
  queue: ['Recovery queue', 'Actions the system will not take without you.'],
  safety: ['Guardrails', 'What is allowed to run unattended, and what that caution costs.'],
  proof: ['Proof', 'Measured against a holdout, scored against planted faults.'],
  agent: ['Agent', 'What it chose to look at, and what it is allowed to claim.'],
  congestion: ['Congestion', 'What happens when every merchant retries a struggling bank at once.'],
  audit: ['Audit trail', 'Every decision, with the rule that produced it.'],
  control: ['Control room', 'Break something on purpose and watch the system work out what happened.'],
};


/* ------------------------------------------------------------------ agent -- */
/**
 * The trace panel. This is the screen that proves the thing is an agent rather
 * than an if-statement: every tool the model chose to call, in the order it
 * chose, with the fact ids the conclusion is allowed to cite.
 */
function viewAgent() {
  const run = S.agentRun;
  const meta = S.agentMeta || {};

  const header = `
    <div class="panel">
      <div class="panel-head">
        <div>
          <h2>Investigation agent</h2>
          <p>The model chooses which evidence to pull and when it has enough. It never produces a number.</p>
        </div>
        <button class="btn btn-solid" id="runAgent">${run ? 'Investigate again' : 'Start an investigation'}</button>
      </div>
      <div class="note">
        Driver: <strong style="color:var(--ink)">${esc(meta.driver || 'deterministic')}</strong>${meta.model ? ` (${esc(meta.model)})` : ''}.
        ${meta.driver === 'gemini'
          ? 'The model is selecting tools. Every claim it makes is checked against the tool result it cites, and rejected if the number is not there.'
          : 'No GEMINI_API_KEY is set, so the deterministic investigator is walking a fixed decision tree over the same tools. Set a key to let the model choose its own path. The policy engine gates the outcome identically either way.'}
      </div>
    </div>`;

  if (!run) {
    return header + `<div class="panel"><div class="empty">No investigation has been run yet. The agent starts from the open leaks and works out what to look at next.</div></div>`;
  }

  const steps = run.trace.map((t, i) => {
    if (t.type === 'thought') {
      return `<div class="trace-row trace-thought"><span class="trace-kind">thinking</span><div>${esc(t.text)}</div></div>`;
    }
    if (t.type === 'tool_call') {
      const r = t.result || {};
      let gist = '';
      if (t.tool === 'list_open_leaks') gist = `${r.leak_count} open leak(s) for ${esc(r.merchant || '')}`;
      else if (t.tool === 'compare_across_network') gist = `verdict: <strong>${esc(r.verdict)}</strong> — ${r.merchants_degraded} of ${r.merchants_observed} merchants degraded`;
      else if (t.tool === 'estimate_recovery_probability') gist = r.structurally_impossible ? 'structurally impossible' : `${r.probability_pct}% via ${esc(r.channel)}`;
      else if (t.tool === 'check_congestion') gist = `${r.pending_retries_network_wide} retries queued across ${r.merchants_with_queued_retries} merchants`;
      else if (t.tool === 'get_decline_breakdown') gist = `${r.total_failed} failures, ${r.terminal_share_pct}% unretryable`;
      else if (t.tool === 'inspect_payment') {
        const q = String(r.customer_supplied_description || '').startsWith('[QUARANTINED');
        gist = `${esc(r.decline_code || '')}${q ? ' &middot; <strong style="color:var(--danger)">customer text quarantined</strong>' : ''}`;
      } else if (t.tool === 'get_customer_history') gist = `${r.contacts_last_30d}/${r.contact_budget} contacts used`;
      else gist = '';
      return `
        <div class="trace-row">
          <span class="trace-kind">${t.factId ? esc(t.factId) : 'call'}</span>
          <div>
            <code>${esc(t.tool)}(${esc(JSON.stringify(t.input || {}).slice(1, -1).slice(0, 90))})</code>
            ${gist ? `<div class="trace-gist">${gist}</div>` : ''}
          </div>
        </div>`;
    }
    if (t.type === 'proposal') {
      if (t.valid) return `<div class="trace-row trace-ok"><span class="trace-kind">verdict</span><div>Conclusion accepted. Every claim traced to a tool result.</div></div>`;
      return `
        <div class="trace-row trace-bad">
          <span class="trace-kind">rejected</span>
          <div><strong>The claim validator rejected this conclusion.</strong>
          <ul>${(t.problems || []).map((p) => `<li>${esc(p.detail)}</li>`).join('')}</ul>
          The model was sent back to correct it.</div>
        </div>`;
    }
    if (t.type === 'error') return `<div class="trace-row trace-bad"><span class="trace-kind">error</span><div>${esc(t.detail)}</div></div>`;
    return `<div class="trace-row"><span class="trace-kind">${esc(t.type)}</span><div>${esc(t.detail || '')}</div></div>`;
  }).join('');

  const p = run.proposal;
  const conclusion = p ? `
    <div class="panel">
      <div class="panel-head"><div><h2>Conclusion</h2><p>Cause, posture, and the evidence behind each claim.</p></div></div>
      <div class="verdict-grid">
        <div><span>Cause</span><em>${esc(p.cause.replace(/_/g, ' '))}</em></div>
        <div><span>Posture</span><em>${esc(p.posture.replace(/_/g, ' '))}</em></div>
        <div><span>Confidence in cause</span><em>${esc(p.confidence)}</em></div>
      </div>
      <p class="lede">${esc(p.rationale)}</p>
      <table class="grid">
        <thead><tr><th>Claim</th><th style="width:90px">Source</th></tr></thead>
        <tbody>
          ${p.findings.map((f) => `<tr><td>${esc(f.claim)}</td><td><code>${esc(f.fact_id || f.factId)}</code></td></tr>`).join('')}
        </tbody>
      </table>
      <div class="note">
        Every row cites the tool call that produced its numbers. A claim with a figure that does not appear in the
        cited result is rejected before it reaches this screen &mdash; the model is not permitted to be the source of a number.
      </div>
    </div>` : `
    <div class="panel"><div class="note">The run ended without an accepted conclusion. ${run.rejections} proposal(s) were rejected by the validator.</div></div>`;

  const cost = run.cost || {};
  const recovered = S.overview?.leakMap?.recovered || 0;
  const costPer100 = recovered > 0 && cost.paise ? (cost.paise / (recovered / 10000)).toFixed(2) : null;

  return header + conclusion + `
    <div class="panel">
      <div class="panel-head"><div><h2>Trace</h2><p>Every tool call, in the order the agent chose to make them.</p></div></div>
      <div class="trace">${steps}</div>
    </div>
    <div class="panel">
      <div class="panel-head"><div><h2>What the run cost</h2><p>An agent that cannot state its own unit economics is not a product.</p></div></div>
      <div class="verdict-grid">
        <div><span>Tool calls</span><em>${run.toolCalls}</em></div>
        <div><span>Claims rejected</span><em>${run.rejections}</em></div>
        <div><span>Wall clock</span><em>${(run.durationMs / 1000).toFixed(1)}s</em></div>
        <div><span>Model spend</span><em>${cost.paise ? rs(cost.paise) : '\u20B90'}</em></div>
      </div>
      ${costPer100 ? `<div class="note">Roughly <strong style="color:var(--ink)">\u20B9${costPer100}</strong> of model spend per \u20B9100 recovered so far. ${esc(cost.assumption || '')}</div>`
        : `<div class="note">${cost.paise ? esc(cost.assumption || '') : 'No model spend: the deterministic investigator ran, which costs nothing and needs no network.'}</div>`}
    </div>
    ${viewInjections()}`;
}

/**
 * Injection attempts. Kept next to the agent because it is the agent's threat
 * model, not a general security page.
 */
function viewInjections() {
  const rows = S.injections || [];
  if (!rows.length) {
    return `<div class="panel">
      <div class="panel-head"><div><h2>Untrusted input</h2><p>Customer- and merchant-authored text that tried to instruct the agent.</p></div></div>
      <div class="note">Nothing flagged in this run. Payment descriptions and notes are still scanned on every read, and the agent has no write tools regardless of what any of them say.</div>
    </div>`;
  }
  return `<div class="panel">
    <div class="panel-head"><div><h2>Untrusted input</h2><p>${rows.length} attempt(s) to instruct the agent through payment data.</p></div></div>
    <table class="grid">
      <thead><tr><th>Source</th><th>Patterns matched</th><th>Text</th><th>Outcome</th></tr></thead>
      <tbody>
        ${rows.slice(0, 12).map((r) => `<tr>
          <td><code>${esc(r.source)}</code></td>
          <td>${(r.detections || []).map((d) => `<span class="pill pill-danger">${esc(d)}</span>`).join(' ')}</td>
          <td class="mono-sm">${esc(String(r.sample).slice(0, 110))}</td>
          <td>quarantined</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="note">
      Detection is the weakest of the three defences and is listed last on purpose. The one that actually holds is
      architectural: the agent has no write tools, so a successful injection still cannot move money. Pattern matching
      makes attempts <em>visible</em>; it is not what makes them harmless.
    </div>
  </div>`;
}

/* ------------------------------------------------------------- congestion -- */
/**
 * The comparison only a gateway can run: what happens when every merchant
 * retries a struggling bank at the same moment, versus when someone meters it.
 */
function viewCongestion() {
  const c = S.congestion;
  if (!c) return `<div class="panel"><div class="empty">Loading&hellip;</div></div>`;

  if (!c.pending) {
    return `<div class="panel">
      <div class="panel-head"><div><h2>Retry congestion</h2><p>Nothing is queued for ${esc(c.issuer)} right now.</p></div></div>
      <div class="note">${esc(c.note || '')} Go to the control room, switch on <strong style="color:var(--ink)">HDFC Netbanking degraded (all merchants)</strong>, let traffic run for a minute, then come back.</div>
    </div>`;
  }

  const bar = (arm, label, cls) => {
    const max = Math.max(c.uncoordinated.expectedRecovered, c.coordinated.expectedRecovered) || 1;
    return `
      <div class="cmp-row">
        <div class="cmp-label"><strong>${label}</strong><span>${arm.attempts} attempts over ${arm.spanMinutes} min</span></div>
        <div class="cmp-track"><div class="cmp-fill ${cls}" style="width:${(arm.expectedRecovered / max) * 100}%"></div></div>
        <div class="cmp-value">${rs(arm.expectedRecovered)}<span>worst multiplier &times;${arm.worstMultiplier}</span></div>
      </div>`;
  };

  const slots = c.uncoordinated.slots.concat(c.coordinated.slots);
  const maxLoad = Math.max(...slots.map((s) => s.offeredLoad), 1);
  const slotStrip = (arm, cls) => `
    <div class="slot-strip">
      ${arm.slots.map((s) => `
        <div class="slot" title="minute ${s.minute}: ${s.attempts} retries, offered load ${s.offeredLoad}, success multiplier ${s.successMultiplier}">
          <div class="slot-bar ${cls}" style="height:${Math.max(4, (s.offeredLoad / maxLoad) * 100)}%"></div>
          <span>${s.minute}</span>
        </div>`).join('')}
    </div>`;

  return `
    <div class="panel">
      <div class="panel-head">
        <div>
          <h2>Retry congestion control</h2>
          <p>${c.pending} retries queued for ${esc(c.issuer)} across ${c.merchantsInvolved} merchants, worth ${rs(c.faceValueQueued)} at face value.</p>
        </div>
        <button class="btn btn-ghost" id="refreshCongestion">Recalculate</button>
      </div>
      <p class="lede">
        When a bank degrades, every merchant's dunning logic notices at the same moment and starts retrying. None of them
        can see each other, so a bank that is already struggling gets a synchronised burst from everyone at once. Each
        merchant behaved rationally; together they made the outage worse. A single merchant cannot fix this &mdash; holding
        back alone just means recovering less while everyone else still stampedes. It is only solvable one layer up.
      </p>
      ${bar(c.uncoordinated, 'Uncoordinated &mdash; everyone retries now', 'cmp-bad')}
      ${bar(c.coordinated, 'Coordinated &mdash; metered across merchants', 'cmp-good')}
      <div class="verdict-grid" style="margin-top:18px">
        <div><span>Difference</span><em>${c.delta >= 0 ? '+' : ''}${rs(c.delta)}</em></div>
        <div><span>Relative</span><em>${c.deltaPct >= 0 ? '+' : ''}${c.deltaPct}%</em></div>
        <div><span>Assumed issuer capacity</span><em>${c.capacity.attemptsPerMinute}/min</em></div>
        <div><span>Organic load</span><em>${c.capacity.organicPerMinute}/min</em></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><div><h2>Offered load, minute by minute</h2><p>Same payments, same model. Only the arrival schedule differs.</p></div></div>
      <h4 class="sub">Uncoordinated</h4>
      ${slotStrip(c.uncoordinated, 'cmp-bad')}
      <h4 class="sub">Coordinated</h4>
      ${slotStrip(c.coordinated, 'cmp-good')}
    </div>

    <div class="panel">
      <div class="panel-head"><div><h2>What is assumed here</h2><p>This is a model, and the assumptions decide the answer.</p></div></div>
      <ul class="assumptions">${c.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
      <div class="note">
        Issuer capacity is not published and cannot be observed from test-mode keys, so these numbers are assumptions
        written down in <code>src/config.js</code> rather than measurements. Both arms use identical per-payment
        probabilities from the fitted model; the only difference between them is timing. What the comparison shows is
        that metering beats stampeding under any congestion curve of this shape &mdash; not that 40 attempts per minute
        is the right figure for HDFC.
      </div>
    </div>`;
}

function render() {
  const [t, s] = TITLES[S.view] || TITLES.map;
  $('#stageTitle').textContent = S.openInvestigation ? 'Investigation' : t;
  $('#stageSub').textContent = S.openInvestigation ? 'The evidence behind the number, end to end.' : s;

  let html;
  if (S.openInvestigation) {
    const inv = S.investigations.find((i) => i.id === S.openInvestigation);
    html = inv ? viewInvestigation(inv) : viewMap();
  } else if (S.view === 'queue') html = viewQueue();
  else if (S.view === 'emails') html = viewEmails();
  else if (S.view === 'safety') html = viewSafety();
  else if (S.view === 'proof') html = viewProof();
  else if (S.view === 'agent') html = viewAgent();
  else if (S.view === 'congestion') html = viewCongestion();
  else if (S.view === 'audit') html = viewAudit();
  else if (S.view === 'control') html = viewControl();
  else html = viewMap();

  $('#view').innerHTML = html;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === S.view));
  bindPolicyInputs();
}

/* ------------------------------------------------------------------ events -- */
$('#nav').addEventListener('click', async (e) => {
  const btn = e.target.closest('.nav-item');
  if (!btn) return;
  S.view = btn.dataset.view;
  S.openInvestigation = null;
  if (S.view === 'audit') S.ledger = await api('/api/ledger?limit=200');
  if (S.view === 'emails') { const em = await api('/api/emails'); S.emails = em.emails || []; }
  if (S.view === 'agent') { S.agentMeta = await api('/api/agent/runs'); S.injections = (await api('/api/injections')).attempts; }
  if (S.view === 'congestion') { render(); S.congestion = await api('/api/congestion/compare'); }
  if (S.view === 'control') S.live = await api('/api/live');
  render();
});

$('#view').addEventListener('click', async (e) => {
  const t = e.target;

  if (t.id === 'reconcileBtn') {
    t.disabled = true; t.textContent = 'Checking\u2026';
    const r = await post('/api/reconcile');
    await load();
    const em = await api('/api/emails');
    S.emails = em.emails || [];
    S.view = 'emails';
    render();
    toast(r.recovered > 0 ? `${r.recovered} confirmed recovered.` : 'No new payments confirmed yet.');
    return;
  }

  const simPaid = t.dataset?.simPaid;
  const simFailed = t.dataset?.simFailed;
  if (simPaid || simFailed) {
    t.disabled = true;
    await post('/api/emails/resolve', { emailId: simPaid || simFailed, outcome: simPaid ? 'paid' : 'failed' });
    const em = await api('/api/emails');
    S.emails = em.emails || [];
    await load();
    S.view = 'emails';
    render();
    toast(simPaid ? 'Marked as paid — recovery recorded.' : 'Marked as not paid — link failed.');
    return;
  }

  if (t.id === 'runAgent') {
    t.disabled = true; t.textContent = 'Investigating\u2026';
    S.agentRun = await post('/api/agent/investigate');
    S.agentMeta = await api('/api/agent/runs');
    S.injections = (await api('/api/injections')).attempts;
    render();
    toast(S.agentRun.proposal ? 'Investigation complete.' : 'Run finished without an accepted conclusion.');
    return;
  }
  if (t.id === 'refreshCongestion') {
    t.disabled = true; t.textContent = 'Recalculating\u2026';
    S.congestion = await api('/api/congestion/compare');
    render();
    return;
  }

  if (t.dataset.open) { S.openInvestigation = t.dataset.open; render(); return; }
  if (t.dataset.back) { S.openInvestigation = null; render(); return; }

  if (t.dataset.approve) {
    t.disabled = true; t.textContent = 'Running\u2026';
    const r = await post('/api/approve', { candidateId: t.dataset.approve });
    const a = r.action || {};
    if (a.pending) {
      toast(a.emailId ? 'Link created and email sent. Waiting for the shopper to pay.' : 'Recovery link created. Waiting for payment.');
    } else if (a.recovered) {
      toast(`Recovered ${rs(a.recoveredAmount)}.`);
    } else if (a.emailSkipped) {
      toast('No email sent — this failure is not recoverable by the shopper.');
    } else {
      toast('Action ran.');
    }
    await load();
    return;
  }
  if (t.dataset.reject) {
    await post('/api/reject', { candidateId: t.dataset.reject, reason: 'merchant declined' });
    toast('Rejected. Logged with the reason.');
    await load();
    return;
  }

  if (t.id === 'liveToggle') {
    S.live = await post(S.live.running ? '/api/live/stop' : '/api/live/start');
    render();
    if (S.live.running) startLivePoll(); else stopLivePoll();
    return;
  }
  if (t.dataset.switch) {
    S.live = await post('/api/scenario', { key: t.dataset.switch, on: t.checked });
    toast(t.checked ? 'Switch on. The banks are behaving differently now.' : 'Switch off.');
    return;
  }
  if (t.id === 'cleanDay') {
    t.disabled = true; t.textContent = 'Clearing\u2026';
    await post('/api/reseed', { clean: true });
    await load();
    S.live = await api('/api/live');
    S.view = 'control';
    render();
    toast('Healthy day loaded. Nothing is wrong yet \u2014 now break something.');
    return;
  }
  if (t.id === 'syncReal') {
    t.disabled = true; t.textContent = 'Syncing from Razorpay\u2026';
    try {
      const r = await post('/api/sync-payments');
      await load();
      S.view = 'control';
      render();
      $('#controlOut').innerHTML = `<div class="note">${
        r.error
          ? `<strong style="color:var(--red)">Error: ${esc(r.error)}</strong> — check RAZORPAY_MODE=live and your keys in .env.`
          : `Pulled <strong style="color:var(--ink)">${r.synced}</strong> payments from your Razorpay account. <strong style="color:var(--ink)">${r.failedPayments}</strong> failed. ${r.failedPayments > 0 ? 'Open the <strong style="color:var(--ink)">Leak map</strong> — they are there now.' : 'No failed payments to recover.'}`
      }</div>`;
    } catch (e) {
      $('#controlOut').innerHTML = `<div class="note"><strong style="color:var(--red)">Error: ${esc(e.message)}</strong></div>`;
    }
    t.disabled = false; t.textContent = '\u27f3 Sync real payments from Razorpay';
    return;
  }

  if (t.id === 'controlCycle') {
    t.disabled = true; t.textContent = 'Watching\u2026';
    const r = await post('/api/cycle');
    await load();
    S.live = await api('/api/live');
    S.view = 'control';
    render();
    const deg = r.investigations.filter((i) => i.leakType.startsWith('instrument_degradation'));
    $('#controlOut').innerHTML = `<div class="note">${
      deg.length
        ? deg.map((i) => `<strong style="color:var(--ink)">${esc(i.title)}</strong> \u2014 ${rs(i.amountAtRisk)} at risk. Verdict: ${i.leakType.endsWith('upstream') ? 'upstream' : 'local to this account'}.`).join('<br>')
        : 'No instrument degradation found. If you just flipped a switch, give the traffic a minute to build up enough attempts to be sure about.'
    }</div>`;
    return;
  }

  if (t.id === 'simulate') { await runSimulation(); return; }
  if (t.id === 'applyPolicy') {
    t.disabled = true; t.textContent = 'Re-running\u2026';
    await post('/api/policy/apply', readPolicyInputs());
    toast('Policy applied. The cycle was re-run against it.');
    await load();
    return;
  }

  if (t.id === 'testWebhook' || t.id === 'testBadWebhook') {
    const r = await post('/api/razorpay/simulate-webhook', { badSignature: t.id === 'testBadWebhook' });
    $('#auditOut').innerHTML = `<div class="note"><strong style="color:var(--ink)">HTTP ${r.status}</strong> \u2014 ${esc(JSON.stringify(r.result))}<br>${
      r.status === 401
        ? 'Rejected before the body was parsed. Anything that parses first has already trusted the payload.'
        : 'Signature verified, event applied. Sending the same event id again would be deduplicated rather than applied twice.'}</div>`;
    S.ledger = await api('/api/ledger?limit=200');
    return;
  }

  if (t.id === 'testIdem') {
    const all = S.investigations.flatMap((i) => i.candidates).filter((c) => c.policy.verdict === 'REVIEW' && !c.resolved);
    if (!all.length) { toast('No pending candidate to try this on.'); return; }
    const r = await post('/api/approve-twice', { candidateId: all[0].id });
    $('#auditOut').innerHTML = `<div class="note"><strong style="color:var(--ink)">${r.sameAction ? 'One action, not two' : 'Two actions'}</strong><br>
      first: ${esc(r.first)}<br>second: ${esc(r.second)}<br>${esc(r.note)}</div>`;
    S.ledger = await api('/api/ledger?limit=200');
    return;
  }
});

function readPolicyInputs() {
  return {
    minRecoveryProbability: Number($('#pMinProb').value),
    minExpectedValuePaise: Number($('#pMinEV').value),
    autoActionCeilingPaise: Number($('#pCeil').value),
    maxContactsPer30d: Number($('#pContacts').value),
    suppressDuringNetworkOutage: $('#pSuppress').checked,
  };
}

function bindPolicyInputs() {
  const pairs = [['pMinProb', 'oMinProb', (v) => pct(Number(v), 0)], ['pMinEV', 'oMinEV', (v) => rs(Number(v))], ['pCeil', 'oCeil', (v) => rs(Number(v))], ['pContacts', 'oContacts', (v) => v]];
  for (const [inputId, outId, fmt] of pairs) {
    const i = $('#' + inputId);
    if (!i) continue;
    i.addEventListener('input', () => { $('#' + outId).textContent = fmt(i.value); });
  }
}

async function runSimulation() {
  const sim = await post('/api/policy/simulate', readPolicyInputs());
  const b = sim.counts.before, a = sim.counts.after;
  $('#simOut').innerHTML = `
    <div class="note">
      <strong style="color:var(--ink)">${sim.changedCount} of ${Object.values(b).reduce((x, y) => x + y, 0)} decisions would change.</strong><br>
      Automatic: ${b.AUTO || 0} &rarr; ${a.AUTO || 0} &nbsp;&middot;&nbsp; Review: ${b.REVIEW || 0} &rarr; ${a.REVIEW || 0} &nbsp;&middot;&nbsp; Blocked: ${b.BLOCK || 0} &rarr; ${a.BLOCK || 0}<br><br>
      ${sim.newlyAutomatic.count} actions would start running unattended, carrying ${rs(sim.newlyAutomatic.expectedValue)} of expected value.<br>
      ${sim.newlyWithheld.count} would stop running unattended, holding back ${rs(sim.newlyWithheld.expectedValue)}.<br><br>
      Nothing has been applied.
    </div>`;
}

$('#runCycle').addEventListener('click', async (e) => {
  e.target.disabled = true; e.target.textContent = 'Watching\u2026';
  await post('/api/cycle');
  await load();
  e.target.disabled = false; e.target.textContent = 'Run a cycle';
  toast('Cycle complete.');
});

$('#reseed').addEventListener('click', async (e) => {
  e.target.disabled = true; e.target.textContent = 'Reseeding\u2026';
  await post('/api/reseed');
  S.openInvestigation = null;
  await load();
  e.target.disabled = false; e.target.textContent = 'Reseed the day';
  toast('New day generated and processed.');
});

const inboxBtn = document.getElementById('inboxBtn');
if (inboxBtn) inboxBtn.addEventListener('click', async () => {
  S.view = 'emails';
  S.openInvestigation = null;
  const em = await api('/api/emails');
  S.emails = em.emails || [];
  render();
});

let livePoll = null;
function startLivePoll() {
  stopLivePoll();
  livePoll = setInterval(async () => {
    if (S.openInvestigation) return;
    // On the emails/queue views, quietly reconcile pending recovery links with
    // Razorpay so a payment made on the shopper's phone flips to recovered
    // within a few seconds, with no webhook and no manual refresh.
    if (S.view === 'emails' || S.view === 'queue') {
      const r = await post('/api/reconcile').catch(() => null);
      if (r && r.recovered > 0) {
        await load();
        const em = await api('/api/emails');
        S.emails = em.emails || [];
        render();
        toast(`${r.recovered} payment${r.recovered > 1 ? 's' : ''} confirmed as recovered.`);
      }
      return;
    }
    if (S.view !== 'control') return;
    S.live = await api('/api/live');
    const running = document.querySelector('#liveToggle');
    if (running) render();
  }, 5000);
}
function stopLivePoll() { clearInterval(livePoll); livePoll = null; }

// Always run the poll (not only when synthetic traffic is running), because
// real recoveries need reconciling regardless of the simulator state.
startLivePoll();

load();
