import { Hazard, Incident, Priority, Settlement, Terrain, TraceEntry } from '../types';
import { clamp, round } from '../util';
import { PROFILES } from '../profiles';

/**
 * Prioritization agent - fully transparent scoring (0-100):
 *   danger  : water vs critical level, rise rate, reported urgency
 *   people  : head-count (+ vulnerable boost)
 *   access  : cut-off risk (road cut => only boats, act early)
 *   time    : how soon the zone hits critical level
 * Final score is scaled by report confidence and reduced for stale incidents.
 */
export function prioritize(
  incidents: Incident[],
  terrain: Record<string, Terrain>,
  settlements: Settlement[],
  hazard: Hazard,
): { priorities: Priority[]; trace: TraceEntry } {
  const t0 = Date.now();
  const w = PROFILES[hazard].weights;
  const sMap = new Map(settlements.map((s) => [s.id, s]));
  const out: Priority[] = [];
  for (const inc of incidents) {
    const tr = terrain[inc.settlementId];
    const s = sMap.get(inc.settlementId)!;
    const rate = clamp(s.riseRateMPerHr / 0.6);
    const danger = 100 * (0.5 * clamp(tr.ratio) + 0.3 * rate + 0.2 * inc.urgency);
    const people = Math.min(100, clamp(inc.people / 30) * 100 + (inc.vulnerable ? 15 : 0));
    let access = 35;
    let accessReason = 'road route open';
    if (!tr.boat.reachable && !tr.road.reachable) {
      access = 0;
      accessReason = 'no open route - cannot be reached yet';
    } else if (tr.roadCut) {
      access = 100;
      accessReason = 'road cut, boat-only access';
    } else if ((tr.road.minutes ?? 0) > 30) {
      access = 60;
      accessReason = 'long road route';
    }
    const timeLeft = tr.timeToCriticalMin;
    const time = 100 * (1 - clamp((timeLeft ?? 240) / 240));
    const stale = inc.flags.some((f) => f.type === 'stale');
    const cf = (0.7 + 0.3 * inc.confidence) * (stale ? 0.75 : 1);
    const raw = danger * w.danger + people * w.people + access * w.access + time * w.time;
    const score = round(raw * cf, 1);
    const comp = (v: number, wt: number, reason: string) => ({ score: round(v, 0), weight: wt, reason });
    const components = {
      danger: comp(danger, w.danger, `water ${Math.round(tr.ratio * 100)}% of critical, rising ${s.riseRateMPerHr} m/h, urgency ${inc.urgency.toFixed(2)}`),
      people: comp(people, w.people, `${inc.people} people${inc.vulnerable ? ' incl. vulnerable (children/elderly/sick)' : ''}`),
      access: comp(access, w.access, accessReason),
      time: comp(time, w.time, timeLeft === null ? 'water not rising' : `critical level in ~${timeLeft} min`),
    };
    out.push({
      incidentId: inc.id, score, rank: 0, components, confidenceFactor: round(cf, 2), timeLeftMin: timeLeft,
      explanation:
        `Score ${score}: danger ${components.danger.score}, people ${components.people.score}, access ${components.access.score}, time ${components.time.score} ` +
        `(x${round(cf, 2)} confidence${stale ? ', stale penalty' : ''}).`,
    });
  }
  const pMap = new Map(incidents.map((i) => [i.id, i]));
  out.sort((a, b) => b.score - a.score || pMap.get(b.incidentId)!.people - pMap.get(a.incidentId)!.people);
  out.forEach((p, i) => (p.rank = i + 1));
  return {
    priorities: out,
    trace: {
      agent: 'Prioritization',
      ms: Date.now() - t0,
      summary: out.length ? `Ranked ${out.length} incidents; top: ${pMap.get(out[0].incidentId)!.settlementName} (${out[0].score})` : 'No active incidents',
      details: out.map((p) => `#${p.rank} ${pMap.get(p.incidentId)!.summary} -> ${p.explanation}`),
    },
  };
}
