import { Assignment, Incident, Plan, Priority, TraceEntry, Unassigned } from '../types';
import { narrate } from './llm';

/** Response Planning agent: cross-checks the others' work, adds warnings, writes an explainable summary. */
export async function planResponse(
  incidents: Incident[],
  priorities: Priority[],
  assignments: Assignment[],
  unassigned: Unassigned[],
  resourcesTotal: number,
  unplaced: string[],
  mode: 'online' | 'offline',
  useLlm: boolean,
): Promise<{ summary: Plan['summary']; warnings: string[]; narrative: string; trace: TraceEntry }> {
  const t0 = Date.now();
  const iMap = new Map(incidents.map((i) => [i.id, i]));
  const warnings: string[] = [];
  const details: string[] = [];

  // specialists challenge each other
  for (const a of assignments) {
    const inc = iMap.get(a.incidentId)!;
    for (const f of inc.flags) {
      if (f.type === 'conflict') a.warnings.push(`Verification challenge: ${f.message}`);
      if (f.type === 'stale') a.warnings.push(`Verification challenge: ${f.message}`);
      if (f.type === 'assumed_count') a.warnings.push(`Verification challenge: ${f.message}`);
    }
    if (inc.priority && inc.priority.components.access.score === 100 && a.mode === 'road')
      a.warnings.push('Terrain challenge: road access reported cut but a road team was chosen - verify the route.');
    if (a.warnings.length) details.push(`${a.id} ${a.settlementName}: ${a.warnings.length} warning(s) -> human check`);
  }
  if (unplaced.length) warnings.push(`${unplaced.length} report(s) could not be placed on the map (${unplaced.join(', ')}) - review manually.`);
  if (mode === 'offline') warnings.push('Planned OFFLINE from local data only. Remote reports will be merged and the plan re-evaluated on reconnect.');
  if (unassigned.length) warnings.push(`${unassigned.reduce((s, u) => s + u.peopleRemaining, 0)} people are not covered by current resources.`);

  const active = incidents.filter((i) => i.status === 'active');
  const covered = assignments.reduce((s, a) => s + a.peopleServed, 0);
  const atRisk = active.reduce((s, i) => s + i.people, 0);
  const summary: Plan['summary'] = {
    incidentsTotal: incidents.length,
    incidentsPlanned: active.length,
    peopleAtRisk: atRisk,
    peopleCovered: Math.min(covered, atRisk),
    peopleUncovered: unassigned.reduce((s, u) => s + u.peopleRemaining, 0),
    resourcesUsed: new Set(assignments.map((a) => a.resourceId)).size,
    resourcesTotal,
    conflicts: active.filter((i) => i.flags.some((f) => f.type === 'conflict')).length,
    stale: active.filter((i) => i.flags.some((f) => f.type === 'stale')).length,
    unplacedReports: unplaced.length,
  };

  const top = priorities.slice(0, 3).map((p) => `#${p.rank} ${iMap.get(p.incidentId)!.summary} (${p.explanation})`);
  const first = priorities[0];
  let narrative = first
    ? `${mode === 'offline' ? '[OFFLINE] ' : ''}${summary.incidentsPlanned} active incidents, ~${summary.peopleAtRisk} people at risk. ` +
      `Highest priority is ${iMap.get(first.incidentId)!.settlementName} (score ${first.score}): ${first.components.danger.reason}; ${first.components.time.reason}. ` +
      `${summary.resourcesUsed}/${resourcesTotal} boats/teams are committed, covering ${summary.peopleCovered} people` +
      (summary.peopleUncovered ? `; ${summary.peopleUncovered} remain uncovered.` : '.') +
      (summary.conflicts || summary.stale ? ` ${summary.conflicts} conflicting and ${summary.stale} stale report group(s) need human confirmation before dispatch.` : '')
    : 'No active incidents.';
  let method = 'template';
  if (useLlm && first) {
    const text = await narrate(
      `Mode: ${mode}\nSummary: ${JSON.stringify(summary)}\nTop priorities:\n${top.join('\n')}\n` +
        `Assignments:\n${assignments.map((a) => `${a.resourceName} -> ${a.settlementName} (${a.peopleServed} ppl, ETA ${a.etaMin} min)`).join('\n')}\n` +
        `Warnings:\n${warnings.join('\n') || 'none'}`,
    );
    if (text) {
      narrative = text;
      method = 'local LLM';
    }
  }
  return {
    summary,
    warnings,
    narrative,
    trace: {
      agent: 'Response Planning',
      ms: Date.now() - t0,
      summary: `Plan assembled (${method} narrative); ${assignments.filter((a) => a.warnings.length).length} assignment(s) carry warnings`,
      details,
    },
  };
}
