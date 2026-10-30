import { Flag, Incident, Report, Settlement, Source, TraceEntry } from '../types';
import { clamp, haversine, round, uniq } from '../util';
import { copyReason, echoGroups } from './independence';

const SRC_CONF: Record<Source, number> = { sensor: 0.9, field: 0.8, volunteer: 0.6, citizen: 0.5 };
const MERGE_RADIUS_M = 250;

class UF {
  p: number[];
  constructor(n: number) {
    this.p = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.p[x] !== x) x = this.p[x] = this.p[this.p[x]];
    return x;
  }
  union(a: number, b: number) {
    this.p[this.find(a)] = this.find(b);
  }
}

/** Verification agent: merge duplicates, flag conflicts / stale data, score confidence. */
export function verify(
  reports: Report[],
  settlements: Settlement[],
  now: number,
  staleMin: number,
): { incidents: Incident[]; unplaced: string[]; trace: TraceEntry } {
  const t0 = Date.now();
  const sMap = new Map(settlements.map((s) => [s.id, s]));
  const usable = reports.filter((r) => r.source !== 'sensor' && r.parsed);
  const placed = usable.filter((r) => r.parsed!.settlementId && sMap.has(r.parsed!.settlementId!));
  const unplaced = usable.filter((r) => !placed.includes(r)).map((r) => r.id);

  const located = placed.filter((r) => r.lat !== undefined && r.lng !== undefined);
  const coordless = placed.filter((r) => !located.includes(r));
  const idx = new Map(located.map((r, i) => [r.id, i]));
  const uf = new UF(located.length);
  for (let i = 0; i < located.length; i++)
    for (let j = i + 1; j < located.length; j++) {
      const a = located[i], b = located[j];
      if (a.parsed!.settlementId !== b.parsed!.settlementId) continue;
      // copies of the same message are one voice even if their pins are scattered: never let them spawn extra incidents
      if (haversine(a.lat!, a.lng!, b.lat!, b.lng!) <= MERGE_RADIUS_M || copyReason(a, b)) uf.union(i, j);
    }
  const clusters = new Map<string, Report[]>();
  for (const r of located) {
    const key = `${r.parsed!.settlementId}#${uf.find(idx.get(r.id)!)}`;
    clusters.set(key, [...(clusters.get(key) ?? []), r]);
  }
  // coordinate-less reports attach to the best matching cluster in the same settlement (never bridge two clusters)
  for (const r of coordless.sort((a, b) => a.timestamp - b.timestamp)) {
    const sid = r.parsed!.settlementId!;
    const cands = [...clusters.entries()].filter(([k]) => k.startsWith(sid + '#'));
    let pick: string | undefined;
    pick = cands.find(([, rs]) => rs.some((x) => copyReason(x, r)))?.[0];
    if (!pick && r.parsed!.landmark) pick = cands.find(([, rs]) => rs.some((x) => x.parsed!.landmark === r.parsed!.landmark))?.[0];
    if (!pick && !r.parsed!.landmark && cands.length)
      pick = cands.sort((a, b) => Math.max(...b[1].map((x) => x.timestamp)) - Math.max(...a[1].map((x) => x.timestamp)))[0][0];
    const key = pick ?? `${sid}#nc-${r.id}`;
    clusters.set(key, [...(clusters.get(key) ?? []), r]);
  }

  const incidents: Incident[] = [];
  const details: string[] = [];
  for (const rs of clusters.values()) {
    rs.sort((a, b) => a.timestamp - b.timestamp);
    const s = sMap.get(rs[0].parsed!.settlementId!)!;
    const flags: Flag[] = [];
    // Independence: reports that are copies / the same person are ONE voice. Count voices, not reports.
    const groups = echoGroups(rs);
    const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a[Math.floor((a.length - 1) / 2)]; };
    const counts = groups
      .map((g) => ({ ns: g.reports.filter((r) => r.parsed!.people !== null).map((r) => r.parsed!.people!), w: Math.max(...g.reports.map((r) => SRC_CONF[r.source])) }))
      .filter((c) => c.ns.length)
      .map((c) => ({ n: median(c.ns), w: c.w }));
    let people = 3, pmin = 3, pmax = 3;
    if (counts.length) {
      const wsum = counts.reduce((a, c) => a + c.w, 0);
      people = Math.max(1, Math.ceil(counts.reduce((a, c) => a + c.n * c.w, 0) / wsum));
      pmin = Math.min(...counts.map((c) => c.n));
      pmax = Math.max(...counts.map((c) => c.n));
      if (pmax >= pmin * 1.6 && pmax - pmin >= 4)
        flags.push({ type: 'conflict', message: `Head-count disagrees across independent sources (${pmin}-${pmax}); using weighted estimate ${people}. Human check needed.` });
    } else flags.push({ type: 'assumed_count', message: 'No head-count in any report; assuming 3 people.' });
    const echoes = groups.filter((g) => g.reports.length > 1);
    for (const g of echoes)
      flags.push({ type: 'echo', message: `${g.reports.length} reports (${g.reports.map((r) => r.id).join(', ')}) are not independent - ${g.reason || 'same voice'}. Counted as 1 source, not ${g.reports.length}.` });
    const crowdOnly = groups.every((g) => g.reports.every((r) => r.source === 'citizen' || r.source === 'volunteer'));
    if (crowdOnly && rs.length > 1 && groups.length === 1)
      flags.push({ type: 'low_confidence', message: `${rs.length} reports but only 1 independent source and no field/sensor confirmation - verify before committing scarce boats.` });

    const rising = rs.some((r) => r.parsed!.hazards.includes('rising'));
    if (rising && rs.some((r) => r.parsed!.receding))
      flags.push({ type: 'conflict', message: 'Reports disagree on whether the water is rising or receding.' });
    if (rs.length > 1)
      flags.push({ type: 'duplicate_merged', message: `${rs.length} reports merged into one incident (${rs.map((r) => r.id).join(', ')}).` });

    const last = rs[rs.length - 1];
    const resolved = !!last.parsed!.resolved;
    if (resolved) flags.push({ type: 'resolved', message: `Latest report (${last.id}) says the situation is resolved.` });
    const ageMin = (now - last.timestamp) / 60000;
    if (!resolved && ageMin > staleMin)
      flags.push({ type: 'stale', message: `Newest report is ${Math.round(ageMin)} min old - re-confirm before dispatch.` });

    // confidence: noisy-or across independent sources, reduced by conflicts/staleness
    let miss = 1;
    for (const g of groups) {
      // a copy adds no new evidence and must not launder trust upward: a group is as credible as its average member
      const cs = g.reports.map((r) => SRC_CONF[r.source] * (0.6 + 0.4 * r.parsed!.confidence));
      miss *= 1 - cs.reduce((a, b) => a + b, 0) / cs.length;
    }
    let conf = Math.min(0.98, 1 - miss);
    if (flags.some((f) => f.type === 'conflict')) conf *= 0.85;
    if (flags.some((f) => f.type === 'stale')) conf *= 0.7;
    if (conf < 0.45 && !flags.some((f) => f.type === 'low_confidence')) flags.push({ type: 'low_confidence', message: `Low confidence (${round(conf, 2)}).` });

    const withCoords = rs.filter((r) => r.lat !== undefined);
    const lat = withCoords.length ? withCoords.reduce((a, r) => a + r.lat!, 0) / withCoords.length : s.lat;
    const lng = withCoords.length ? withCoords.reduce((a, r) => a + r.lng!, 0) / withCoords.length : s.lng;
    const hints = rs.map((r) => r.parsed!.waterHint).filter(Boolean) as string[];
    const landmark = rs.map((r) => r.parsed!.landmark).find(Boolean) ?? null;
    const hazards = uniq(rs.flatMap((r) => r.parsed!.hazards));
    const needs = uniq(rs.flatMap((r) => r.parsed!.needs));
    const inc: Incident = {
      id: `INC-${rs.map((r) => r.id).sort()[0].slice(2)}`,
      settlementId: s.id,
      settlementName: s.name,
      lat, lng,
      approxLocation: withCoords.length === 0,
      landmark,
      reportIds: rs.map((r) => r.id),
      people, peopleMin: pmin, peopleMax: pmax,
      hazards, needs,
      vulnerable: rs.some((r) => r.parsed!.vulnerable),
      urgency: Math.max(...rs.map((r) => r.parsed!.urgency)),
      waterHint: hints[hints.length - 1] ?? null,
      confidence: round(conf, 2),
      independentSources: groups.length,
      echoGroups: echoes.map((g) => ({ reportIds: g.reports.map((r) => r.id), reason: g.reason })),
      flags,
      status: resolved ? 'resolved' : 'active',
      firstReportAt: rs[0].timestamp,
      lastReportAt: last.timestamp,
      summary: `${s.name}${landmark ? ' (' + landmark + ')' : ''}: ~${people} people${hazards.length ? ', ' + hazards.join('/') : ''}`,
    };
    incidents.push(inc);
    details.push(`${inc.id} ${inc.summary} | conf ${inc.confidence} | ${inc.independentSources} independent of ${rs.length} reports | flags: ${flags.map((f) => f.type).join(', ') || 'none'}`);
  }
  incidents.sort((a, b) => a.id.localeCompare(b.id));
  const dups = incidents.reduce((a, i) => a + (i.reportIds.length - 1), 0);
  return {
    incidents,
    unplaced,
    trace: {
      agent: 'Verification',
      ms: Date.now() - t0,
      summary: `${usable.length} reports -> ${incidents.length} incidents (${dups} duplicates merged, ${incidents.filter((i) => i.flags.some((f) => f.type === 'conflict')).length} conflicts, ${incidents.filter((i) => i.flags.some((f) => f.type === 'stale')).length} stale, ${unplaced.length} unplaced)`,
      details: unplaced.length ? [...details, `Unplaced reports (no known location): ${unplaced.join(', ')}`] : details,
    },
  };
}

export { clamp };
