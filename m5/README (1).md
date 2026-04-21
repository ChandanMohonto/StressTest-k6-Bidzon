# Bidzon — Stress Test Suite

**Tool:** k6 | **Mode:** Socket.IO HTTP Long Polling  
**Scale:** 6 Machines × 2,000 VUs = **12,000 Concurrent Users**  
**Target:** `http://49.12.201.167/api`

---

## Project Structure

```
bidzon-k6/
├── scripts/
│   ├── machine1.js   ← Run on Machine 1 (user0001–2000)
│   ├── machine2.js   ← Run on Machine 2 (user0001–2000)
│   ├── machine3.js   ← Run on Machine 3 (user0001–2000)
│   ├── machine4.js   ← Run on Machine 4 (user0001–2000)
│   ├── machine5.js   ← Run on Machine 5 (user0001–2000)
│   └── machine6.js   ← Run on Machine 6 (user0001–2000)
├── reports/
│   └── report.html   ← HTML report (open in browser after test)
├── results/          ← Auto-created on run (JSON output per machine)
└── run.sh            ← Run script
```

---

## Bidder Account Pattern

Each machine creates its own 2,000 unique bidder accounts:

| Machine | Email Range |
|---------|-------------|
| 1 | `machine1_user0001@test.com` → `machine1_user2000@test.com` |
| 2 | `machine2_user0001@test.com` → `machine2_user2000@test.com` |
| 3 | `machine3_user0001@test.com` → `machine3_user2000@test.com` |
| 4 | `machine4_user0001@test.com` → `machine4_user2000@test.com` |
| 5 | `machine5_user0001@test.com` → `machine5_user2000@test.com` |
| 6 | `machine6_user0001@test.com` → `machine6_user2000@test.com` |

**Total: 12,000 unique accounts — no overlap between machines.**

---

## Load Phases (per machine)

| Phase | VUs | Duration | Purpose |
|-------|-----|----------|---------|
| Smoke | 10 | 2m | Validate script — no errors |
| Ramp-Up | 0 → 2,000 | 15m | Gradual load increase |
| Peak | 2,000 | 10m | Sustained max load |
| Sustained | 1,500 | 15m | Stability after peak |
| Spike | 2,500 | 3m | Sudden surge |
| Recovery | 0 | 5m | Graceful drain |

**Combined across 6 machines → Peak: 12,000 VUs | Spike: 15,000 VUs**

---

## User Journey per VU

```
1. POST /api/user/login        → Save JWT token + user ID
2. GET  /api/auction/auctions  → List available auctions
3. GET  /api/auction/auction   → View auction detail
4. GET  /socket.io/?EIO=4...   → Socket.IO handshake (get SID)
5. POST /socket.io/...         → emit("join", { id: user_id })
6. POST /socket.io/...         → emit("auction:join", { auction_id })
7. POST /socket.io/...         → emit("auction:bid", ...) × 3–5 times
8. POST /socket.io/...         → emit("auction:leave", { auction_id })
9. POST /socket.io/...         → disconnect (packet "41")
```

---

## Setup (one-time per machine)

```bash
# 1. Install k6
sudo gpg -k
sudo gpg --no-default-keyring \
  --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 \
  --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# 2. Clone / copy this repo to the machine
scp -r bidzon-k6/ ubuntu@<machine-ip>:~/

# 3. Make run script executable
chmod +x run.sh
```

---

## Running the Test

SSH into each machine and run simultaneously:

```bash
# Machine 1
./run.sh 1

# Machine 2
./run.sh 2

# ... Machine 3, 4, 5, 6
./run.sh 6
```

**Run all 6 simultaneously** — coordinate with a countdown or use a central trigger (tmux, Slack message, etc.).

---

## Viewing the Report

After the test completes, collect `results/machine*/summary.json` from all machines.

Open `reports/report.html` in a browser:
```
# Pass summary JSON via URL param to auto-populate metrics:
reports/report.html?data=../results/machine1/summary.json
```

Or open directly — the report shows pre-filled bottlenecks and recommendations. Update the metric values manually from the k6 terminal output.

---

## Thresholds (Pass/Fail Gates)

| Metric | Threshold |
|--------|-----------|
| `http_req_duration` p95 | < 500ms |
| `http_req_duration` p99 | < 1500ms |
| `http_req_failed` rate | < 1% |
| `login_duration` p95 | < 1000ms |
| `bid_duration` p95 | < 800ms |
| `auction_list_duration` p95 | < 600ms |

---

## What to Monitor on Backend During Test

```bash
# PM2 process health
pm2 monit

# CPU / RAM per second
watch -n 1 'free -m && echo "---" && top -bn1 | head -20'

# Active connections
ss -s

# PostgreSQL connections
psql -c "SELECT count(*) FROM pg_stat_activity;"
```

---

## Notes

- **Re-runs:** The setup phase handles duplicate emails gracefully — existing accounts are reused.
- **Auction assignment:** If auctions already exist on the server, the script uses them. New auctions are only created if none are found.
- **Coins:** Each bidder is created with 500 coins — enough for extended bidding sessions.
- **Token expiry:** JWT tokens expire after 7 days — no refresh needed within a single test run.
