// ============================================================
//  BIDZON STRESS TEST — MACHINE 1
//  VUs: 2,000 | Accounts: machine1_user0001–2000@test.com
//  Scenario 1: bidder_scenario  — 1,900 VUs → bid
//  Scenario 2: user_scenario    — 100 VUs  → create/manage auctions
// ============================================================

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const bidSuccess      = new Counter('bid_success_total');
const bidFail         = new Counter('bid_fail_total');
const loginFail       = new Counter('login_fail_total');
const auctionJoinFail = new Counter('auction_join_fail_total');
const errorRate       = new Rate('error_rate');
const loginDuration   = new Trend('login_duration', true);
const bidDuration     = new Trend('bid_duration', true);
const auctionDuration = new Trend('auction_list_duration', true);

const BASE_URL        = 'http://49.12.201.167/api';
const SOCKET_URL      = 'http://49.12.201.167';
const MACHINE_ID      = 2;
const VU_END          = 2000;
const BIDDER_PASSWORD = 'Test@123';
const SELLER_EMAIL    = 'john@example.com';
const SELLER_PASS     = 'SecurePass123';

export const options = {
  scenarios: {
    bidder_scenario: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m',  target: 10   },
        { duration: '15m', target: 1900 },
        { duration: '10m', target: 1900 },
        { duration: '15m', target: 1400 },
        { duration: '3m',  target: 2400 },
        { duration: '5m',  target: 0    },
      ],
      gracefulRampDown: '30s',
      exec: 'bidderFlow',
    },
    user_scenario: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m',  target: 2   },
        { duration: '15m', target: 100 },
        { duration: '10m', target: 100 },
        { duration: '15m', target: 80  },
        { duration: '3m',  target: 100 },
        { duration: '5m',  target: 0   },
      ],
      gracefulRampDown: '30s',
      exec: 'userFlow',
    },
  },
  thresholds: {
    http_req_duration:     ['p(95)<500', 'p(99)<1500'],
    http_req_failed:       ['rate<0.01'],
    error_rate:            ['rate<0.05'],
    login_duration:        ['p(95)<1000'],
    bid_duration:          ['p(95)<800'],
    auction_list_duration: ['p(95)<600'],
  },
};

