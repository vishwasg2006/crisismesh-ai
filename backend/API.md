# CrisisMesh API (for the frontend)

Base URL: `http://<backend-ip>:4000`  - all REST under `/api`, JSON in/out, CORS open.
Errors: `{ "error": "message" }` with 400/404/409/422.
Times are epoch ms. `etaMin`, `startMin`, `finishMin` are minutes from "now" (plan creation, T+0).

## Quick start for the UI
1. `GET /api/state` -> everything for first render (settlements, routes, resources, reports, incidents, latest plan, network, sync).
2. Open `ws://<ip>:4000/ws`. On every message `{type, payload, ts}`; refetch `/api/state` (or the specific resource) when you get `plan.updated`, `report.created`, `network.changed`, `sync.completed`, `terrain.updated`.

## WebSocket event types
`hello` | `report.created` | `plan.updated` | `plan.approved` | `plan.rejected` | `plan.modified` | `network.changed` | `sync.queued` | `sync.completed` | `terrain.updated` | `route.updated` | `resource.updated` | `hazard.changed` | `scenario.reset`

## Endpoints

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/health` | | node, store (mysql/json), online, llm.up |
| GET | `/api/state` | | all-in-one dashboard payload |
| POST | `/api/scenario/reset` | | reload synthetic flood scenario + first plan |
| GET | `/api/profiles` / POST `/api/profile` | `{hazard:"flood"\|"fire"\|"landslide"}` | |
| POST | `/api/simulate/tick` | `{minutes:30}` | water levels rise by rate, replans |
| GET | `/api/network` / `/api/sync/status` | | `{online, inboxPending, localUnsynced, lastSync}` |
| POST | `/api/network` | `{online:false}` | going online triggers sync + replan; response has `sync` summary |
| POST | `/api/sync` | | manual sync (409 if offline) |
| POST | `/api/sync/remote-inbox` | `{demo:true}` or `{reports:[...]}` or one report | simulates reports from other nodes/cloud |
| GET | `/api/reports` | `?source=&unsynced=true` | |
| POST | `/api/reports` | see below | returns `{report (parsed), plan:{id,version,mode,diff}}` |
| POST | `/api/sensors/reading` | `{settlementId, waterLevelM, riseRateMPerHr?}` | simulated gauge feed |
| GET | `/api/settlements` `/routes` `/resources` | | map data |
| PATCH | `/api/settlements/:id` | `{waterLevelM?, riseRateMPerHr?, criticalLevelM?}` | replans |
| PATCH | `/api/routes/:id` | `{status:"open"\|"blocked"\|"flooded", note?}` | replans |
| PATCH | `/api/resources/:id` | `{status:"available"\|"busy"\|"offline"}` | replans |
| GET | `/api/incidents` | `?status=active\|resolved` | sorted by priority rank; includes `terrain`, `priority`, `flags` |
| GET | `/api/incidents/:id` | | incident + its source reports |
| GET | `/api/plans` | | list (summary) |
| GET | `/api/plans/latest` / `/approved` / `/:id` | | full plan |
| GET | `/api/plans/:id/diff` / `/trace` | | plan diff / agent trace |
| POST | `/api/plans/replan` | | force a new draft |
| POST | `/api/plans/:id/approve` | `{by, note?}` | only latest draft (409 otherwise) |
| POST | `/api/plans/:id/reject` | `{by, reason?}` | |
| PATCH | `/api/plans/:id/assignments/:aid` | `{resourceId, by?, note?}` | human override -> locked, new draft returned |
| DELETE | `/api/locks/:incidentId` | | remove manual override |
| GET | `/api/events` | `?since=<seq>&limit=` | append-only audit log |

### POST /api/reports body
```json
{
  "source": "field | volunteer | citizen | sensor",
  "text": "Sangam Colony temple lane: 12 people trapped on roof, water chest high",
  "reporterName": "optional",
  "lat": 12.3046, "lng": 76.6804,
  "settlementId": "S4",
  "peopleCount": 12,
  "minutesAgo": 0
}
```
Only `text` is required (lat+lng together if given). Location is read from the text if `settlementId` is omitted.

## Key shapes

**Incident**: `{id, settlementId, settlementName, lat, lng, people, peopleMin, peopleMax, hazards[], needs[], vulnerable, confidence, flags[{type,message}], status, reportIds[], summary, terrain, priority}`
flag types: `duplicate_merged | conflict | stale | assumed_count | low_confidence | resolved`

**Priority**: `{rank, score, components:{danger,people,access,time}: {score,weight,reason}, explanation, timeLeftMin}`

**Plan**: `{id, version, status: draft|approved|rejected|superseded, mode: online|offline, assignments[], unassigned[], priorities[], trace[], summary, narrative, warnings[], diff, modifications[]}`

**Assignment**: `{id, incidentId, settlementName, resourceId, resourceName, mode: water|road, peopleServed, trips, etaMin, startMin, finishMin, route[] (settlement ids, draw as polyline), atRisk, locked, reason, warnings[]}`

**Plan diff item**: `{type: added|removed|changed|priority|unassigned, settlementName, detail}`

**Agent trace entry**: `{agent, ms, summary, details[]}` - show as the "agent trace" panel.

Map: Leaflet markers from `settlements` (lat/lng, `waterLevelM`), `incidents` (lat/lng), polylines from `assignment.route` mapped through settlement coordinates (`BASE` is in `settlements` too). Colour routes by `routes[].status`.

## Peer merge (split brain)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/peer/snapshot` | this node's claims + locally-originated reports |
| POST | `/api/peer/merge` | body = a peer snapshot; returns `{conflicts, needsHuman, planId, approvedAssignmentsChanged:0}` |
| POST | `/api/peer/sync` | `{peerUrl}`: pull peer, merge, push ours back |
| GET | `/api/merge/conflicts` | all conflicts (`needs_human`, `auto_resolved`, `resolved_by_human`) |
| POST | `/api/merge/conflicts/:id/resolve` | `{keepClaimId, by, note}`; creates a new draft, never edits the approved plan |

`GET /api/state` now also returns `node`, `claims`, `mergeConflicts`; incidents carry `independentSources` and `echoGroups`.
