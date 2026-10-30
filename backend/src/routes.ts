import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { config } from './config';
import { getKv, getStore } from './db/store';
import { DEMO_REMOTE_REPORTS, seedToPayload } from './db/seed';
import { llmAvailable } from './agents/llm';
import { PROFILES } from './profiles';
import { Hazard, Incident, Plan, Report, Resource, Route, Settlement } from './types';
import { HttpError } from './util';
import * as ops from './services/ops';
import { loadConflicts } from './services/claims';
import { lock, runPipeline } from './services/pipeline';

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next: NextFunction) =>
    fn(req, res).catch(next);

const who = (req: Request): string => (typeof req.body?.by === 'string' && req.body.by.trim() ? req.body.by.trim().slice(0, 60) : 'coordinator');
const str = (v: unknown): string => String(v);

export const api = Router();

// ---- health + state
api.get('/health', wrap(async (_req, res) => {
  const net = await getKv('network', { online: true, changedAt: 0 });
  res.json({
    ok: true, node: config.nodeId, store: getStore().kind, online: net.online,
    llm: { enabled: config.ollama.enabled, up: await llmAvailable(true), model: config.ollama.model },
    uptimeSec: Math.round(process.uptime()),
  });
}));
api.get('/state', wrap(async (_req, res) => res.json(await ops.getState())));

// ---- scenario / hazard / simulation
api.post('/scenario/reset', wrap(async (_req, res) => {
  const p = await ops.resetScenario();
  res.json({ ok: true, planId: p.id });
}));
api.get('/profiles', (_req, res) => res.json(Object.entries(PROFILES).map(([id, p]) => ({ id, label: p.label, weights: p.weights }))));
api.post('/profile', wrap(async (req, res) => {
  const h = req.body?.hazard as Hazard;
  if (!PROFILES[h]) throw new HttpError(400, 'hazard must be flood|fire|landslide');
  const p = await ops.setHazard(h);
  res.json({ ok: true, hazard: h, planId: p.id });
}));
api.post('/simulate/tick', wrap(async (req, res) => {
  const m = req.body?.minutes === undefined ? 30 : Number(req.body.minutes);
  if (!Number.isFinite(m) || m <= 0 || m > 720) throw new HttpError(400, 'minutes must be 1..720');
  const p = await ops.tick(m);
  res.json({ ok: true, planId: p.id, diff: p.diff?.summary ?? [] });
}));

// ---- network (offline-first demo switch) + sync
api.get('/network', wrap(async (_req, res) => res.json(await ops.syncStatus())));
api.post('/network', wrap(async (req, res) => {
  if (typeof req.body?.online !== 'boolean') throw new HttpError(400, 'body must be {"online": true|false}');
  res.json(await ops.setNetwork(req.body.online));
}));
api.get('/sync/status', wrap(async (_req, res) => res.json(await ops.syncStatus())));
api.post('/sync', wrap(async (_req, res) => res.json(await ops.syncNow())));
api.post('/sync/remote-inbox', wrap(async (req, res) => {
  const b = req.body ?? {};
  const raw: unknown[] = b.demo === true ? DEMO_REMOTE_REPORTS.map(seedToPayload) : Array.isArray(b.reports) ? b.reports : b.text ? [b] : [];
  if (!raw.length) throw new HttpError(400, 'send {demo:true}, {reports:[...]} or a single report');
  const inputs = raw.map(ops.cleanReportInput);
  for (const i of inputs)
    if (i.settlementId && !(await getStore().get('settlements', i.settlementId))) throw new HttpError(400, `unknown settlementId ${i.settlementId}`);
  res.status(202).json(await ops.queueRemote(inputs));
}));

// ---- peer merge (two coordinator laptops that were split)
api.get('/peer/snapshot', wrap(async (_req, res) => res.json(await ops.peerSnapshot())));
api.post('/peer/merge', wrap(async (req, res) => res.json(await ops.mergePeer(req.body))));
api.post('/peer/sync', wrap(async (req, res) => {
  if (typeof req.body?.peerUrl !== 'string') throw new HttpError(400, 'body needs {"peerUrl":"http://<other-laptop>:4000"}');
  res.json(await ops.syncWithPeer(req.body.peerUrl));
}));
api.get('/merge/conflicts', wrap(async (_req, res) => res.json(await loadConflicts())));
api.post('/merge/conflicts/:id/resolve', wrap(async (req, res) => {
  if (typeof req.body?.keepClaimId !== 'string') throw new HttpError(400, 'body needs {"keepClaimId":"<claim id>"}');
  res.json(await ops.resolveConflict(str(req.params.id), req.body.keepClaimId, who(req), req.body.note));
}));

