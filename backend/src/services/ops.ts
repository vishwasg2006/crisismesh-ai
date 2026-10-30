import { emit } from '../bus';
import { getKv, getStore, setKv } from '../db/store';
import { seedScenario } from '../db/seed';
import { Claim, Hazard, Incident, MergeConflict, PeerMergeResult, PeerSnapshot, Plan, Report, Resource, Route, Settlement, Source } from '../types';
import { config } from '../config';
import { reconcile, reservations } from '../agents/merge';
import { loadClaims, loadConflicts, promoteApproved, saveClaims, saveConflicts } from './claims';
import { HttpError, round } from '../util';
import { Locks } from '../agents/allocation';
import { lock, runPipeline } from './pipeline';

export interface ReportInput {
  source?: Source;
  text?: string;
  reporterName?: string;
  lat?: number;
  lng?: number;
  settlementId?: string;
  peopleCount?: number;
  minutesAgo?: number;
  timestamp?: number;
  reading?: { waterLevelM: number; riseRateMPerHr?: number };
  originNode?: string;
  originId?: string;
}
interface QueueItem {
  id: string;
  payload: ReportInput & { timestamp: number };
  receivedAt: number;
  status: 'pending' | 'delivered';
}
export interface SyncResult {
  pulled: number;
  pushed: number;
  mergedIntoExisting: number;
  conflicts: number;
  planId: string | null;
  at: number;
  trigger: string;
}

const SOURCES: Source[] = ['sensor', 'field', 'volunteer', 'citizen'];
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function cleanReportInput(b: any): ReportInput {
  if (!b || typeof b !== 'object') throw new HttpError(400, 'JSON body required');
  const source: Source = b.source === undefined ? 'citizen' : b.source;
  if (!SOURCES.includes(source)) throw new HttpError(400, `source must be one of ${SOURCES.join(', ')}`);
  if (typeof b.text !== 'string' || !b.text.trim()) throw new HttpError(400, 'text is required');
  if (b.text.length > 1500) throw new HttpError(400, 'text too long (max 1500 chars)');
  for (const k of ['lat', 'lng', 'peopleCount', 'minutesAgo', 'timestamp'])
    if (b[k] !== undefined && !finite(b[k])) throw new HttpError(400, `${k} must be a number`);
  if (b.reading !== undefined && !(b.reading && finite(b.reading.waterLevelM))) throw new HttpError(400, 'reading.waterLevelM must be a number');
  if ((b.lat === undefined) !== (b.lng === undefined)) throw new HttpError(400, 'lat and lng must be given together');
  return {
    source, text: b.text.trim(), reporterName: typeof b.reporterName === 'string' ? b.reporterName.slice(0, 80) : undefined,
    lat: b.lat, lng: b.lng, settlementId: typeof b.settlementId === 'string' ? b.settlementId : undefined,
    peopleCount: b.peopleCount, minutesAgo: b.minutesAgo, timestamp: b.timestamp, reading: b.reading,
  };
}

async function nextId(key: string, prefix: string, pad: number): Promise<string> {
  const n = (await getKv<number>(key, 0)) + 1;
  await setKv(key, n);
  return `${prefix}${String(n).padStart(pad, '0')}`;
}

