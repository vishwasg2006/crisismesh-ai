/**
 * Offline unit checks for hurdle "Split Brain and Fake Crowds" (no server needed):  npx tsx scripts/hurdle-test.ts
 */
import { analyse } from '../src/agents/analysis';
import { verify } from '../src/agents/verification';
import { reconcile, reservations } from '../src/agents/merge';
import { allocate } from '../src/agents/allocation';
import { analyseTerrain } from '../src/agents/terrain';
import { prioritize } from '../src/agents/prioritization';
import { Claim, Report, Resource, Route, Settlement } from '../src/types';

let failed = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed++; };
const now = Date.now();

// ------------------------------------------------------------------ split brain
const C = (o: Partial<Claim> & Pick<Claim, 'id' | 'nodeId' | 'resourceId' | 'settlementId'>): Claim => ({
  planId: 'P', settlementName: o.settlementId, incidentId: 'I', people: 8, priorityScore: 50,
  startAt: now, endAt: now + 3600000, status: 'proposed', ...o,
});
console.log('\n=== split brain ===');
{
  // Laptop A: B1 -> S4, already approved by a human. Laptop B: B1 -> S1, only a draft.
  const A = [C({ id: 'A:1', nodeId: 'A', resourceId: 'B1', settlementId: 'S4', status: 'approved', approvedBy: 'Asha', approvedAt: now - 60000, priorityScore: 40 })];
  const B = [C({ id: 'B:1', nodeId: 'B', resourceId: 'B1', settlementId: 'S1', status: 'proposed', priorityScore: 99 })];
  const r1 = reconcile(A, B), r2 = reconcile(B, A);
  const s = (r: ReturnType<typeof reconcile>) => JSON.stringify(r.claims.map((c) => [c.id, c.status]));
  check(s(r1) === s(r2), 'merge is commutative: both laptops converge on the same claims');
  check(JSON.stringify(reconcile(r1.claims, B, r1.conflicts).claims) === JSON.stringify(r1.claims), 'merge is idempotent');
  const kept = r1.claims.find((c) => c.id === 'A:1')!;
  check(kept.status === 'approved' && kept.resourceId === 'B1' && kept.settlementId === 'S4' && kept.approvedBy === 'Asha', 'approved claim untouched even though the unapproved one has HIGHER priority (99 vs 40)');
  check(r1.claims.find((c) => c.id === 'B:1')!.status === 'void' && r1.conflicts[0].kind === 'approved_wins', 'unapproved draft voided, recorded as an explained conflict');
  const h = reservations(r1.claims, 'B');
  check(h.reserved['B1']?.[0] === 'S4', 'allocator will treat B1 as reserved for S4 on both nodes');
}
{
  // Both approved by different humans for overlapping work -> never auto-resolved
  const A = [C({ id: 'A:1', nodeId: 'A', resourceId: 'B1', settlementId: 'S4', status: 'approved', approvedBy: 'Asha', approvedAt: now - 5000 })];
  const B = [C({ id: 'B:1', nodeId: 'B', resourceId: 'B1', settlementId: 'S1', status: 'approved', approvedBy: 'Ben', approvedAt: now - 9000 })];
  const r = reconcile(A, B);
  check(r.claims.every((c) => c.status === 'approved' && c.contested), 'two approvals both survive, both flagged contested (nothing silently changed)');
  check(r.conflicts.length === 1 && r.conflicts[0].status === 'needs_human' && !r.conflicts[0].keptClaimId, 'raised as needs_human with no auto-winner');
  check(reservations(r.claims, 'A').blocked.includes('B1'), 'B1 frozen for new plans until a human decides');
  const later = [C({ id: 'A:2', nodeId: 'A', resourceId: 'B1', settlementId: 'S4', status: 'approved', approvedAt: now, startAt: now + 7200000, endAt: now + 9000000 })];
  check(reconcile(later, [B[0]]).conflicts.length === 0, 'same boat approved for non-overlapping times is NOT a conflict');
}
{
  const A = [C({ id: 'A:1', nodeId: 'A', resourceId: 'B1', settlementId: 'S4', priorityScore: 70 })];
  const B = [C({ id: 'B:1', nodeId: 'B', resourceId: 'B1', settlementId: 'S1', priorityScore: 55 })];
  const r1 = reconcile(A, B), r2 = reconcile(B, A);
  check(JSON.stringify(r1.claims) === JSON.stringify(r2.claims) && r1.claims.find((c) => c.id === 'A:1')!.status === 'proposed', 'two drafts: higher-priority incident keeps the boat, same answer on both nodes');
}

// ------------------------------------------------------------------ allocator honours the hold
const S = (id: string, lat: number): Settlement => ({ id, name: id, aliases: [id.toLowerCase()], type: id === 'BASE' ? 'base' : 'village', lat, lng: 76.65, population: 1000, waterLevelM: 1.5, riseRateMPerHr: 0.3, criticalLevelM: 2.5, updatedAt: now });
const settlements = [S('BASE', 12.3), S('S1', 12.31), S('S3', 12.29), S('S4', 12.32)];
const routes: Route[] = ['S1', 'S3', 'S4'].map((s, i) => ({ id: 'W' + i, a: 'BASE', b: s, mode: 'water', minutes: 8 + i, status: 'open' }));
const boats: Resource[] = ['B1', 'B2'].map((id) => ({ id, name: id, kind: 'boat', mode: 'water', capacity: 8, speedFactor: 1, skills: [], status: 'available' }));
const mk = (id: string, source: Report['source'], name: string, text: string, sid: string, ago: number, off = 0): Report => ({
  id, source, text, reporterName: name, timestamp: now - ago * 60000, createdAt: now, origin: 'local', synced: true,
  lat: settlements.find((s) => s.id === sid)!.lat + off, lng: 76.65 + off, settlementId: undefined,
});
async function incidentsFrom(reports: Report[]) {
  const an = await analyse(reports, settlements, 'flood', false);
  const v = verify(an.reports, settlements, now, 180);
  const ter = analyseTerrain(settlements, routes);
  const act = v.incidents.filter((i) => i.status === 'active');
  const pri = prioritize(act, ter.terrain, settlements, 'flood');
  for (const i of v.incidents) { i.priority = pri.priorities.find((p) => p.incidentId === i.id); }
  return { v, ter, act, pri };
}