// ---- reports
api.get('/reports', wrap(async (req, res) => {
  let rs = await getStore().list<Report>('reports');
  if (req.query.source) rs = rs.filter((r) => r.source === req.query.source);
  if (req.query.unsynced === 'true') rs = rs.filter((r) => !r.synced);
  res.json(rs.sort((a, b) => b.timestamp - a.timestamp));
}));
api.get('/reports/:id', wrap(async (req, res) => {
  const r = await getStore().get<Report>('reports', str(req.params.id));
  if (!r) throw new HttpError(404, 'report not found');
  res.json(r);
}));
api.post('/reports', wrap(async (req, res) => res.status(201).json(await ops.submitReport(ops.cleanReportInput(req.body)))));
api.post('/sensors/reading', wrap(async (req, res) => {
  const { settlementId, waterLevelM, riseRateMPerHr } = req.body ?? {};
  if (typeof settlementId !== 'string' || typeof waterLevelM !== 'number') throw new HttpError(400, 'need settlementId (string) and waterLevelM (number)');
  res.status(201).json(await ops.sensorReading(settlementId, waterLevelM, typeof riseRateMPerHr === 'number' ? riseRateMPerHr : undefined));
}));

// ---- terrain data
api.get('/settlements', wrap(async (_req, res) => res.json(await getStore().list<Settlement>('settlements'))));
api.patch('/settlements/:id', wrap(async (req, res) => res.json(await ops.patchSettlement(str(req.params.id), req.body ?? {}))));
api.get('/routes', wrap(async (_req, res) => res.json(await getStore().list<Route>('routes'))));
api.patch('/routes/:id', wrap(async (req, res) => res.json(await ops.patchRoute(str(req.params.id), req.body ?? {}))));
api.get('/resources', wrap(async (_req, res) => res.json(await getStore().list<Resource>('resources'))));
api.patch('/resources/:id', wrap(async (req, res) => res.json(await ops.patchResource(str(req.params.id), req.body ?? {}))));

// ---- incidents
api.get('/incidents', wrap(async (req, res) => {
  let is = await getStore().list<Incident>('incidents');
  if (req.query.status) is = is.filter((i) => i.status === req.query.status);
  res.json(is.sort((a, b) => (a.priority?.rank ?? 999) - (b.priority?.rank ?? 999)));
}));
api.get('/incidents/:id', wrap(async (req, res) => {
  const i = await getStore().get<Incident>('incidents', str(req.params.id));
  if (!i) throw new HttpError(404, 'incident not found');
  const reports = await Promise.all(i.reportIds.map((id) => getStore().get<Report>('reports', id)));
  res.json({ ...i, reports });
}));

// ---- plans (draft -> modify -> approve)
const plansSorted = async () => (await getStore().list<Plan>('plans')).sort((a, b) => b.version - a.version);
api.get('/plans', wrap(async (_req, res) =>
  res.json((await plansSorted()).map((p) => ({ id: p.id, version: p.version, status: p.status, mode: p.mode, trigger: p.trigger, createdAt: p.createdAt, summary: p.summary, approvedBy: p.approvedBy ?? null })))));
api.get('/plans/latest', wrap(async (_req, res) => {
  const p = (await plansSorted())[0];
  if (!p) throw new HttpError(404, 'no plan yet');
  res.json(p);
}));
api.get('/plans/approved', wrap(async (_req, res) => {
  const p = (await plansSorted()).find((x) => x.status === 'approved');
  if (!p) throw new HttpError(404, 'no approved plan yet');
  res.json(p);
}));
api.post('/plans/replan', wrap(async (_req, res) => res.status(201).json(await lock.run(() => runPipeline('manual-replan')))));
api.get('/plans/:id', wrap(async (req, res) => {
  const p = await getStore().get<Plan>('plans', str(req.params.id));
  if (!p) throw new HttpError(404, 'plan not found');
  res.json(p);
}));
api.get('/plans/:id/diff', wrap(async (req, res) => {
  const p = await getStore().get<Plan>('plans', str(req.params.id));
  if (!p) throw new HttpError(404, 'plan not found');
  res.json(p.diff ?? { items: [], summary: ['No baseline plan to compare with'] });
}));
api.get('/plans/:id/trace', wrap(async (req, res) => {
  const p = await getStore().get<Plan>('plans', str(req.params.id));
  if (!p) throw new HttpError(404, 'plan not found');
  res.json(p.trace);
}));
api.post('/plans/:id/approve', wrap(async (req, res) => res.json(await ops.approvePlan(str(req.params.id), who(req), req.body?.note))));
api.post('/plans/:id/reject', wrap(async (req, res) => res.json(await ops.rejectPlan(str(req.params.id), who(req), req.body?.reason))));
api.patch('/plans/:id/assignments/:aid', wrap(async (req, res) => {
  if (typeof req.body?.resourceId !== 'string') throw new HttpError(400, 'body needs {"resourceId":"B2"}');
  res.json(await ops.reassign(str(req.params.id), str(req.params.aid), req.body.resourceId, who(req), req.body.note, req.body.overrideApproved === true));
}));
api.delete('/locks/:incidentId', wrap(async (req, res) => res.json(await ops.removeLock(str(req.params.incidentId)))));

// ---- event log (append-only audit trail)
api.get('/events', wrap(async (req, res) => {
  const since = Number(req.query.since ?? 0) || 0;
  const limit = Math.min(500, Number(req.query.limit ?? 100) || 100);
  res.json(await getStore().events(since, limit));
}));