async function createReport(input: ReportInput, origin: 'local' | 'remote'): Promise<Report> {
  const store = getStore();
  if (input.settlementId && !(await store.get('settlements', input.settlementId)))
    throw new HttpError(400, `unknown settlementId ${input.settlementId}`);
  const net = await getKv('network', { online: true, changedAt: 0 });
  const now = Date.now();
  const rep: Report = {
    id: await nextId('counter', 'R-', 4),
    source: input.source ?? 'citizen',
    text: input.text!,
    reporterName: input.reporterName,
    lat: input.lat, lng: input.lng,
    settlementId: input.settlementId,
    peopleCount: input.peopleCount,
    reading: input.reading,
    originNode: input.originNode, originId: input.originId,
    timestamp: input.timestamp ?? now - (input.minutesAgo ?? 0) * 60000,
    createdAt: now,
    origin,
    synced: origin === 'remote' ? true : net.online,
  };
  if (rep.source === 'sensor' && rep.reading && rep.settlementId) {
    const s = await store.get<Settlement>('settlements', rep.settlementId);
    // a gauge reading replayed from a peer must not overwrite a newer local one
    if (s && !(origin === 'remote' && rep.timestamp < s.updatedAt)) {
      s.waterLevelM = rep.reading.waterLevelM;
      if (rep.reading.riseRateMPerHr !== undefined) s.riseRateMPerHr = rep.reading.riseRateMPerHr;
      s.updatedAt = now;
      await store.put('settlements', s.id, s);
      emit('terrain.updated', { settlementId: s.id, waterLevelM: s.waterLevelM, riseRateMPerHr: s.riseRateMPerHr });
    }
  }
  await store.put('reports', rep.id, rep);
  emit('report.created', { id: rep.id, source: rep.source, origin, synced: rep.synced, text: rep.text, settlementId: rep.settlementId ?? null });
  return rep;
}

// ---------------------------------------------------------------- reports
export function submitReport(input: ReportInput) {
  return lock.run(async () => {
    if (input.source === 'sensor' && !(input.reading && input.settlementId))
      throw new HttpError(400, 'sensor reports need settlementId and reading.waterLevelM');
    const rep = await createReport(input, 'local');
    const plan = await runPipeline('report:' + rep.id);
    const parsed = (await getStore().get<Report>('reports', rep.id))!;
    return { report: parsed, plan: { id: plan.id, version: plan.version, status: plan.status, mode: plan.mode, diff: plan.diff?.summary ?? [] } };
  });
}

export function sensorReading(settlementId: string, waterLevelM: number, riseRateMPerHr?: number) {
  return submitReport({
    source: 'sensor', settlementId, reading: { waterLevelM, riseRateMPerHr },
    text: `Gauge ${settlementId}: ${waterLevelM} m${riseRateMPerHr !== undefined ? `, rising ${riseRateMPerHr} m/h` : ''}`,
    reporterName: `Gauge ${settlementId}`,
  });
}

// ---------------------------------------------------------------- network + sync
async function syncUnlocked(trigger: string): Promise<SyncResult> {
  const store = getStore();
  const pending = (await store.list<QueueItem>('sync_queue')).filter((q) => q.status === 'pending').sort((a, b) => a.receivedAt - b.receivedAt);
  const unsynced = (await store.list<Report>('reports')).filter((r) => r.origin === 'local' && !r.synced);
  const delivered: string[] = [];
  for (const q of pending) {
    const rep = await createReport(q.payload, 'remote');
    delivered.push(rep.id);
    await store.put('sync_queue', q.id, { ...q, status: 'delivered' });
  }
  for (const r of unsynced) await store.put('reports', r.id, { ...r, synced: true });
  let result: SyncResult = { pulled: delivered.length, pushed: unsynced.length, mergedIntoExisting: 0, conflicts: 0, planId: null, at: Date.now(), trigger };
  if (delivered.length || unsynced.length) {
    const plan = await runPipeline(`sync:${trigger}`);
    const incs = await store.list<Incident>('incidents');
    const touched = incs.filter((i) => i.reportIds.some((id) => delivered.includes(id)));
    result = {
      ...result,
      planId: plan.id,
      mergedIntoExisting: touched.filter((i) => i.reportIds.some((id) => !delivered.includes(id))).length,
      conflicts: touched.filter((i) => i.flags.some((f) => f.type === 'conflict')).length,
    };
  }
  await setKv('lastSync', result);
  emit('sync.completed', result);
  return result;
}

export function setNetwork(online: boolean) {
  return lock.run(async () => {
    const cur = await getKv('network', { online: true, changedAt: 0 });
    if (cur.online === online) return { online, changed: false, sync: null as SyncResult | null };
    await setKv('network', { online, changedAt: Date.now() });
    emit('network.changed', { online, at: Date.now() });
    const sync = online ? await syncUnlocked('reconnect') : null;
    return { online, changed: true, sync };
  });
}

