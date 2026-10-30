import { Claim, MergeConflict } from '../types';

/**
 * Split-brain reconciliation of resource claims. PURE + DETERMINISTIC: both laptops run it over the same
 * union of claims and reach the same answer without talking again (CRDT-style: commutative, idempotent).
 *
 * Rules
 *  1. A claim that a human APPROVED is never changed, voided or re-timed by a merge.
 *  2. approved vs proposed on the same boat (overlapping time)  -> approved wins, the proposal is voided.
 *  3. approved vs approved for different incidents              -> NOT auto-resolved. Both stay, flagged
 *     `contested`, boat is frozen for new plans, a human must pick (a crew may already be on the water).
 *  4. proposed vs proposed -> deterministic tiebreak: priority score, people at risk, earlier, node id.
 *  5. same boat + same incident from both nodes -> harmless duplicate, collapsed.
 */
const overlaps = (a: Claim, b: Claim) => a.startAt < b.endAt && b.startAt < a.endAt;
const live = (c: Claim) => c.status === 'proposed' || c.status === 'approved';

const rank = (a: Claim, b: Claim): number => {
  if ((a.status === 'approved') !== (b.status === 'approved')) return a.status === 'approved' ? -1 : 1;
  if (a.status === 'approved') return (a.approvedAt ?? 0) - (b.approvedAt ?? 0) || a.nodeId.localeCompare(b.nodeId) || a.id.localeCompare(b.id);
  return b.priorityScore - a.priorityScore || b.people - a.people || a.startAt - b.startAt || a.nodeId.localeCompare(b.nodeId) || a.id.localeCompare(b.id);
};

const STATUS_STRENGTH: Record<Claim['status'], number> = { proposed: 0, void: 1, approved: 2, revoked: 3 };

export function reconcile(local: Claim[], remote: Claim[], existing: MergeConflict[] = [], now = Date.now()): { claims: Claim[]; conflicts: MergeConflict[] } {
  // union by id; a human-made state (approved / revoked) is stronger than a machine-made one
  const byId = new Map<string, Claim>();
  for (const c of [...local, ...remote]) {
    const prev = byId.get(c.id);
    if (!prev || STATUS_STRENGTH[c.status] > STATUS_STRENGTH[prev.status]) byId.set(c.id, { ...c });
  }
  const all = [...byId.values()].map((c) => ({ ...c, contested: false }));
  for (const c of all) if (c.status === 'void') { c.status = 'proposed'; c.voidedBy = undefined; } // re-derive voids from scratch
  const known = new Map(existing.map((c) => [c.id, c]));
  const out: MergeConflict[] = [];
  const mk = (kind: MergeConflict['kind'], res: string, a: Claim, b: Claim, kept: Claim | undefined, status: MergeConflict['status'], message: string) => {
    const id = `MC-${res}-${[a.id, b.id].sort().join('|')}`;
    const prev = known.get(id);
    out.push(prev && prev.status === 'resolved_by_human' ? prev : { id, resourceId: res, kind, status, claimIds: [a.id, b.id].sort(), keptClaimId: kept?.id, message, createdAt: prev?.createdAt ?? now });
  };

  const byRes = new Map<string, Claim[]>();
  for (const c of all) if (live(c)) byRes.set(c.resourceId, [...(byRes.get(c.resourceId) ?? []), c]);
  for (const [res, cs] of byRes) {
    cs.sort(rank);
    const kept: Claim[] = [];
    for (const c of cs) {
      const clash = kept.find((k) => k.settlementId !== c.settlementId && overlaps(k, c));
      const dupe = kept.find((k) => k.settlementId === c.settlementId && overlaps(k, c));
      if (dupe && !clash) { // same job claimed on both laptops: keep one
        if (c.status === 'approved') kept.push(c); else { c.status = 'void'; c.voidedBy = dupe.id; }
        continue;
      }
      if (!clash) { kept.push(c); continue; }
      if (c.status === 'approved' && clash.status === 'approved') {
        c.contested = clash.contested = true;
        kept.push(c);
        mk('approved_vs_approved', res, clash, c, undefined, 'needs_human',
          `${res} is approved for ${clash.settlementName} (by ${clash.approvedBy ?? clash.nodeId}) AND ${c.settlementName} (by ${c.approvedBy ?? c.nodeId}) at overlapping times. Neither approval was changed - a coordinator must choose.`);
      } else if (clash.status === 'approved') {
        c.status = 'void'; c.voidedBy = clash.id;
        mk('approved_wins', res, clash, c, clash, 'auto_resolved',
          `${res} was already approved for ${clash.settlementName}; the unapproved proposal for ${c.settlementName} on ${c.nodeId} was dropped and will be re-planned with another resource.`);
      } else {
        c.status = 'void'; c.voidedBy = clash.id;
        mk('proposed_tiebreak', res, clash, c, clash, 'auto_resolved',
          `${res} proposed for both ${clash.settlementName} (priority ${clash.priorityScore}) and ${c.settlementName} (priority ${c.priorityScore}); higher priority keeps it, the other is re-planned.`);
      }
    }
  }
  // keep human resolutions that no longer clash (history), drop auto notes that no longer apply
  for (const k of known.values()) if (k.status === 'resolved_by_human' && !out.some((o) => o.id === k.id)) out.push(k);
  all.sort((a, b) => a.id.localeCompare(b.id));
  out.sort((a, b) => a.id.localeCompare(b.id));
  return { claims: all, conflicts: out };
}

/** What the allocator must respect: boats reserved for an approved job, and boats frozen by an unresolved clash. */
export function reservations(claims: Claim[], selfNode: string): { reserved: Record<string, string[]>; blocked: string[] } {
  const reserved: Record<string, string[]> = {};
  const blocked = new Set<string>();
  for (const c of claims) {
    if (c.contested && c.status === 'approved') blocked.add(c.resourceId);
    // approved anywhere, or a peer's winning proposal (so we don't double-book against it)
    const binding = c.status === 'approved' || (c.status === 'proposed' && c.nodeId !== selfNode);
    if (binding) reserved[c.resourceId] = [...new Set([...(reserved[c.resourceId] ?? []), c.settlementId])];
  }
  return { reserved, blocked: [...blocked] };
}
