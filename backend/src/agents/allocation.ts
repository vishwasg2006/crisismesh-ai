import { Assignment, Incident, Priority, Resource, Terrain, TraceEntry, Unassigned } from '../types';
import { round } from '../util';

const MAX_TRIPS = 2; // trips one resource commits to per incident
const LOAD_MIN = 5; // loading/unloading time per trip

export type Locks = Record<string, { resourceIds: string[]; by: string; at: number; note?: string }>;

interface RState {
  r: Resource;
  availAt: number;
}

/**
 * Resource Allocation agent (constraint-aware greedy scheduler):
 *  - walks incidents in priority order
 *  - boats only use open water routes, teams only open roads
 *  - capacity, multi-trip round trips and each resource's busy-until time are respected
 *  - prefers feasible arrival (before the zone turns critical), then earliest arrival, then best capacity fit
 *  - human locks (manual reassignments) are honoured first
 */
export function allocate(
  incidents: Incident[],
  priorities: Priority[],
  terrain: Record<string, Terrain>,
  resources: Resource[],
  locks: Locks,
  hold: { reserved: Record<string, string[]>; blocked: string[] } = { reserved: {}, blocked: [] },
): { assignments: Assignment[]; unassigned: Unassigned[]; trace: TraceEntry } {
  const t0 = Date.now();
  const states: RState[] = resources.filter((r) => r.status === 'available' && !hold.blocked.includes(r.id)).map((r) => ({ r, availAt: 0 }));
  const iMap = new Map(incidents.map((i) => [i.id, i]));
  const assignments: Assignment[] = [];
  const unassigned: Unassigned[] = [];
  const details: string[] = [];
  let seq = 0;

  for (const p of priorities) {
    const inc = iMap.get(p.incidentId)!;
    const tr = terrain[inc.settlementId];
    let remaining = inc.people;
    const used = new Set<string>();
    const lockIds = locks[inc.id]?.resourceIds ?? [];
    let guard = 0;
    while (remaining > 0 && guard++ < 3) {
      const cands = states
        .filter((s) => !used.has(s.r.id))
        // boats promised (approved / peer-won) to another job stay there unless a human explicitly locks them here
        .filter((s) => !(hold.reserved[s.r.id]?.length) || hold.reserved[s.r.id].includes(inc.settlementId) || lockIds.includes(s.r.id))
        .map((s) => {
          const path = s.r.mode === 'water' ? tr.boat : tr.road;
          if (!path.reachable || path.minutes === null) return null;
          const eta = path.minutes / s.r.speedFactor;
          const trips = Math.min(MAX_TRIPS, Math.ceil(remaining / s.r.capacity));
          const served = Math.min(remaining, trips * s.r.capacity);
          const start = s.availAt;
          const arrival = start + eta;
          const finish = start + eta + (trips - 1) * (2 * eta + LOAD_MIN) + LOAD_MIN + eta;
          const medical = (inc.needs.includes('medical') || inc.vulnerable) && s.r.skills.includes('medical') ? 8 : 0;
          const feasible = p.timeLeftMin === null || arrival <= p.timeLeftMin;
          const fit = Math.abs(s.r.capacity - remaining) * 0.3;
          return { s, path, eta, trips, served, start, arrival, finish, feasible, cost: arrival + fit - medical };
        })
        .filter((c): c is NonNullable<typeof c> => c !== null);
      if (!cands.length) break;
      const held = Object.keys(hold.reserved).find((id) => hold.reserved[id].includes(inc.settlementId) && !used.has(id) && cands.some((c) => c.s.r.id === id));
      const forced = lockIds.find((id) => !used.has(id) && cands.some((c) => c.s.r.id === id)) ?? held;
      let pick = forced ? cands.find((c) => c.s.r.id === forced)! : undefined;
      if (!pick) {
        const feas = cands.filter((c) => c.feasible);
        pick = (feas.length ? feas : cands).sort((a, b) => a.cost - b.cost)[0];
      }
      const r = pick.s.r;
      const warnings: string[] = [];
      if (!pick.feasible) warnings.push(`Arrives in ~${round(pick.arrival, 0)} min, after the zone is expected to reach critical level (~${p.timeLeftMin} min).`);
      if (inc.independentSources <= 1 && inc.reportIds.length > 1)
        warnings.push(`${inc.reportIds.length} reports but only ${inc.independentSources} independent source - verify before committing a boat.`);
      const a: Assignment = {
        id: `A-${++seq}`,
        incidentId: inc.id,
        settlementId: inc.settlementId,
        settlementName: inc.settlementName,
        resourceId: r.id,
        resourceName: r.name,
        mode: r.mode,
        peopleServed: pick.served,
        trips: pick.trips,
        etaMin: round(pick.eta, 1),
        startMin: round(pick.start, 1),
        finishMin: round(pick.finish, 1),
        route: (r.mode === 'water' ? tr.boat : tr.road).path,
        atRisk: !pick.feasible,
        locked: forced === r.id && lockIds.includes(r.id),
        reason:
          `${r.name} (cap ${r.capacity}) is ${round(pick.eta, 0)} min from ${inc.settlementName} via ${(r.mode === 'water' ? tr.boat : tr.road).path.join('>')}; ` +
          `${pick.trips} trip(s) move ${pick.served} of ${inc.people} people. ` +
          (forced === r.id && lockIds.includes(r.id) ? 'Manually assigned by a human coordinator. ' : forced === r.id ? 'Held: this assignment was already approved and is protected from automatic change. ' : '') +
          (pick.start > 0 ? `Available from T+${round(pick.start, 0)} after its previous task. ` : ''),
        warnings,
      };
      assignments.push(a);
      pick.s.availAt = pick.finish;
      used.add(r.id);
      remaining -= pick.served;
      details.push(`${inc.id} ${inc.settlementName}: ${r.id} x${pick.trips} trip(s), arrive T+${a.etaMin + a.startMin}, done T+${a.finishMin}${a.atRisk ? ' [AT RISK]' : ''}`);
    }
    if (remaining > 0) {
      const covered = inc.people - remaining;
      let reason: string;
      if (covered > 0) reason = `Capacity exhausted: ${covered} of ${inc.people} covered, ${remaining} still waiting for a free boat/team.`;
      else if (!tr.boat.reachable && !tr.road.reachable)
        reason = 'No open boat or road route. Clear a route or request air support.';
      else reason = 'No available resource can reach this location (all committed or wrong type).';
      unassigned.push({ incidentId: inc.id, settlementId: inc.settlementId, settlementName: inc.settlementName, peopleRemaining: remaining, reason });
      details.push(`${inc.id} ${inc.settlementName}: UNASSIGNED ${remaining} - ${reason}`);
    }
  }
  return {
    assignments,
    unassigned,
    trace: {
      agent: 'Resource Allocation',
      ms: Date.now() - t0,
      summary: `${assignments.length} assignments using ${new Set(assignments.map((a) => a.resourceId)).size}/${states.length} resources; ${unassigned.length} incident(s) not fully covered`,
      details,
    },
  };
}