export function syncNow() {
  return lock.run(async () => {
    const net = await getKv('network', { online: true, changedAt: 0 });
    if (!net.online) throw new HttpError(409, 'Node is offline - cannot sync. Switch network online first.');
    return syncUnlocked('manual');
  });
}

/** Reports arriving from other nodes / the cloud. Held in the inbox while offline, merged on reconnect. */
export function queueRemote(inputs: ReportInput[]) {
  return lock.run(async () => {
    const store = getStore();
    for (const input of inputs)
      if (input.settlementId && !(await store.get('settlements', input.settlementId))) throw new HttpError(400, `unknown settlementId ${input.settlementId}`);
    for (const input of inputs) {
      const id = await nextId('qcounter', 'Q-', 4);
      const now = Date.now();
      const item: QueueItem = {
        id, receivedAt: now, status: 'pending',
        payload: { ...input, timestamp: input.timestamp ?? now - (input.minutesAgo ?? 0) * 60000 },
      };
      await store.put('sync_queue', id, item);
    }
    const net = await getKv('network', { online: true, changedAt: 0 });
    if (net.online) {
      const sync = await syncUnlocked('remote-delivery');
      return { queued: inputs.length, delivered: true, sync };
    }
    const pending = (await store.list<QueueItem>('sync_queue')).filter((q) => q.status === 'pending').length;
    emit('sync.queued', { pending });
    return { queued: inputs.length, delivered: false, pending, sync: null as SyncResult | null };
  });
}

export async function syncStatus() {
  const store = getStore();
  const q = await store.list<QueueItem>('sync_queue');
  const reports = await store.list<Report>('reports');
  return {
    online: (await getKv('network', { online: true, changedAt: 0 })).online,
    inboxPending: q.filter((x) => x.status === 'pending').length,
    localUnsynced: reports.filter((r) => r.origin === 'local' && !r.synced).length,
    lastSync: await getKv<SyncResult | null>('lastSync', null),
    mergeConflictsOpen: (await loadConflicts()).filter((c) => c.status === 'needs_human').length,
  };
}

// ---------------------------------------------------------------- plan actions (human in the loop)
async function loadPlan(id: string): Promise<{ plan: Plan; latest: Plan }> {
  const plans = await getStore().list<Plan>('plans');
  const plan = plans.find((p) => p.id === id);
  if (!plan) throw new HttpError(404, `plan ${id} not found`);
  const latest = plans.sort((a, b) => b.version - a.version)[0];
  return { plan, latest };
}

export function approvePlan(id: string, by: string, note?: string) {
  return lock.run(async () => {
    const store = getStore();
    const { plan, latest } = await loadPlan(id);
    if (plan.status !== 'draft' || latest.id !== plan.id)
      throw new HttpError(409, `Only the latest draft can be approved (this plan is ${plan.status}${latest.id !== plan.id ? ', newer plan ' + latest.id + ' exists' : ''}).`);
    for (const p of await store.list<Plan>('plans')) if (p.status === 'approved') await store.put('plans', p.id, { ...p, status: 'superseded' });
    const done: Plan = { ...plan, status: 'approved', approvedBy: by, approvedAt: Date.now(), note };
    await store.put('plans', done.id, done);
    await promoteApproved(done, by);
    emit('plan.approved', { planId: done.id, version: done.version, by, note: note ?? null });
    return done;
  });
}

export function rejectPlan(id: string, by: string, reason?: string) {
  return lock.run(async () => {
    const { plan } = await loadPlan(id);
    if (plan.status !== 'draft') throw new HttpError(409, `Only a draft can be rejected (this plan is ${plan.status}).`);
    const done: Plan = { ...plan, status: 'rejected', approvedBy: by, approvedAt: Date.now(), note: reason };
    await getStore().put('plans', done.id, done);
    emit('plan.rejected', { planId: done.id, by, reason: reason ?? null });
    return done;
  });
}

