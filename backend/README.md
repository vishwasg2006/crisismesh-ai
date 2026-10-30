# CrisisMesh AI - Backend

Node.js + Express + TypeScript (run with `tsx`), WebSocket, MySQL + append-only event log, optional Ollama local LLM.
Team APEX INNOVATORS (AH 5).

## Run (Windows PowerShell)

```powershell
cd crisismesh-backend
npm install
copy .env.example .env      # edit MYSQL_PASSWORD etc.
npm run dev
```

Server: `http://localhost:4000` (REST `/api/...`, WebSocket `ws://localhost:4000/ws`).
First start auto-creates the MySQL database + tables and loads the synthetic flood scenario.

- **MySQL not running?** With `STORE=auto` (default) it falls back to a JSON file (`data/store.json`) so the demo never dies. Set `STORE=mysql` to force MySQL, `STORE=json` to force the file.
- **Ollama (local LLM):** `ollama pull llama3.2` and keep Ollama running. If it is down, rule-based agents are used automatically (check `GET /api/health` -> `llm.up`). Change model with `OLLAMA_MODEL`.
- **Friend's laptop:** server listens on `0.0.0.0` with CORS open. He uses `http://<your-LAN-IP>:4000` (find IP with `ipconfig`; allow Node through Windows Firewall on private networks).

## Test the whole flow

With the server running, in a second terminal:

```powershell
npm run demo
```

It walks through: messy reports -> plan -> approve -> network outage -> new local report + queued remote reports -> reconnect -> merge/conflicts/replan/plan diff -> human reassigns -> approve -> water rises + route blocked -> event log.

## What maps to the slides

| Slide item | Where |
|---|---|
| Incident Analysis (who/where/how many) | `src/agents/analysis.ts` (rules + Ollama JSON extraction) |
| Verification (merge duplicates, conflicts, stale) | `src/agents/verification.ts` |
| Terrain (flood zones, blocked routes) | `src/agents/terrain.ts` (Dijkstra over open boat/road routes) |
| Prioritization (transparent risk score) | `src/agents/prioritization.ts` (danger/people/access/time + reasons) |
| Resource Allocation (boats + teams under limits) | `src/agents/allocation.ts` (capacity, trips, busy-until schedule, unassigned list) |
| Response Planning (explainable plan) | `src/agents/planning.ts` (agents challenge each other, narrative, warnings) |
| Human approval + plan diff | `src/services/ops.ts` (approve / reject / reassign-with-lock), `src/agents/diff.ts` |
| Offline: local queue, sync, replan | `src/services/ops.ts` (`setNetwork`, `syncUnlocked`, `queueRemote`) |
| MySQL + event log | `src/db/mysqlStore.ts`, table `event_log` (`GET /api/events`) |
| Live sync / dashboard push | `src/bus.ts` (WebSocket broadcast) |
| Synthetic flood scenario | `src/db/seed.ts` |
| Fire / landslide as profiles | `src/profiles.ts`, `POST /api/profile` (flood fully modelled; others change weights/keywords only) |

## Demo script for review 2

1. `POST /api/scenario/reset` - 14 raw reports become 8 incidents (4 duplicates merged, 1 conflict, 1 stale, 1 resolved) and a draft plan.
2. Show `GET /api/plans/latest` -> `trace` (agent-by-agent) and each priority's `explanation`.
3. `POST /api/plans/PLAN-001/approve`.
4. `POST /api/network {"online":false}` - outage. `POST /api/reports` a new report: it is analysed locally, `synced:false`, plan mode = `offline`.
5. `POST /api/sync/remote-inbox {"demo":true}` - 4 citizen/volunteer reports held remotely.
6. `POST /api/network {"online":true}` - reconnect: merge, conflict flags, replan, `plan.diff` vs the approved plan.
7. `PATCH /api/plans/:id/assignments/:aid {"resourceId":"B1"}` - human modifies; `POST /api/plans/:id/approve`.

## Notes / honest limits

- Allocation is a constraint-aware greedy scheduler (not an optimal solver). It is deterministic and explainable.
- The "remote node" is simulated by an inbox (`/api/sync/remote-inbox`); there is no second running server yet. Everything is recorded in the event log so a real node-to-node sync can replay it.
- No authentication (hackathon scope).
