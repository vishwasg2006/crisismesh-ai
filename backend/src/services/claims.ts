import { config } from '../config';
import { emit } from '../bus';
import { getKv, setKv } from '../db/store';
import { reservations } from '../agents/merge';
import { Claim, MergeConflict, Plan } from '../types';

export const loadClaims = () => getKv<Claim[]>('claims', []);
export const saveClaims = (c: Claim[]) => setKv('claims', c);
export const loadConflicts = () => getKv<MergeConflict[]>('conflicts', []);
export const saveConflicts = (c: MergeConflict[]) => setKv('conflicts', c);

export async function currentHold() {
  return reservations(await loadClaims(), config.nodeId);
}

/** Every new draft publishes this node's *proposed* claims. Approved claims are never touched here. */
export async function refreshProposals(plan: Plan): Promise<void> {
  const claims = await loadClaims();
  const kept = claims.filter((c) => !(c.nodeId === config.nodeId && c.status === 'proposed'));
  const score = new Map(plan.priorities.map((p) => [p.incidentId, p.score]));
  for (const a of plan.assignments) {
    if (kept.some((c) => c.nodeId === config.nodeId && c.status === 'approved' && c.resourceId === a.resourceId && c.settlementId === a.settlementId)) continue;
    kept.push({
      id: `${config.nodeId}:${plan.id}:${a.resourceId}:${a.settlementId}`,
      nodeId: config.nodeId, planId: plan.id, resourceId: a.resourceId, settlementId: a.settlementId, settlementName: a.settlementName,
      incidentId: a.incidentId, people: a.peopleServed, priorityScore: score.get(a.incidentId) ?? 0,
      startAt: plan.createdAt + a.startMin * 60000, endAt: plan.createdAt + a.finishMin * 60000, status: 'proposed',
    });
  }
  await saveClaims(kept);
}

/** A human approved this plan: its assignments become binding claims (seniority of unchanged ones is kept). */
export async function promoteApproved(plan: Plan, by: string): Promise<Claim[]> {
  const claims = await loadClaims();
  const mine = claims.filter((c) => c.nodeId === config.nodeId && c.status === 'approved');
  const others = claims.filter((c) => !(c.nodeId === config.nodeId && (c.status === 'proposed' || c.status === 'approved')));
  const score = new Map(plan.priorities.map((p) => [p.incidentId, p.score]));
  const now = Date.now();
  const next: Claim[] = plan.assignments.map((a) => {
    const old = mine.find((c) => c.resourceId === a.resourceId && c.settlementId === a.settlementId);
    return {
      id: old?.id ?? `${config.nodeId}:${plan.id}:${a.resourceId}:${a.settlementId}`,
      nodeId: config.nodeId, planId: old?.planId ?? plan.id, resourceId: a.resourceId, settlementId: a.settlementId, settlementName: a.settlementName,
      incidentId: a.incidentId, people: a.peopleServed, priorityScore: score.get(a.incidentId) ?? 0,
      startAt: plan.createdAt + a.startMin * 60000, endAt: plan.createdAt + a.finishMin * 60000,
      status: 'approved', approvedBy: old?.approvedBy ?? by, approvedAt: old?.approvedAt ?? now, contested: old?.contested,
    };
  });
  await saveClaims([...others, ...next]);
  emit('claims.approved', { planId: plan.id, resources: next.map((c) => c.resourceId) });
  return next;
}