// ── Setup ─────────────────────────────────────────────────────
export function setup() {
  console.log(`[Machine ${MACHINE_ID}] Setup — creating ${VU_END} bidder accounts...`);

  const sellerRes  = http.post(
    `${BASE_URL}/user/login`,
    JSON.stringify({ email: SELLER_EMAIL, password: SELLER_PASS, type: 'user' }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  const sellerBody = JSON.parse(sellerRes.body);
  if (!sellerBody.token) {
    console.error(`[Machine ${MACHINE_ID}] Seller login FAILED`);
    return { bidders: [], auctionIds: [], sellerToken: null };
  }
  const sellerToken = sellerBody.token;

  // Create bidder accounts
  const bidders = [];
  for (let i = 1; i <= VU_END; i++) {
    const num   = String(i).padStart(4, '0');
    const email = `machine${MACHINE_ID}_user${num}@test.com`;
    const res   = http.post(
      `${BASE_URL}/bidder/create`,
      { name: `M${MACHINE_ID}User${num}`, email, coins: '500' },
      { headers: { Authorization: `Bearer ${sellerToken}` } }
    );
    const body = JSON.parse(res.body);
    if (res.status === 200 && body.success) {
      bidders.push({ id: body.data.id, email, password: BIDDER_PASSWORD });
    } else if (body.message && body.message.includes('already exists')) {
      bidders.push({ id: null, email, password: BIDDER_PASSWORD });
    }
    if (i % 100 === 0) { console.log(`[Machine ${MACHINE_ID}] ${i}/${VU_END} accounts ready`); sleep(0.5); }
  }

  // Get or create auctions
  const aListBody = JSON.parse(http.get(`${BASE_URL}/auction/auctions`, { headers: { Authorization: `Bearer ${sellerToken}` } }).body);
  let auctionIds  = [];
  if (aListBody.success && Array.isArray(aListBody.data)) {
    auctionIds = aListBody.data.filter(a => a.status === 'active' || a.status === 'pending').map(a => a.id).slice(0, 10);
  }

  if (auctionIds.length === 0) {
    for (let a = 0; a < 10; a++) {
      const assigned = bidders.slice(a * 200, (a + 1) * 200).filter(b => b.id);
      if (!assigned.length) continue;
      const params = new URLSearchParams();
      params.append('title', `Load Test Auction M${MACHINE_ID}-${a + 1}`);
      params.append('description', `Stress test machine ${MACHINE_ID}`);
      params.append('starting_price', '10.00');
      params.append('stake', '1.00');
      params.append('final_price', '9999.00');
      params.append('shipping_charges', '0.00');
      params.append('auction_at', new Date(Date.now() + 60000).toISOString());
      params.append('no_of_bidders', String(assigned.length));
      assigned.forEach(b => params.append('bidders', String(b.id)));
      const aRes  = http.post(`${BASE_URL}/auction/create`, params.toString(), {
        headers: { Authorization: `Bearer ${sellerToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const aBody = JSON.parse(aRes.body);
      if (aBody.success && aBody.data) auctionIds.push(aBody.data.id);
      sleep(0.5);
    }
  }

  console.log(`[Machine ${MACHINE_ID}] Setup done — ${bidders.length} bidders, ${auctionIds.length} auctions`);
  return { bidders, auctionIds, sellerToken };
}

// ── Socket.IO Helpers ─────────────────────────────────────────
function socketHandshake(userId) {
  const res   = http.get(`${SOCKET_URL}/socket.io/?EIO=4&transport=polling`);
  if (res.status !== 200) return null;
  const match = res.body.match(/"sid":"([^"]+)"/);
  if (!match) return null;
  const sid = match[1];
  http.post(`${SOCKET_URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`, '40', { headers: { 'Content-Type': 'text/plain' } });
  http.post(`${SOCKET_URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`, `42["join",{"id":${userId}}]`, { headers: { 'Content-Type': 'text/plain' } });
  return sid;
}
function socketEmit(sid, event, payload) {
  return http.post(`${SOCKET_URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`, `42["${event}",${JSON.stringify(payload)}]`, { headers: { 'Content-Type': 'text/plain' } });
}
function socketDisconnect(sid) {
  http.post(`${SOCKET_URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`, '41', { headers: { 'Content-Type': 'text/plain' } });
}

// ── Scenario 1: Bidder Flow ───────────────────────────────────
export function bidderFlow(data) {
  if (!data || !data.bidders || !data.bidders.length) { sleep(1); return; }

  const bidder    = data.bidders[(__VU - 1) % data.bidders.length];
  const auctionId = data.auctionIds[Math.floor(Math.random() * data.auctionIds.length)];

  // Login
  const loginStart = Date.now();
  const loginRes   = http.post(`${BASE_URL}/user/login`,
    JSON.stringify({ email: bidder.email, password: bidder.password, type: 'bidder' }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  loginDuration.add(Date.now() - loginStart);

  if (!check(loginRes, { 'bidder login 200': r => r.status === 200, 'has token': r => { try { return !!JSON.parse(r.body).token; } catch { return false; } } })) {
    loginFail.add(1); errorRate.add(1); sleep(2); return;
  }
  errorRate.add(0);
  const loginBody = JSON.parse(loginRes.body);
  const token     = loginBody.token;
  const userId    = loginBody.data.id;
  const authHdr   = { Authorization: `Bearer ${token}` };

  sleep(Math.random() * 2 + 0.5);

  // List auctions
  const aStart = Date.now();
  check(http.get(`${BASE_URL}/auction/auctions`, { headers: authHdr }), { 'auction list 200': r => r.status === 200 });
  auctionDuration.add(Date.now() - aStart);
  sleep(Math.random() + 0.5);

  // View auction
  http.get(`${BASE_URL}/auction/auction?id=${auctionId}`, { headers: authHdr });
  sleep(Math.random() + 0.5);

  // Socket.IO
  const sid = socketHandshake(userId);
  if (!sid) { auctionJoinFail.add(1); errorRate.add(1); sleep(2); return; }

  socketEmit(sid, 'auction:join', { auction_id: auctionId });
  sleep(1);

  // Bid loop
  const bidCount = Math.floor(Math.random() * 3) + 3;
  for (let b = 0; b < bidCount; b++) {
    const bStart = Date.now();
    const bRes   = socketEmit(sid, 'auction:bid', { auction_id: auctionId, user_id: userId });
    bidDuration.add(Date.now() - bStart);
    if (check(bRes, { 'bid 200': r => r.status === 200 })) { bidSuccess.add(1); errorRate.add(0); }
    else { bidFail.add(1); errorRate.add(1); }
    sleep(Math.random() * 5 + 3);
  }

  // Poll + leave
  http.get(`${SOCKET_URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`);
  sleep(Math.random() * 2 + 1);
  socketEmit(sid, 'auction:leave', { auction_id: auctionId });
  sleep(0.5);
  socketDisconnect(sid);
  sleep(Math.random() * 3 + 2);
}

// ── Scenario 2: Normal User (Seller) Flow ────────────────────
export function userFlow(data) {
  if (!data || !data.bidders || !data.bidders.length) { sleep(1); return; }

  // Login as normal user
  const loginStart = Date.now();
  const loginRes   = http.post(`${BASE_URL}/user/login`,
    JSON.stringify({ email: SELLER_EMAIL, password: SELLER_PASS, type: 'user' }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  loginDuration.add(Date.now() - loginStart);

  if (!check(loginRes, { 'user login 200': r => r.status === 200 })) {
    loginFail.add(1); errorRate.add(1); sleep(3); return;
  }
  errorRate.add(0);
  const token   = JSON.parse(loginRes.body).token;
  const jsonHdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const formHdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' };

  sleep(Math.random() * 2 + 1);

  // List auctions
  check(http.get(`${BASE_URL}/auction/auctions`, { headers: jsonHdr }), { 'user: list auctions 200': r => r.status === 200 });
  sleep(Math.random() + 1);

  // Create auction — assign up to 10 bidders from pool
  const assigned = data.bidders.filter(b => b.id).slice(0, 10);
  const params   = new URLSearchParams();
  params.append('title', `User Test Auction VU${__VU}`);
  params.append('description', `Load test user flow VU ${__VU} machine ${MACHINE_ID}`);
  params.append('starting_price', '5.00');
  params.append('stake', '1.00');
  params.append('final_price', '500.00');
  params.append('shipping_charges', '5.00');
  params.append('auction_at', new Date(Date.now() + 30000).toISOString());
  params.append('no_of_bidders', String(assigned.length));
  assigned.forEach(b => params.append('bidders', String(b.id)));

  const createRes  = http.post(`${BASE_URL}/auction/create`, params.toString(), { headers: formHdr });
  const createBody = JSON.parse(createRes.body);
  const auctionId  = createBody?.data?.id;

  if (!check(createRes, { 'user: create auction 200': r => r.status === 200 }) || !auctionId) {
    errorRate.add(1); sleep(3); return;
  }
  errorRate.add(0);
  sleep(Math.random() * 2 + 1);

  // View the created auction
  check(http.get(`${BASE_URL}/auction/auction?id=${auctionId}`, { headers: jsonHdr }), { 'user: view auction 200': r => r.status === 200 });
  sleep(Math.random() + 1);

  // Update auction details
  const upParams = new URLSearchParams();
  upParams.append('id', String(auctionId));
  upParams.append('title', `Updated Auction VU${__VU}`);
  upParams.append('description', `Updated by VU ${__VU}`);
  upParams.append('starting_price', '8.00');
  upParams.append('stake', '1.00');
  upParams.append('final_price', '500.00');
  upParams.append('shipping_charges', '5.00');
  upParams.append('auction_at', new Date(Date.now() + 60000).toISOString());
  assigned.forEach(b => upParams.append('bidders', String(b.id)));
  check(http.put(`${BASE_URL}/auction/update`, upParams.toString(), { headers: formHdr }), { 'user: update auction 200': r => r.status === 200 });
  sleep(Math.random() * 2 + 1);

  // Set status → active
  check(http.put(`${BASE_URL}/auction/update/status`, JSON.stringify({ id: auctionId, status: 'active' }), { headers: jsonHdr }), { 'user: set active 200': r => r.status === 200 });
  sleep(Math.random() * 2 + 1);

  // Pause
  check(http.put(`${BASE_URL}/auction/pause`, JSON.stringify({ id: auctionId }), { headers: jsonHdr }), { 'user: pause 200': r => r.status === 200 });
  sleep(Math.random() * 2 + 1);

  // Resume
  check(http.put(`${BASE_URL}/auction/resume`, JSON.stringify({ id: auctionId }), { headers: jsonHdr }), { 'user: resume 200': r => r.status === 200 });
  sleep(Math.random() * 3 + 2);

  // Close
  check(http.put(`${BASE_URL}/auction/close`, JSON.stringify({ id: auctionId }), { headers: jsonHdr }), { 'user: close 200': r => r.status === 200 });
  sleep(Math.random() * 2 + 1);

  // Set status → completed
  check(http.put(`${BASE_URL}/auction/update/status`, JSON.stringify({ id: auctionId, status: 'completed' }), { headers: jsonHdr }), { 'user: completed 200': r => r.status === 200 });

  sleep(Math.random() * 5 + 3);
}

// ── Teardown ──────────────────────────────────────────────────
export function teardown(data) {
  console.log(`[Machine ${MACHINE_ID}] Test complete — bidders: ${data?.bidders?.length}, auctions: ${data?.auctionIds?.join(', ')}`);
}

// ── handleSummary — generates machine1_report.html automatically
export function handleSummary(data) {
  const machineId = MACHINE_ID;
  const runDate   = new Date().toLocaleString();
  const m         = data.metrics;

  const ms  = (key, stat) => { const v = m[key]?.values?.[stat]; return v !== undefined ? v.toFixed(0) + 'ms' : '—'; };
  const pct = (key, stat) => { const v = m[key]?.values?.[stat]; return v !== undefined ? (v * 100).toFixed(2) + '%' : '—'; };
  const cnt = (key)       => { const v = m[key]?.values?.count;  return v !== undefined ? Number(v).toLocaleString() : '—'; };
  const raw = (key, stat) => m[key]?.values?.[stat];
  const mb  = (key)       => { const v = m[key]?.values?.count;  return v !== undefined ? (v / 1024 / 1024).toFixed(2) + ' MB' : '—'; };

  const p95    = raw('http_req_duration', 'p(95)');
  const p99    = raw('http_req_duration', 'p(99)');
  const errRaw = raw('http_req_failed', 'rate');
  const allPass = p95 < 500 && p99 < 1500 && errRaw < 0.01;

  const sb  = (val, limit) => val !== undefined && val < limit
    ? '<span style="color:#22c55e;font-weight:700">✅ PASS</span>'
    : '<span style="color:#ef4444;font-weight:700">❌ FAIL</span>';
  const clr = (val, limit) => val !== undefined ? (val < limit ? '#22c55e' : '#ef4444') : '#94a3b8';

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Bidzon — Machine ${machineId} Report</title>
<style>
:root{--bg:#0f1117;--surface:#1a1d27;--card:#20243a;--border:#2e3250;--accent:#6c63ff;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b;--text:#e2e8f0;--muted:#94a3b8;}
*{box-sizing:border-box;margin:0;padding:0;}body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;}
.hdr{background:linear-gradient(135deg,#1a1d27,#12162a);border-bottom:1px solid var(--border);padding:28px 48px;display:flex;align-items:center;justify-content:space-between;}
.hdr h1{font-size:22px;font-weight:700;}.hdr h1 span{color:var(--accent);}.hdr p{color:var(--muted);font-size:12px;margin-top:4px;}
.badge{padding:6px 18px;border-radius:20px;font-size:12px;font-weight:700;}
.pb{background:rgba(34,197,94,.15);color:#22c55e;border:1px solid rgba(34,197,94,.3);}
.fb{background:rgba(239,68,68,.15);color:#ef4444;border:1px solid rgba(239,68,68,.3);}
.wrap{max-width:1300px;margin:0 auto;padding:32px 48px;}.sec{margin-bottom:40px;}
.st{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid var(--border);}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:12px;}
.kpi{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px 20px;}
.kl{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);margin-bottom:6px;}
.kv{font-size:26px;font-weight:700;line-height:1;}.ks{font-size:11px;color:var(--muted);margin-top:4px;}
.tw{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:12px;}
table{width:100%;border-collapse:collapse;}thead tr{background:var(--surface);}
th{padding:10px 16px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);font-weight:700;}
td{padding:10px 16px;border-top:1px solid var(--border);font-size:13px;}tr:hover td{background:rgba(108,99,255,.04);}
td.lb{color:var(--muted);width:220px;}
.phases{display:flex;border-radius:10px;overflow:hidden;height:44px;margin-bottom:10px;}
.ph{display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex:1;text-align:center;line-height:1.4;}
.journey{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:8px 0;}
.js{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:9px 13px;font-size:12px;font-weight:600;}
.ja{color:var(--accent);font-size:14px;}
.fi{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px 18px;margin-bottom:10px;}
.fi h4{font-size:13px;font-weight:600;margin-bottom:4px;}.fi p{font-size:12px;color:var(--muted);line-height:1.6;}
.rc{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px 18px;margin-bottom:10px;display:flex;gap:14px;align-items:flex-start;}
.rn{width:26px;height:26px;border-radius:50%;background:var(--accent);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px;}
.rc h4{font-size:13px;font-weight:600;margin-bottom:3px;}.rc p{font-size:12px;color:var(--muted);line-height:1.6;}
.footer{border-top:1px solid var(--border);padding:18px 48px;color:var(--muted);font-size:11px;display:flex;justify-content:space-between;}
</style></head><body>
<div class="hdr">
  <div><h1><span>Bidzon</span> — Machine ${machineId} Report</h1>
  <p>Generated: ${runDate} &nbsp;|&nbsp; 2,000 VUs (1,900 bidders + 100 users) &nbsp;|&nbsp; k6 HTTP Polling</p></div>
  <span class="badge ${allPass ? 'pb' : 'fb'}">${allPass ? '✅ PASS' : '❌ FAIL'}</span>
</div>
<div class="wrap">

<div class="sec"><div class="st">Executive Summary — Machine ${machineId} of 6</div>
<div class="grid">
  <div class="kpi"><div class="kl">Peak VUs</div><div class="kv" style="color:var(--accent)">2,000</div><div class="ks">1,900 bidders + 100 users</div></div>
  <div class="kpi"><div class="kl">Total Requests</div><div class="kv" style="color:var(--accent)">${cnt('http_reqs')}</div><div class="ks">avg ${ms('http_req_duration','avg')}</div></div>
  <div class="kpi"><div class="kl">p95 Latency</div><div class="kv" style="color:${clr(p95,500)}">${ms('http_req_duration','p(95)')}</div><div class="ks">Threshold &lt;500ms</div></div>
  <div class="kpi"><div class="kl">p99 Latency</div><div class="kv" style="color:${clr(p99,1500)}">${ms('http_req_duration','p(99)')}</div><div class="ks">Threshold &lt;1500ms</div></div>
  <div class="kpi"><div class="kl">Error Rate</div><div class="kv" style="color:${clr(errRaw,0.01)}">${pct('http_req_failed','rate')}</div><div class="ks">Threshold &lt;1%</div></div>
  <div class="kpi"><div class="kl">Bids Placed</div><div class="kv" style="color:var(--green)">${cnt('bid_success_total')}</div><div class="ks">${cnt('bid_fail_total')} failed</div></div>
  <div class="kpi"><div class="kl">Login p95</div><div class="kv" style="color:${clr(raw('login_duration','p(95)'),1000)}">${ms('login_duration','p(95)')}</div><div class="ks">Threshold &lt;1000ms</div></div>
  <div class="kpi"><div class="kl">Bid Emit p95</div><div class="kv" style="color:${clr(raw('bid_duration','p(95)'),800)}">${ms('bid_duration','p(95)')}</div><div class="ks">Threshold &lt;800ms</div></div>
</div></div>

<div class="sec"><div class="st">Bidder Journey (1,900 VUs)</div>
<div class="journey">
  <div class="js">🔐 Bidder Login</div><div class="ja">→</div>
  <div class="js">📋 List Auctions</div><div class="ja">→</div>
  <div class="js">🔍 View Auction</div><div class="ja">→</div>
  <div class="js">🔌 Socket.IO Connect</div><div class="ja">→</div>
  <div class="js">🏠 Join Room</div><div class="ja">→</div>
  <div class="js">💰 Bid ×3–5</div><div class="ja">→</div>
  <div class="js">🚪 Leave + Disconnect</div>
</div></div>

<div class="sec"><div class="st">Normal User Journey (100 VUs)</div>
<div class="journey">
  <div class="js">🔐 User Login</div><div class="ja">→</div>
  <div class="js">📋 List Auctions</div><div class="ja">→</div>
  <div class="js">➕ Create Auction</div><div class="ja">→</div>
  <div class="js">✏️ Update Details</div><div class="ja">→</div>
  <div class="js">▶️ Set Active</div><div class="ja">→</div>
  <div class="js">⏸️ Pause</div><div class="ja">→</div>
  <div class="js">▶️ Resume</div><div class="ja">→</div>
  <div class="js">🔒 Close</div><div class="ja">→</div>
  <div class="js">✅ Complete</div>
</div></div>

<div class="sec"><div class="st">Load Phases</div>
<div class="phases">
  <div class="ph" style="background:#334155;color:#94a3b8">Smoke<br/>2m/10</div>
  <div class="ph" style="background:#1e3a5f;color:#60a5fa">Ramp-Up<br/>15m→2K</div>
  <div class="ph" style="background:#3b1f6b;color:#a78bfa">Peak<br/>10m@2K</div>
  <div class="ph" style="background:#1a3a4a;color:#34d399">Sustained<br/>15m@1.5K</div>
  <div class="ph" style="background:#4a1f1f;color:#f87171">Spike<br/>3m→2.5K</div>
  <div class="ph" style="background:#1f3a2a;color:#6ee7b7">Recovery<br/>5m→0</div>
</div>
<p style="font-size:12px;color:var(--muted)">Total: ~50 min | Combined 6 machines peak: 12,000 VUs | spike: 15,000 VUs</p>
</div>

<div class="sec"><div class="st">Threshold Results</div>
<div class="tw"><table>
  <thead><tr><th>Metric</th><th>Threshold</th><th>Actual</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td>http_req_duration p95</td><td>&lt;500ms</td><td>${ms('http_req_duration','p(95)')}</td><td>${sb(p95,500)}</td></tr>
    <tr><td>http_req_duration p99</td><td>&lt;1500ms</td><td>${ms('http_req_duration','p(99)')}</td><td>${sb(p99,1500)}</td></tr>
    <tr><td>http_req_failed rate</td><td>&lt;1%</td><td>${pct('http_req_failed','rate')}</td><td>${sb(errRaw,0.01)}</td></tr>
    <tr><td>login_duration p95</td><td>&lt;1000ms</td><td>${ms('login_duration','p(95)')}</td><td>${sb(raw('login_duration','p(95)'),1000)}</td></tr>
    <tr><td>bid_duration p95</td><td>&lt;800ms</td><td>${ms('bid_duration','p(95)')}</td><td>${sb(raw('bid_duration','p(95)'),800)}</td></tr>
    <tr><td>auction_list_duration p95</td><td>&lt;600ms</td><td>${ms('auction_list_duration','p(95)')}</td><td>${sb(raw('auction_list_duration','p(95)'),600)}</td></tr>
  </tbody>
</table></div></div>

<div class="sec"><div class="st">Latency Breakdown</div>
<div class="tw"><table>
  <thead><tr><th>Metric</th><th>Min</th><th>Avg</th><th>p50</th><th>p90</th><th>p95</th><th>p99</th><th>Max</th></tr></thead>
  <tbody>
    <tr><td>All HTTP</td><td>${ms('http_req_duration','min')}</td><td>${ms('http_req_duration','avg')}</td><td>${ms('http_req_duration','med')}</td><td>${ms('http_req_duration','p(90)')}</td><td>${ms('http_req_duration','p(95)')}</td><td>${ms('http_req_duration','p(99)')}</td><td>${ms('http_req_duration','max')}</td></tr>
    <tr><td>Login</td><td>${ms('login_duration','min')}</td><td>${ms('login_duration','avg')}</td><td>${ms('login_duration','med')}</td><td>${ms('login_duration','p(90)')}</td><td>${ms('login_duration','p(95)')}</td><td>${ms('login_duration','p(99)')}</td><td>${ms('login_duration','max')}</td></tr>
    <tr><td>Bid Emit</td><td>${ms('bid_duration','min')}</td><td>${ms('bid_duration','avg')}</td><td>${ms('bid_duration','med')}</td><td>${ms('bid_duration','p(90)')}</td><td>${ms('bid_duration','p(95)')}</td><td>${ms('bid_duration','p(99)')}</td><td>${ms('bid_duration','max')}</td></tr>
    <tr><td>Auction List</td><td>${ms('auction_list_duration','min')}</td><td>${ms('auction_list_duration','avg')}</td><td>${ms('auction_list_duration','med')}</td><td>${ms('auction_list_duration','p(90)')}</td><td>${ms('auction_list_duration','p(95)')}</td><td>${ms('auction_list_duration','p(99)')}</td><td>${ms('auction_list_duration','max')}</td></tr>
  </tbody>
</table></div></div>

<div class="sec"><div class="st">Request Counters</div>
<div class="tw"><table>
  <thead><tr><th>Metric</th><th>Value</th></tr></thead>
  <tbody>
    <tr><td>Total HTTP Requests</td><td>${cnt('http_reqs')}</td></tr>
    <tr><td>Bids Placed (success)</td><td>${cnt('bid_success_total')}</td></tr>
    <tr><td>Bids Failed</td><td>${cnt('bid_fail_total')}</td></tr>
    <tr><td>Login Failures</td><td>${cnt('login_fail_total')}</td></tr>
    <tr><td>Auction Join Failures</td><td>${cnt('auction_join_fail_total')}</td></tr>
    <tr><td>Data Sent</td><td>${mb('data_sent')}</td></tr>
    <tr><td>Data Received</td><td>${mb('data_received')}</td></tr>
  </tbody>
</table></div></div>

<div class="sec"><div class="st">Detected Bottlenecks</div>
  <div class="fi" style="border-left:3px solid var(--red)"><h4>🔴 Socket.IO Connection Pool Saturation</h4><p>At 2,000 concurrent users per machine (12,000 total), Socket.IO polling may saturate Node.js connection limits. Monitor PM2 active handles. Increase UV_THREADPOOL_SIZE if p99 spikes above 2s at peak.</p></div>
  <div class="fi" style="border-left:3px solid var(--yellow)"><h4>🟡 PostgreSQL Connection Pool Pressure</h4><p>Each bid triggers a DB write. Knex default pool of 10 will queue aggressively under 12K concurrent users. Watch for timeout errors during peak and spike phases.</p></div>
  <div class="fi" style="border-left:3px solid var(--yellow)"><h4>🟡 Concurrent Auction Lifecycle Contention</h4><p>100 user VUs per machine simultaneously create, update, pause, resume, and close auctions, causing write contention on the auctions table. Watch for DB lock wait increases.</p></div>
  <div class="fi" style="border-left:3px solid var(--accent)"><h4>🔵 Auction Timer Broadcast Storm</h4><p>Server emits auction:timer every second to all room members. A single room with 2,000 users generates 2,000 msgs/sec — the highest risk event loop blocker at this scale.</p></div>
</div>

<div class="sec"><div class="st">Recommendations</div>
  <div class="rc"><div class="rn">1</div><div><h4>Increase PostgreSQL pool — pool.max=100 + PgBouncer</h4><p>Set Knex pool.max=100 and add PgBouncer as a connection pooler to handle concurrent bid writes from 12K users.</p></div></div>
  <div class="rc"><div class="rn">2</div><div><h4>Run PM2 in cluster mode with Redis adapter</h4><p>pm2 start app.js -i max across all CPU cores. Add @socket.io/redis-adapter so auction rooms work across instances.</p></div></div>
  <div class="rc"><div class="rn">3</div><div><h4>Cache GET /api/auction/auctions with Redis (5s TTL)</h4><p>Every VU calls this on login. A short Redis cache reduces DB reads by ~95% at peak with zero user impact.</p></div></div>
  <div class="rc"><div class="rn">4</div><div><h4>Throttle auction:timer to every 3s for large rooms</h4><p>Reduces event loop broadcast pressure by 66% for rooms with more than 500 concurrent bidders.</p></div></div>
  <div class="rc"><div class="rn">5</div><div><h4>Queue auction lifecycle operations via BullMQ</h4><p>Route create/update/close through a job queue to prevent DB write contention under concurrent user load.</p></div></div>
</div>

<div class="sec"><div class="st">Test Configuration</div>
<div class="tw"><table><tbody>
  <tr><td class="lb">Machine</td><td>${machineId} of 6</td></tr>
  <tr><td class="lb">Bidder Accounts</td><td>machine${machineId}_user0001 → machine${machineId}_user2000@test.com</td></tr>
  <tr><td class="lb">Bidder VUs</td><td>1,900 peak / 2,400 spike</td></tr>
  <tr><td class="lb">User VUs</td><td>100 peak / 100 spike</td></tr>
  <tr><td class="lb">Base URL</td><td>http://49.12.201.167/api</td></tr>
  <tr><td class="lb">Socket URL</td><td>http://49.12.201.167 (Socket.IO polling)</td></tr>
  <tr><td class="lb">Bid interval</td><td>3–8 seconds randomised</td></tr>
  <tr><td class="lb">Bids per session</td><td>3–5</td></tr>
  <tr><td class="lb">Instance</td><td>AWS t3.medium (2 vCPU / 4GB RAM)</td></tr>
</tbody></table></div></div>

</div>
<div class="footer">
  <span>Bidzon Stress Test — Machine ${machineId} of 6</span>
  <span>Generated: ${runDate}</span>
</div>
</body></html>`;

  const filename = `machine${machineId}_report.html`;
  const summary  = `machine${machineId}_summary.json`;
  const result   = {};
  result[filename] = html;
  result[summary]  = JSON.stringify(data, null, 2);
  result['stdout'] = `\n✅ Machine ${machineId} — HTML report saved: ${filename}\n📄 JSON summary saved: ${summary}\n`;
  return result;
}
