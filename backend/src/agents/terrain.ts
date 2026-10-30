import { Mode, PathInfo, Route, Settlement, Terrain, TraceEntry } from '../types';
import { clamp, round } from '../util';

/** Dijkstra from `from` over routes of one mode that are open. Minutes at speedFactor 1. */
function shortest(nodes: string[], routes: Route[], mode: Mode, from: string): Map<string, { min: number; path: string[] }> {
  const dist = new Map<string, number>(nodes.map((n) => [n, Infinity]));
  const prev = new Map<string, string>();
  dist.set(from, 0);
  const todo = new Set(nodes);
  const edges = routes.filter((r) => r.mode === mode && r.status === 'open');
  while (todo.size) {
    let u: string | null = null;
    for (const n of todo) if (u === null || dist.get(n)! < dist.get(u)!) u = n;
    if (u === null || dist.get(u) === Infinity) break;
    todo.delete(u);
    for (const e of edges) {
      const v = e.a === u ? e.b : e.b === u ? e.a : null;
      if (v === null || !todo.has(v)) continue;
      const d = dist.get(u)! + e.minutes;
      if (d < dist.get(v)!) {
        dist.set(v, d);
        prev.set(v, u);
      }
    }
  }
  const out = new Map<string, { min: number; path: string[] }>();
  for (const n of nodes) {
    if (dist.get(n) === Infinity) continue;
    const path = [n];
    while (prev.has(path[0])) path.unshift(prev.get(path[0])!);
    out.set(n, { min: dist.get(n)!, path });
  }
  return out;
}

const info = (m: Map<string, { min: number; path: string[] }>, id: string): PathInfo => {
  const x = m.get(id);
  return x ? { reachable: true, minutes: round(x.min, 1), path: x.path } : { reachable: false, minutes: null, path: [] };
};

/** Terrain agent: flood stage per settlement + boat/road reachability from the rescue base. */
export function analyseTerrain(
  settlements: Settlement[],
  routes: Route[],
): { terrain: Record<string, Terrain>; trace: TraceEntry } {
  const t0 = Date.now();
  const nodes = settlements.map((s) => s.id);
  const water = shortest(nodes, routes, 'water', 'BASE');
  const road = shortest(nodes, routes, 'road', 'BASE');
  const terrain: Record<string, Terrain> = {};
  const details: string[] = [];
  for (const s of settlements) {
    if (s.type === 'base') continue;
    const ratio = s.criticalLevelM > 0 ? s.waterLevelM / s.criticalLevelM : 0;
    const stage = ratio >= 1 ? 'severe' : ratio >= 0.7 ? 'critical' : ratio >= 0.4 ? 'warning' : 'watch';
    const ttc =
      s.waterLevelM >= s.criticalLevelM ? 0 : s.riseRateMPerHr > 0 ? round(((s.criticalLevelM - s.waterLevelM) / s.riseRateMPerHr) * 60, 0) : null;
    const boat = info(water, s.id);
    const rd = info(road, s.id);
    const touching = routes.filter((r) => (r.a === s.id || r.b === s.id) && r.status !== 'open');
    const roadCut = !rd.reachable && routes.some((r) => r.mode === 'road' && (r.a === s.id || r.b === s.id));
    const notes = touching.map((r) => `${r.id} (${r.mode}) ${r.status}${r.note ? ': ' + r.note : ''}`);
    terrain[s.id] = {
      settlementId: s.id, name: s.name, stage, ratio: round(ratio, 2), timeToCriticalMin: ttc,
      boat, road: rd, roadCut, notes,
    };
    details.push(
      `${s.name}: ${stage} (${round(s.waterLevelM, 2)}/${s.criticalLevelM} m, +${s.riseRateMPerHr} m/h, critical in ${ttc ?? 'n/a'} min); boat ${boat.reachable ? boat.minutes + ' min' : 'NO'}; road ${rd.reachable ? rd.minutes + ' min' : 'NO'}`,
    );
  }
  const blocked = routes.filter((r) => r.status !== 'open').length;
  return {
    terrain,
    trace: {
      agent: 'Terrain',
      ms: Date.now() - t0,
      summary: `${Object.keys(terrain).length} zones assessed; ${blocked}/${routes.length} routes blocked or flooded; ${Object.values(terrain).filter((t) => t.roadCut).length} zones cut off by road`,
      details,
    },
  };
}

export { clamp };