(async () => {
  console.log('\n=== allocator vs approved hold ===');
  const base = [
    mk('R-1', 'field', 'Ravi', 'Sangam S4 roof: 10 people trapped, water chest high, need boat', 'S4', 20),
    mk('R-2', 'field', 'Imran', 'S1 panchayat office: 10 people trapped, water waist high, need boat', 'S1', 20),
  ].map((r) => ({ ...r, text: r.text.replace('Sangam S4', 'S4').replace('S1 panchayat', 'S1 panchayat') }));
  const { act, pri, ter } = await incidentsFrom(base);
  const free = allocate(act, pri.priorities, ter.terrain, boats, {});
  const topInc = pri.priorities[0].incidentId;
  const topSettle = act.find((i) => i.id === topInc)!.settlementId;
  const lowSettle = act.find((i) => i.id !== topInc)!.settlementId;
  // pretend a human already approved B1 for the LOWER priority incident
  const held = allocate(act, pri.priorities, ter.terrain, boats, {}, { reserved: { B1: [lowSettle] }, blocked: [] });
  check(held.assignments.some((a) => a.resourceId === 'B1' && a.settlementId === lowSettle), `approved B1 stays on ${lowSettle} even though ${topSettle} outranks it`);
  check(!held.assignments.some((a) => a.resourceId === 'B1' && a.settlementId === topSettle), 'higher-priority incident does not steal the approved boat');
  const frozen = allocate(act, pri.priorities, ter.terrain, boats, {}, { reserved: {}, blocked: ['B1'] });
  check(!frozen.assignments.some((a) => a.resourceId === 'B1'), 'contested boat is excluded from new plans');
  console.log('  (free plan used:', free.assignments.map((a) => a.resourceId + '>' + a.settlementId).join(', '), ')');

  // ---------------------------------------------------------------- fake crowds
  console.log('\n=== fake crowds ===');
  const msg = 'S3 market area, people trapped, water rising fast, need boat';
  const crowd = [
    mk('R-10', 'citizen', 'Anonymous', msg + ' 12 people', 'S3', 9, 0),
    mk('R-11', 'citizen', 'Anonymous', msg + ' 12 people please', 'S3', 8, 0.004),
    mk('R-12', 'citizen', 'Anonymous', 'S3 market area people trapped water rising fast need boat 12 people!!', 'S3', 7, 0.008),
    mk('R-13', 'citizen', 'user8841', msg + ' 12 people', 'S3', 6, 0.012),
    mk('R-14', 'citizen', 'user8841', msg + ' 12 people', 'S3', 5, 0.001),
    mk('R-15', 'volunteer', 'Anonymous', msg + ' 12 people', 'S3', 4, -0.005),
  ];
  const real = [mk('R-1', 'field', 'Ravi', 'S4 roof: 10 people trapped, water chest high, need boat', 'S4', 20)];
  const f = await incidentsFrom([...real, ...crowd]);
  const s3 = f.v.incidents.find((i) => i.settlementId === 'S3')!;
  const s4 = f.v.incidents.find((i) => i.settlementId === 'S4')!;
  check(f.v.incidents.filter((i) => i.settlementId === 'S3').length === 1, `6 scattered copies -> 1 incident, not 6 (${f.v.incidents.length} total)`);
  check(s3.reportIds.length === 6 && s3.independentSources === 1, `6 reports counted as ${s3.independentSources} independent source`);
  check(s3.flags.some((x) => x.type === 'echo'), 'echo flag explains why: ' + s3.flags.find((x) => x.type === 'echo')?.message);
  const lone = (await incidentsFrom([mk('R-20', 'citizen', 'Kamala', msg + ' 12 people', 'S3', 9)])).v.incidents[0];
  check(s3.confidence <= lone.confidence + 0.05, `six copies are no more believable than one (${s3.confidence} vs ${lone.confidence})`);
  const honest = (await incidentsFrom([
    mk('R-30', 'citizen', 'Kamala', msg + ' 12 people', 'S3', 9),
    mk('R-31', 'field', 'Imran', 'S3 market: 11 people on first floor, water waist high, need evacuation', 'S3', 7),
  ])).v.incidents[0];
  check(honest.independentSources === 2 && honest.confidence > lone.confidence, `two genuinely different sources DO raise confidence (${honest.confidence})`);
  check(s4.confidence > s3.confidence, `single field-team report (${s4.confidence}) outranks 6 anonymous copies (${s3.confidence})`);
  const top = f.pri.priorities[0].incidentId;
  check(f.act.find((i) => i.id === top)!.settlementId === 'S4', 'real field-confirmed incident is ranked #1, not the crowd');
  const al = allocate(f.act, f.pri.priorities, f.ter.terrain, boats, {});
  const w = al.assignments.find((a) => a.settlementId === 'S3');
  check(!w || w.warnings.some((x) => x.includes('independent source')), 'if S3 gets a boat it carries a "verify first" warning');
  console.log(`\n${failed ? failed + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED'}`);
  process.exit(failed ? 1 : 0);
})();