/** Human overrides which resource handles an incident -> locked, then the plan is recomputed around it. */
export function reassign(planId: string, assignmentId: string, resourceId: string, by: string, note?: string, overrideApproved = false) {
  return lock.run(async () => {
    const store = getStore();
    const { plan, latest } = await loadPlan(planId);
    if (plan.status !== 'draft' || latest.id !== plan.id) throw new HttpError(409, 'Only the latest draft plan can be modified.');
    const a = plan.assignments.find((x) => x.id === assignmentId);
    if (!a) throw new HttpError(404, `assignment ${assignmentId} not found in ${planId}`);
    const res = await store.get<Resource>('resources', resourceId);
    if (!res) throw new HttpError(404, `resource ${resourceId} not found`);
    if (res.status !== 'available') throw new HttpError(422, `${res.name} is ${res.status}`);
    const hold = reservations(await loadClaims(), config.nodeId);
    if (hold.blocked.includes(resourceId)) throw new HttpError(409, `${res.name} is contested by an unresolved split-brain conflict - resolve it first.`);
    const heldFor = (hold.reserved[resourceId] ?? []).filter((x) => x !== a.settlementId);
    if (heldFor.length && !overrideApproved)
      throw new HttpError(409, `${res.name} is already committed (approved) to ${heldFor.join(', ')}. Re-send with overrideApproved:true to knowingly take it - that revokes the earlier approval.`);
    if (heldFor.length) {
      const cl = await loadClaims();
      for (const c of cl) if (c.resourceId === resourceId && c.status === 'approved' && c.settlementId !== a.settlementId) c.status = 'revoked';
      await saveClaims(cl);
      emit('claims.revoked', { resourceId, by, reason: 'human override on reassign' });
    }
    const locks = await getKv<Locks>('locks', {});
    const before = locks[a.incidentId];
    locks[a.incidentId] = { resourceIds: [resourceId], by, at: Date.now(), note: note ?? `Reassigned ${a.resourceId} -> ${resourceId}` };
    await setKv('locks', locks);
    const np = await runPipeline(`manual:${a.incidentId}->${resourceId}`);
    if (!np.assignments.some((x) => x.incidentId === a.incidentId && x.resourceId === resourceId)) {
      if (before) locks[a.incidentId] = before; else delete locks[a.incidentId];
      await setKv('locks', locks);
      await runPipeline('manual-revert');
      throw new HttpError(422, `${res.name} cannot reach ${a.settlementName} (no open ${res.mode} route). Change reverted.`);
    }
    emit('plan.modified', { planId: np.id, incidentId: a.incidentId, resourceId, by });
    return np;
  });
}

export function removeLock(incidentId: string) {
  return lock.run(async () => {
    const locks = await getKv<Locks>('locks', {});
    if (!locks[incidentId]) throw new HttpError(404, 'no manual assignment on that incident');
    delete locks[incidentId];
    await setKv('locks', locks);
    return runPipeline('manual-unlock:' + incidentId);
  });
}

// ---------------------------------------------------------------- terrain / resources / hazard
export function patchSettlement(id: string, b: any) {
  return lock.run(async () => {
    const store = getStore();
    const s = await store.get<Settlement>('settlements', id);
    if (!s) throw new HttpError(404, `settlement ${id} not found`);
    for (const k of ['waterLevelM', 'riseRateMPerHr', 'criticalLevelM'] as const)
      if (b[k] !== undefined) {
        if (!finite(b[k]) || b[k] < 0) throw new HttpError(400, `${k} must be a non-negative number`);
        s[k] = b[k];
      }
    s.updatedAt = Date.now();
    await store.put('settlements', id, s);
    emit('terrain.updated', { settlementId: id, waterLevelM: s.waterLevelM, riseRateMPerHr: s.riseRateMPerHr });
    const plan = await runPipeline('terrain:' + id);
    return { settlement: s, planId: plan.id };
  });
}

export function patchRoute(id: string, b: any) {
  return lock.run(async () => {
    const store = getStore();
    const r = await store.get<Route>('routes', id);
    if (!r) throw new HttpError(404, `route ${id} not found`);
    if (b.status !== undefined) {
      if (!['open', 'blocked', 'flooded'].includes(b.status)) throw new HttpError(400, 'status must be open|blocked|flooded');
      r.status = b.status;
    }
    if (typeof b.note === 'string') r.note = b.note;
    await store.put('routes', id, r);
    emit('route.updated', { routeId: id, status: r.status });
    const plan = await runPipeline('route:' + id);
    return { route: r, planId: plan.id };
  });
}

