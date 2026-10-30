/**
 * End-to-end demo of the review flow:
 *   flood reports -> approve plan -> network outage -> new local report -> remote reports queue
 *   -> reconnect -> merge + conflict flags + replan + plan diff -> human modifies -> approve
 * Usage:  npm run demo        (server must be running on BASE_URL, default http://localhost:4000)
 */
const BASE = process.env.BASE_URL || 'http://localhost:4000';

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(BASE + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
}
const h = (t: string) => console.log(`\n=== ${t} ===`);
let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failed++;
};

function showPlan(p: any) {
  console.log(`${p.id} [${p.status}/${p.mode}] ${JSON.stringify(p.summary)}`);
  for (const a of p.assignments)
    console.log(`  ${a.resourceId} -> ${a.settlementName}: ${a.peopleServed} ppl, ETA ${a.etaMin}m, ${a.trips} trip(s)${a.atRisk ? ' AT-RISK' : ''}${a.warnings.length ? '  ! ' + a.warnings.join(' | ') : ''}`);
  for (const u of p.unassigned) console.log(`  UNASSIGNED ${u.settlementName}: ${u.peopleRemaining} ppl - ${u.reason}`);
  if (p.diff) console.log('  diff:', p.diff.summary.join(' ; '), '\n   ', p.diff.items.map((i: any) => `${i.type}:${i.settlementName}:${i.detail}`).join('\n    '));
}

async function main() {
  h('health');
  const hl = await call('GET', '/health');
  console.log(hl);

  h('1. reset scenario -> first plan from messy reports');
  await call('POST', '/scenario/reset');
  let plan = await call('GET', '/plans/latest');
  showPlan(plan);
  check(plan.summary.incidentsPlanned >= 7, `incidents formed from 14 raw reports (${plan.summary.incidentsPlanned} active)`);
  const incs = await call('GET', '/incidents');
  const sangam = incs.find((i: any) => i.settlementId === 'S4');
  check(sangam && sangam.reportIds.length === 3, 'Sangam Colony: 3 duplicate reports merged into 1 incident');
  const kav = incs.find((i: any) => i.settlementId === 'S1');
  check(kav && kav.flags.some((f: any) => f.type === 'conflict'), 'Kaveri Nagar: conflicting head-count (6 vs 32) flagged');
  check(incs.some((i: any) => i.flags.some((f: any) => f.type === 'stale')), 'Temple Street: stale report flagged');
  check(incs.some((i: any) => i.status === 'resolved' && i.settlementId === 'S2'), 'Hosahalli: resolved incident excluded from plan');
  check(incs[0].settlementId === 'S4', `top priority = ${incs[0].settlementName} (score ${incs[0].priority.score}) -> ${incs[0].priority.explanation}`);
  console.log('  agent trace:', plan.trace.map((t: any) => `${t.agent}: ${t.summary}`).join('\n    '));

  h('2. human approves plan');
  const ap = await call('POST', `/plans/${plan.id}/approve`, { by: 'Coordinator', note: 'looks right' });
  check(ap.status === 'approved', `${ap.id} approved by ${ap.approvedBy}`);

  h('3. network outage (offline mode)');
  await call('POST', '/network', { online: false });
  const r1 = await call('POST', '/reports', {
    source: 'field', text: 'Anchepalya second terrace near school: 7 people stuck, water chest high, urgent',
    lat: 12.3395, lng: 76.6612, reporterName: 'Divya (field team)',
  });
  console.log('  new local report parsed:', JSON.stringify(r1.report.parsed));
  check(r1.plan.mode === 'offline' && r1.report.synced === false, 'report queued locally (synced=false), plan computed offline');
  const q = await call('POST', '/sync/remote-inbox', { demo: true });
  check(q.delivered === false && q.queued === 4, '4 remote reports held in inbox while offline');
  let st = await call('GET', '/sync/status');
  console.log('  sync status:', st);
  check(st.inboxPending === 4 && st.localUnsynced === 1, 'inbox pending 4, local unsynced 1');

  h('4. reconnect -> merge, flag conflicts, replan');
  const rc = await call('POST', '/network', { online: true });
  console.log('  sync:', rc.sync);
  check(rc.sync.pulled === 4 && rc.sync.pushed === 1, 'pulled 4 remote, pushed 1 local');
  check(rc.sync.mergedIntoExisting >= 2, `${rc.sync.mergedIntoExisting} remote reports merged into existing incidents`);
  plan = await call('GET', '/plans/latest');
  showPlan(plan);
  check(plan.status === 'draft' && !!plan.diff && plan.diff.items.length > 0, 'new draft plan with a diff vs approved plan');

  h('5. human modifies an assignment, then approves');
  const target = plan.assignments.find((a: any) => a.mode === 'water' && !a.locked);
  const other = (await call('GET', '/resources')).find((r: any) => r.mode === 'water' && r.id !== target.resourceId);
  const mod = await call('PATCH', `/plans/${plan.id}/assignments/${target.id}`, { resourceId: other.id, by: 'Coordinator' });
  const locked = mod.assignments.find((a: any) => a.incidentId === target.incidentId && a.resourceId === other.id);
  check(!!locked && locked.locked, `${target.settlementName}: reassigned ${target.resourceId} -> ${other.id} (locked)`);
  const fin = await call('POST', `/plans/${mod.id}/approve`, { by: 'Coordinator' });
  check(fin.status === 'approved', `${fin.id} approved`);
  let stale409 = false;
  try { await call('POST', `/plans/${plan.id}/approve`, {}); } catch { stale409 = true; }
  check(stale409, 'superseded plan cannot be approved (409)');

  h('6. water keeps rising (simulate +90 min) and a route closes');
  const tk = await call('POST', '/simulate/tick', { minutes: 90 });
  console.log('  ', tk.diff.join(' ; '));
  await call('PATCH', '/routes/WR1', { status: 'blocked', note: 'debris' });
  plan = await call('GET', '/plans/latest');
  showPlan(plan);

  h('7. audit trail');
  const ev = await call('GET', '/events?limit=500');
  console.log('  event log entries:', ev.length, '| types:', [...new Set(ev.map((e: any) => e.type))].join(', '));
  check(ev.length > 10, 'event log recorded');

  console.log(`\n${failed ? failed + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED'}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
