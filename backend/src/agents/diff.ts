import { Assignment, DiffItem, Incident, Plan, PlanDiff } from '../types';

const byInc = (as: Assignment[]) => {
  const m = new Map<string, Assignment[]>();
  for (const a of as) m.set(a.incidentId, [...(m.get(a.incidentId) ?? []), a]);
  return m;
};

/** Compare a new plan with a baseline (last approved plan, else previous plan). */
export function diffPlans(prev: Plan | null, next: Plan, incidents: Incident[]): PlanDiff | null {
  if (!prev) return null;
  const name = new Map(incidents.map((i) => [i.id, i.settlementName]));
  prev.assignments.forEach((a) => name.set(a.incidentId, a.settlementName));
  const items: DiffItem[] = [];
  const P = byInc(prev.assignments), N = byInc(next.assignments);
  const prevRank = new Map(prev.priorities.map((p) => [p.incidentId, p.rank]));
  const nextIds = new Set(next.priorities.map((p) => p.incidentId));
  const prevIds = new Set(prev.priorities.map((p) => p.incidentId));
  const nm = (id: string) => name.get(id) ?? id;

  for (const [id, as] of N) {
    const old = P.get(id);
    const ids = as.map((a) => a.resourceId).join('+');
    if (!old) {
      items.push({
        type: 'added', incidentId: id, settlementName: nm(id),
        detail: prevIds.has(id) ? `Now covered by ${ids}` : `NEW incident covered by ${ids} (${as.reduce((s, a) => s + a.peopleServed, 0)} people)`,
      });
      continue;
    }
    const oldIds = old.map((a) => a.resourceId).join('+');
    const people = (x: Assignment[]) => x.reduce((s, a) => s + a.peopleServed, 0);
    if (oldIds !== ids || people(old) !== people(as) || Math.abs(old[0].etaMin - as[0].etaMin) > 3)
      items.push({
        type: 'changed', incidentId: id, settlementName: nm(id),
        detail: `${oldIds} (${people(old)} ppl, ETA ${old[0].etaMin}m) -> ${ids} (${people(as)} ppl, ETA ${as[0].etaMin}m)`,
      });
  }
  for (const [id] of P)
    if (!N.has(id))
      items.push({
        type: 'removed', incidentId: id, settlementName: nm(id),
        detail: nextIds.has(id) ? 'No longer covered (resources reallocated to higher priority)' : 'Incident no longer active (resolved/merged)',
      });
  for (const p of next.priorities) {
    const old = prevRank.get(p.incidentId);
    if (old !== undefined && Math.abs(old - p.rank) >= 2)
      items.push({ type: 'priority', incidentId: p.incidentId, settlementName: nm(p.incidentId), detail: `Priority rank #${old} -> #${p.rank}` });
  }
  const prevUn = new Set(prev.unassigned.map((u) => u.incidentId));
  for (const u of next.unassigned)
    if (!prevUn.has(u.incidentId))
      items.push({ type: 'unassigned', incidentId: u.incidentId, settlementName: u.settlementName, detail: `${u.peopleRemaining} people uncovered: ${u.reason}` });

  const count = (t: DiffItem['type']) => items.filter((i) => i.type === t).length;
  const summary = [
    `vs plan v${prev.version} (${prev.status}): ${count('added')} added, ${count('changed')} changed, ${count('removed')} removed, ${count('priority')} priority shifts, ${count('unassigned')} newly uncovered`,
  ];
  return { against: prev.id, againstVersion: prev.version, items, summary };
}
