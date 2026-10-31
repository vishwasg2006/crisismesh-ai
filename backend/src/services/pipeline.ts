import { config } from '../config';
import { emit } from '../bus';
import { getKv, getStore } from '../db/store';
import { analyse } from '../agents/analysis';
import { verify } from '../agents/verification';
import { analyseTerrain } from '../agents/terrain';
import { prioritize } from '../agents/prioritization';
import { allocate, Locks } from '../agents/allocation';
import { planResponse } from '../agents/planning';
import { diffPlans } from '../agents/diff';
import { llmAvailable } from '../agents/llm';
import { Hazard, Incident, Plan, Report, Resource, Route, Settlement } from '../types';
import { Mutex } from '../util';
import { currentHold, loadConflicts, refreshProposals } from './claims';

/** All writes + pipeline runs go through this lock so they never interleave. */
export const lock = new Mutex();

/**
 * Runs the 6-agent pipeline over everything we know and stores a new DRAFT plan.
 * Must be called inside `lock.run(...)`.
 */
export async function runPipeline(trigger: string, opts: { useLlm?: boolean } = {}): Promise<Plan> {
  const store = getStore();
  const useLlm = opts.useLlm !== false;
  const [settlements, routes, resources, reportsRaw, plans] = await Promise.all([
    store.list<Settlement>('settlements'),
    store.list<Route>('routes'),
    store.list<Resource>('resources'),
    store.list<Report>('reports'),
    store.list<Plan>('plans'),
  ]);
  const hazard = await getKv<Hazard>('hazard', 'flood');
  const net = await getKv('network', { online: true, changedAt: 0 });
  const locks = await getKv<Locks>('locks', {});
  const trace = [];

  // 1. Incident Analysis
  const an = await analyse(reportsRaw, settlements, hazard, useLlm);
  for (const r of an.changed) await store.put('reports', r.id, r);
  trace.push(an.trace);

  // 2. Verification
  const ver = verify(an.reports, settlements, Date.now(), config.staleMin);
  trace.push(ver.trace);

  // 3. Terrain
  const ter = analyseTerrain(settlements, routes);
  trace.push(ter.trace);

  // 4. Prioritization (active incidents only)
  const active = ver.incidents.filter((i) => i.status === 'active');
  const pri = prioritize(active, ter.terrain, settlements, hazard);
  trace.push(pri.trace);
  const pMap = new Map(pri.priorities.map((p) => [p.incidentId, p]));
  for (const i of ver.incidents) {
    i.terrain = ter.terrain[i.settlementId];
    i.priority = pMap.get(i.id);
  }

  // 5. Allocation
  const hold = await currentHold();
  const alloc = allocate(active, pri.priorities, ter.terrain, resources, locks, hold);
  trace.push(alloc.trace);

  // 6. Response planning
  const mode = net.online ? 'online' : 'offline';
  const pl = await planResponse(
    ver.incidents, pri.priorities, alloc.assignments, alloc.unassigned, resources.length, ver.unplaced, mode, useLlm && (await llmAvailable()),
  );
  trace.push(pl.trace);
  for (const c of (await loadConflicts()).filter((x) => x.status === 'needs_human'))
    pl.warnings.unshift(`SPLIT-BRAIN: ${c.message} ${c.resourceId} is excluded from new plans until resolved.`);
  for (const [rid, sids] of Object.entries(hold.reserved))
    if (!hold.blocked.includes(rid) && active.some((i) => sids.includes(i.settlementId)) && !alloc.assignments.some((a) => a.resourceId === rid)) pl.warnings.push(`${rid} holds an approved/peer-won commitment for ${sids.join(', ')} that this plan could not keep (route or resource changed) - human review needed.`);

  // persist incidents
  await store.clear('incidents');
  for (const i of ver.incidents) await store.put('incidents', i.id, i);

  // build + store plan
  const version = plans.reduce((m, p) => Math.max(m, p.version), 0) + 1;
  const baseline =
    plans.filter((p) => p.status === 'approved').sort((a, b) => b.version - a.version)[0] ??
    plans.sort((a, b) => b.version - a.version)[0] ??
    null;
  const plan: Plan = {
    id: `PLAN-${String(version).padStart(3, '0')}`,
    version,
    status: 'draft',
    mode,
    hazard,
    trigger,
    createdAt: Date.now(),
    assignments: alloc.assignments,
    unassigned: alloc.unassigned,
    priorities: pri.priorities,
    trace,
    summary: pl.summary,
    narrative: pl.narrative,
    warnings: pl.warnings,
    diff: null,
    modifications: Object.entries(locks).map(([incidentId, l]) => ({
      at: l.at, by: l.by, incidentId, resourceIds: l.resourceIds, note: l.note ?? 'Manual assignment',
    })),
  };
  plan.diff = diffPlans(baseline, plan, ver.incidents);
  for (const p of plans) if (p.status === 'draft') await store.put('plans', p.id, { ...p, status: 'superseded' });
  await store.put('plans', plan.id, plan);
  await refreshProposals(plan);

  emit('plan.updated', {
    planId: plan.id, version, status: plan.status, mode, trigger,
    summary: plan.summary, diff: plan.diff?.summary ?? [],
  });
  return plan;
}