export function patchResource(id: string, b: any) {
  return lock.run(async () => {
    const store = getStore();
    const r = await store.get<Resource>('resources', id);
    if (!r) throw new HttpError(404, `resource ${id} not found`);
    if (!['available', 'busy', 'offline'].includes(b.status)) throw new HttpError(400, 'status must be available|busy|offline');
    r.status = b.status;
    await store.put('resources', id, r);
    emit('resource.updated', { resourceId: id, status: r.status });
    const plan = await runPipeline('resource:' + id);
    return { resource: r, planId: plan.id };
  });
}

export function setHazard(h: Hazard) {
  return lock.run(async () => {
    await setKv('hazard', h);
    emit('hazard.changed', { hazard: h });
    return runPipeline('hazard:' + h);
  });
}

/** Advance simulated time: every zone's water level moves by its rise rate. */
export function tick(minutes: number) {
  return lock.run(async () => {
    const store = getStore();
    for (const s of await store.list<Settlement>('settlements')) {
      if (s.type === 'base') continue;
      s.waterLevelM = round(Math.max(0, s.waterLevelM + (s.riseRateMPerHr * minutes) / 60), 2);
      s.updatedAt = Date.now();
      await store.put('settlements', s.id, s);
    }
    emit('terrain.updated', { tickMinutes: minutes });
    return runPipeline(`simulate:+${minutes}min`);
  });
}

export function resetScenario() {
  return lock.run(async () => {
    await seedScenario();
    const plan = await runPipeline('scenario-reset', { useLlm: false });
    emit('scenario.reset', { planId: plan.id });
    return plan;
  });
}

// ---------------------------------------------------------------- read models
export async function getState() {
  const store = getStore();
  const [settlements, routes, resources, reports, incidents, plans] = await Promise.all([
    store.list<Settlement>('settlements'),
    store.list<Route>('routes'),
    store.list<Resource>('resources'),
    store.list<Report>('reports'),
    store.list<Incident>('incidents'),
    store.list<Plan>('plans'),
  ]);
  plans.sort((a, b) => b.version - a.version);
  incidents.sort((a, b) => (a.priority?.rank ?? 999) - (b.priority?.rank ?? 999));
  return {
    network: await getKv('network', { online: true, changedAt: 0 }),
    hazard: await getKv<Hazard>('hazard', 'flood'),
    settlements, routes, resources,
    reports: reports.sort((a, b) => b.timestamp - a.timestamp),
    incidents,
    plan: plans[0] ?? null,
    approvedPlanId: plans.find((p) => p.status === 'approved')?.id ?? null,
    locks: await getKv<Locks>('locks', {}),
    node: config.nodeId,
    claims: await loadClaims(),
    mergeConflicts: await loadConflicts(),
    sync: await syncStatus(),
  };
}

// ---------------------------------------------------------------- peer (laptop <-> laptop) merge after a split brain
export async function peerSnapshot(): Promise<PeerSnapshot> {
  const reports = (await getStore().list<Report>('reports')).filter((r) => r.origin === 'local' && r.source !== 'sensor');
  return { nodeId: config.nodeId, at: Date.now(), claims: await loadClaims(), reports };
}

/**
 * Merge another coordinator node's state. Safe to repeat (idempotent) and order-independent.
 * Never edits an approved decision: approved plans stay as they are; clashes become conflicts for a human.
 */
