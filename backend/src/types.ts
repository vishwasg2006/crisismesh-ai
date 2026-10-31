export type Hazard = 'flood' | 'fire' | 'landslide';
export type Source = 'sensor' | 'field' | 'volunteer' | 'citizen';
export type Mode = 'road' | 'water';

export interface Settlement {
  id: string;
  name: string;
  aliases: string[];
  type: 'base' | 'village' | 'town' | 'ward';
  lat: number;
  lng: number;
  population: number;
  waterLevelM: number;
  riseRateMPerHr: number;
  criticalLevelM: number;
  updatedAt: number;
}

export interface Route {
  id: string;
  a: string;
  b: string;
  mode: Mode;
  minutes: number;
  status: 'open' | 'blocked' | 'flooded';
  note?: string;
}

export interface Resource {
  id: string;
  name: string;
  kind: 'boat' | 'team';
  mode: Mode;
  capacity: number;
  speedFactor: number;
  skills: string[];
  status: 'available' | 'busy' | 'offline';
}

export interface Parsed {
  settlementId: string | null;
  landmark: string | null;
  people: number | null;
  hazards: string[];
  needs: string[];
  vulnerable: boolean;
  waterHint: string | null;
  urgency: number; // 0..1
  resolved: boolean;
  receding: boolean;
  confidence: number; // parse confidence 0..1
  method: 'rules' | 'llm+rules';
}

export interface Report {
  id: string;
  source: Source;
  text: string;
  reporterName?: string;
  lat?: number;
  lng?: number;
  settlementId?: string;
  peopleCount?: number;
  reading?: { waterLevelM: number; riseRateMPerHr?: number };
  timestamp: number; // when it was observed (epoch ms)
  createdAt: number; // when this node received it
  origin: 'local' | 'remote';
  /** set on reports that arrived from a peer node (ids are only unique per node) */
  originNode?: string;
  originId?: string;
  synced: boolean;
  parsed?: Parsed;
}

export interface Flag {
  type: 'duplicate_merged' | 'conflict' | 'stale' | 'assumed_count' | 'low_confidence' | 'resolved' | 'echo';
  message: string;
}

export interface PathInfo {
  reachable: boolean;
  minutes: number | null;
  path: string[];
}

export interface Terrain {
  settlementId: string;
  name: string;
  stage: 'watch' | 'warning' | 'critical' | 'severe';
  ratio: number;
  timeToCriticalMin: number | null;
  boat: PathInfo;
  road: PathInfo;
  roadCut: boolean;
  notes: string[];
}

export interface Comp {
  score: number;
  weight: number;
  reason: string;
}

export interface Priority {
  incidentId: string;
  score: number;
  rank: number;
  components: { danger: Comp; people: Comp; access: Comp; time: Comp };
  confidenceFactor: number;
  timeLeftMin: number | null;
  explanation: string;
}

export interface Incident {
  id: string;
  settlementId: string;
  settlementName: string;
  lat: number;
  lng: number;
  approxLocation: boolean;
  landmark: string | null;
  reportIds: string[];
  people: number;
  peopleMin: number;
  peopleMax: number;
  hazards: string[];
  needs: string[];
  vulnerable: boolean;
  urgency: number;
  waterHint: string | null;
  confidence: number;
  /** how many reports vs how many genuinely independent voices stand behind this incident */
  independentSources: number;
  echoGroups: { reportIds: string[]; reason: string }[];
  flags: Flag[];
  status: 'active' | 'resolved';
  firstReportAt: number;
  lastReportAt: number;
  summary: string;
  terrain?: Terrain;
  priority?: Priority;
}

export interface Assignment {
  id: string;
  incidentId: string;
  settlementId: string;
  settlementName: string;
  resourceId: string;
  resourceName: string;
  mode: Mode;
  peopleServed: number;
  trips: number;
  etaMin: number;
  startMin: number;
  finishMin: number;
  route: string[];
  atRisk: boolean;
  locked: boolean;
  reason: string;
  warnings: string[];
}

export interface Unassigned {
  incidentId: string;
  settlementId: string;
  settlementName: string;
  peopleRemaining: number;
  reason: string;
}

export interface TraceEntry {
  agent: string;
  ms: number;
  summary: string;
  details: string[];
}

export interface DiffItem {
  type: 'added' | 'removed' | 'changed' | 'priority' | 'unassigned';
  incidentId: string;
  settlementName: string;
  detail: string;
}

export interface PlanDiff {
  against: string;
  againstVersion: number;
  items: DiffItem[];
  summary: string[];
}

export interface Modification {
  at: number;
  by: string;
  incidentId: string;
  resourceIds: string[];
  note: string;
}

export interface Plan {
  id: string;
  version: number;
  status: 'draft' | 'approved' | 'rejected' | 'superseded';
  mode: 'online' | 'offline';
  hazard: Hazard;
  trigger: string;
  createdAt: number;
  assignments: Assignment[];
  unassigned: Unassigned[];
  priorities: Priority[];
  trace: TraceEntry[];
  summary: {
    incidentsTotal: number;
    incidentsPlanned: number;
    peopleAtRisk: number;
    peopleCovered: number;
    peopleUncovered: number;
    resourcesUsed: number;
    resourcesTotal: number;
    conflicts: number;
    stale: number;
    unplacedReports: number;
  };
  narrative: string;
  warnings: string[];
  diff: PlanDiff | null;
  modifications: Modification[];
  approvedBy?: string;
  approvedAt?: number;
  note?: string;
}

// ---------------------------------------------------------------- split-brain merge
/** A node's claim on a resource for an incident (settlement). The unit that gets reconciled between nodes. */
export interface Claim {
  id: string; // `${nodeId}:${planId}:${resourceId}:${settlementId}` - globally unique
  nodeId: string;
  planId: string;
  resourceId: string;
  settlementId: string; // stable cross-node key (incident ids are node-local)
  settlementName: string;
  incidentId: string;
  people: number;
  priorityScore: number;
  startAt: number; // absolute epoch ms the resource is committed from
  endAt: number;
  status: 'proposed' | 'approved' | 'void' | 'revoked';
  approvedBy?: string;
  approvedAt?: number;
  voidedBy?: string; // claim id that beat this one
  contested?: boolean; // approved on two nodes for overlapping work - needs a human
}

export interface MergeConflict {
  id: string;
  resourceId: string;
  kind: 'approved_vs_approved' | 'approved_wins' | 'proposed_tiebreak';
  status: 'needs_human' | 'auto_resolved' | 'resolved_by_human';
  claimIds: string[];
  keptClaimId?: string;
  message: string;
  createdAt: number;
  resolvedBy?: string;
  resolvedAt?: number;
  note?: string;
}

export interface PeerSnapshot {
  nodeId: string;
  at: number;
  claims: Claim[];
  reports: Report[]; // only reports this node originated
}

export interface PeerMergeResult {
  peer: string;
  reportsPulled: number;
  reportsSkipped: number;
  claimsReceived: number;
  conflicts: MergeConflict[];
  needsHuman: number;
  planId: string | null;
  approvedAssignmentsChanged: 0; // invariant: a merge never edits an approved decision
}
