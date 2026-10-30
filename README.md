# CrisisMesh AI - connected (frontend + backend)

```
crisismesh/
  backend/    Node + TypeScript (Express, WebSocket, multi-agent pipeline)
  frontend/   Plain HTML/JS dashboards (landing, coordinator, responder)
```

## Run it

```bash
cd backend
npm install
cp .env.example .env      # Windows PowerShell: copy .env.example .env
npm run dev
```

Open **http://localhost:4000/app/** - the backend serves the frontend itself, so there is no CORS or URL setup.
MySQL and Ollama are optional (it falls back to a JSON file store and rule-based agents).

Frontend on another machine / port (e.g. VS Code Live Server)? Open it once with
`coordinator.html?api=http://<backend-ip>:4000` - the URL is remembered in localStorage.

## What is wired

| Frontend | Backend |
|---|---|
| Landing status pill | `GET /api/health` |
| Coordinator: incidents, priorities, teams, metrics, map (settlements, routes, plan paths) | `GET /api/state` + WebSocket `/ws` live refresh (8 s poll fallback) |
| Approve / Reject plan | `POST /api/plans/:id/approve`, `/reject` |
| Go Offline / Reconnect & Sync | `POST /api/network {online}` (reconnect returns the sync summary) |
| Receive Remote Reports | `POST /api/sync/remote-inbox {demo:true}` |
| Simulate +30 min | `POST /api/simulate/tick` |
| View Plan Changes | `plan.diff` from the latest plan |
| Reset Simulation | `POST /api/scenario/reset` |
| Responder: teams / boats | `resources` from `/api/state` |
| Responder: missions | assignments of `GET /api/plans/approved` (only after the coordinator approves) |
| Responder: submit report | `POST /api/reports` (source `field`) |

## Behaviour worth knowing

- **Human in the loop:** responders only see missions from an *approved* plan. Every new report creates a new draft that the coordinator must approve.
- **Backend down:** coordinator shows local demo data; responder saves reports in an on-device outbox and sends them automatically when the backend is back.
- **Client-side only (backend has no endpoint):** Verify/Reject on field reports, and Start/Complete on missions. They are stored in the browser's localStorage.
- Responder "incident" list is now the backend's incidents plus a "report from another area" group (settlements), so new locations can be reported.

## Changed files

Frontend: `js/api.js` (rewritten), `js/data.js` (new), `js/coordinator.js` and `js/responder.js` (rewritten), `js/map.js` (overlays, no reset on refresh), `js/app.js`, the two HTML pages.
Backend: `src/index.ts` and `src/config.ts` (serve `/app`), `.env.example` (`FRONTEND_DIR`).

## Hurdle: Split Brain and Fake Crowds

**Split brain (two coordinator laptops diverge, then reconnect)**
- Every plan assignment is a *claim* on a boat for a settlement + time window (`Claim` in `types.ts`). Approving a plan turns its claims into **approved** claims.
- `GET /api/peer/snapshot`, `POST /api/peer/merge`, `POST /api/peer/sync {peerUrl}` exchange claims + locally-originated reports between laptops. Run each laptop with a different `NODE_ID` (and `JSON_PATH`/`PORT`).
- `agents/merge.ts` `reconcile()` is pure + deterministic (commutative, idempotent), so both laptops reach the same answer:
  - approved vs unapproved -> **approved always wins**, the draft is dropped and re-planned (even if the draft has a higher priority score)
  - approved vs approved (two humans, same boat, overlapping time) -> **never auto-resolved**: both stay, flagged `needs_human`, the boat is frozen for new plans, plan warnings shout about it
  - draft vs draft -> higher priority wins, deterministic tiebreak
- A merge never edits an approved plan (`approvedAssignmentsChanged: 0`). It only produces a new **draft** for a human to approve. Resolve a clash with `POST /api/merge/conflicts/:id/resolve {keepClaimId, by}`.
- A human can still knowingly take an approved boat: `PATCH /plans/:id/assignments/:aid {resourceId, overrideApproved:true}` (audited, revokes the old approval).

**Fake crowds (six near-identical reports)**
- `agents/independence.ts`: reports that are the same reporter, or near-identical wording from crowd sources (citizen/volunteer) within 45 min, collapse into one *echo group* = one voice.
- Verification counts voices, not reports: confidence uses noisy-or over independent groups only, head-count uses one median per group, scattered pins from copies still merge into one incident, an `echo` flag explains it, and the allocator adds a "verify before committing a boat" warning.
- Field teams and gauges are never treated as copies of crowd reports, so real corroboration still raises confidence.

Test it: `npx tsx scripts/hurdle-test.ts` (no server needed, 22 checks).