export function mergePeer(snap: PeerSnapshot): Promise<PeerMergeResult> {
  return lock.run(async () => {
    if (!snap || typeof snap.nodeId !== 'string' || !Array.isArray(snap.claims) || !Array.isArray(snap.reports)) throw new HttpError(400, 'body must be a peer snapshot {nodeId, claims[], reports[]}');
    if (snap.nodeId === config.nodeId) throw new HttpError(400, `snapshot is from this node (${config.nodeId}) - give the two laptops different NODE_ID values`);
    const store = getStore();
    const have = new Set((await store.list<Report>('reports')).filter((r) => r.originNode).map((r) => `${r.originNode}#${r.originId}`));
    let pulled = 0, skipped = 0;
    for (const r of snap.reports.sort((a, b) => a.timestamp - b.timestamp)) {
      if (have.has(`${snap.nodeId}#${r.id}`)) { skipped++; continue; }
      const clean = cleanReportInput({ source: r.source, text: r.text, reporterName: r.reporterName, lat: r.lat, lng: r.lng, settlementId: r.settlementId, peopleCount: r.peopleCount, timestamp: r.timestamp, reading: r.reading });
      if (clean.settlementId && !(await store.get('settlements', clean.settlementId))) { skipped++; continue; }
      await createReport({ ...clean, originNode: snap.nodeId, originId: r.id }, 'remote');
      pulled++;
    }
    // each node is authoritative for its OWN proposals: ignore stale copies of ours, replace the peer's old ones
    const incoming = snap.claims.filter((c) => !(c.nodeId === config.nodeId && c.status === 'proposed'));
    const ours = (await loadClaims()).filter((c) => !(c.nodeId === snap.nodeId && c.status !== 'approved' && c.status !== 'revoked'));
    const { claims, conflicts } = reconcile(ours, incoming, await loadConflicts());
    await saveClaims(claims);
    await saveConflicts(conflicts);
    const plan = await runPipeline(`peer-merge:${snap.nodeId}`);
    const needsHuman = conflicts.filter((c) => c.status === 'needs_human').length;
    emit('peer.merged', { peer: snap.nodeId, pulled, skipped, conflicts: conflicts.length, needsHuman, planId: plan.id });
    return { peer: snap.nodeId, reportsPulled: pulled, reportsSkipped: skipped, claimsReceived: snap.claims.length, conflicts, needsHuman, planId: plan.id, approvedAssignmentsChanged: 0 as const };
  });
}

/** Convenience for the demo: pull the peer's snapshot over HTTP, merge it, and push ours back so both converge. */
export async function syncWithPeer(peerUrl: string) {
  const base = peerUrl.replace(/\/+$/, '');
  const got = await fetch(`${base}/api/peer/snapshot`).catch((e) => { throw new HttpError(502, `cannot reach peer at ${base}: ${e.message}`); });
  if (!got.ok) throw new HttpError(502, `peer answered ${got.status}`);
  const merged = await mergePeer((await got.json()) as PeerSnapshot);
  const pushed = await fetch(`${base}/api/peer/merge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await peerSnapshot()) }).catch(() => null);
  return { merged, peerAlsoMerged: !!pushed?.ok };
}

/** A human picks which approved claim stands. The other is revoked; a NEW draft is produced for approval (no silent edit). */
export function resolveConflict(id: string, keepClaimId: string, by: string, note?: string) {
  return lock.run(async () => {
    const conflicts = await loadConflicts();
    const c = conflicts.find((x) => x.id === id);
    if (!c) throw new HttpError(404, `conflict ${id} not found`);
    if (c.status !== 'needs_human') throw new HttpError(409, `conflict is already ${c.status}`);
    if (!c.claimIds.includes(keepClaimId)) throw new HttpError(400, `keepClaimId must be one of ${c.claimIds.join(', ')}`);
    const claims = await loadClaims();
    for (const x of claims) if (c.claimIds.includes(x.id)) { if (x.id === keepClaimId) x.contested = false; else { x.status = 'revoked'; x.contested = false; } }
    await saveClaims(claims);
    Object.assign(c, { status: 'resolved_by_human', keptClaimId: keepClaimId, resolvedBy: by, resolvedAt: Date.now(), note });
    const re = reconcile(await loadClaims(), [], conflicts);
    await saveClaims(re.claims);
    await saveConflicts(re.conflicts);
    emit('conflict.resolved', { id, keepClaimId, by });
    const plan = await runPipeline('conflict-resolved:' + id);
    return { conflict: c, planId: plan.id, message: 'Review and approve the new draft plan; the revoked crew must be re-tasked.' };
  });
}
