
import type { Incident, Conflict } from "./pipeline";

export type PriorityLevel = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type PriorityBreakdown = {
  incidentId: string;
  placeId: string;
  type: string;
  score: number;
  level: PriorityLevel;
  reasons: string[];
  peopleAtRisk: number | null;
  freshness: Incident["freshness"];
  hasConflict: boolean;
  factorScores: {
    severity: number;
    peopleAtRisk: number;
    freshness: number;
    sourceReliability: number;
  };
  requiresHumanReview: boolean;
};

export type Resource = {
  id: string;
  placeId?: string;
  type?: string;
  capacity?: number;
  available?: boolean;
  status?: string;
  [key: string]: unknown;
};

export type ResourceAssignment = {
  incidentId: string;
  resourceId: string;
  peopleCovered: number;
  requiresHumanApproval: true;
};

export type ResponsePlan = {
  generatedAt: string;
  planningMode: string;
  requiresHumanApproval: true;
  priorityMethod: string;
  rankedIncidents: PriorityBreakdown[];
  assignments: ResourceAssignment[];
  unassignedIncidents: string[];
  unassignedResources: string[];
  warnings: string[];
};


const SEVERITY: Record<string, number> = {
  people_trapped: 40,
  rescue_required: 39,
  medical: 38,
  at_risk_facility: 34,
  bridge_damaged: 30,
  flood_water_level: 32,
  road_blocked: 27,
  water_supply: 28,
  food_supply: 28,
  unknown: 15,
};


function getPriorityLevel(score: number): PriorityLevel {
  if (score >= 75) return "CRITICAL";
  if (score >= 55) return "HIGH";
  if (score >= 35) return "MEDIUM";
  return "LOW";
}

function scoreIncident(
  incident: Incident,
  conflicts: Conflict[]
): PriorityBreakdown {
  const people = Math.max(0, incident.peopleAtRisk ?? 0);

  // Illustrative prototype scoring, not a validated emergency standard.
  const severityScore = SEVERITY[incident.type] ?? SEVERITY.unknown;
  const peopleScore = Math.min(30, Math.floor(people / 2));

  const freshnessScore =
    incident.freshness === "fresh"
      ? 20
      : incident.freshness === "aging"
        ? 10
        : 0;

  const reliabilityScore = Math.round(
    Math.max(0, Math.min(1, incident.sourceReliability ?? 0.5)) * 10
  );

  const score = Math.min(
    100,
    severityScore + peopleScore + freshnessScore + reliabilityScore
  );

  const unresolvedConflict = conflicts.some(
    (conflict) =>
      conflict.incidentId === incident.id && !conflict.resolved
  );

  const reasons: string[] = [
    `Incident severity: ${severityScore}/40.`,
    `Affected people contribution: ${peopleScore}/30.`,
    `Report freshness contribution: ${freshnessScore}/20.`,
    `Source reliability contribution: ${reliabilityScore}/10.`,
  ];

  if (incident.peopleAtRisk === null) {
    reasons.push("Affected-person count is unknown; confirm it with responders.");
  } else {
    reasons.push(`${people} people reported at risk.`);
  }

  if (incident.freshness === "stale") {
    reasons.push("Report may be outdated; verify current conditions.");
  }

  if (unresolvedConflict) {
    reasons.push("Conflicting reports require human review.");
  }

  if (incident.flags.length > 0) {
    reasons.push(`Flags: ${incident.flags.join(", ")}.`);
  }

  return {
    incidentId: incident.id,
    placeId: incident.placeId,
    type: incident.type,
    score,
    level: getPriorityLevel(score),
    reasons,
    peopleAtRisk: incident.peopleAtRisk,
    freshness: incident.freshness,
    hasConflict: unresolvedConflict,
    factorScores: {
      severity: severityScore,
      peopleAtRisk: peopleScore,
      freshness: freshnessScore,
      sourceReliability: reliabilityScore,
    },
    requiresHumanReview: true,
  };
}

function isResourceAvailable(resource: Resource): boolean {
  if (resource.available === false) return false;
  if (resource.status && resource.status.toLowerCase() !== "available") {
    return false;
  }
  return Number(resource.capacity ?? 0) > 0;
}

function isResourceCompatible(
  incidentType: string,
  resource: Resource
): boolean {
  const resourceType = String(resource.type ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  const compatibleTypes: Record<string, string[]> = {
    people_trapped: ["boat", "rescue_boat", "rescue_team", "helicopter"],
    rescue_required: ["boat", "rescue_boat", "rescue_team", "helicopter"],
    flood_water_level: ["boat", "rescue_boat", "rescue_team", "helicopter"],
    medical: ["ambulance", "medical_team", "medical"],
    at_risk_facility: [
      "boat",
      "rescue_boat",
      "rescue_team",
      "helicopter",
      "ambulance",
      "medical_team",
    ],
    bridge_damaged: ["engineering_team", "inspection_team"],
    road_blocked: ["engineering_team", "road_clearance"],
    water_supply: ["water_tanker", "water_supply", "supply_vehicle"],
    food_supply: ["food_delivery", "food_supply", "supply_vehicle"],
  };

  return (compatibleTypes[incidentType] ?? []).includes(resourceType);
}


export function buildResponsePlan(
  incidents: Incident[],
  resources: Resource[],
  conflicts: Conflict[]
): ResponsePlan {
  const rankedIncidents = incidents
    .map((incident) => scoreIncident(incident, conflicts))
    .sort((a, b) => b.score - a.score);

  const availableResources = resources
    .filter(isResourceAvailable)
    .sort(
      (a, b) => Number(b.capacity ?? 0) - Number(a.capacity ?? 0)
    );

  const assignments: ResourceAssignment[] = [];
  const assignedResourceIds = new Set<string>();
  const assignedIncidentIds = new Set<string>();
  const warnings: string[] = [];

  for (const incident of rankedIncidents) {
    if ((incident.peopleAtRisk ?? 0) <= 0) {
      warnings.push(
        `Incident ${incident.incidentId}: affected-person count is unknown or zero; resource allocation requires human review.`
      );
      continue;
    }

    const resource = availableResources.find(
  (item) =>
    !assignedResourceIds.has(item.id) &&
    Number(item.capacity ?? 0) > 0 &&
    isResourceCompatible(incident.type, item)
);

    if (!resource) {
      warnings.push(
        `Incident ${incident.incidentId}: no available resource could be assigned.`
      );
      continue;
    }

    const peopleCovered = Math.min(
      incident.peopleAtRisk ?? 0,
      Number(resource.capacity ?? 0)
    );

    assignments.push({
      incidentId: incident.incidentId,
      resourceId: resource.id,
      peopleCovered,
      requiresHumanApproval: true,
    });

    assignedResourceIds.add(resource.id);
    assignedIncidentIds.add(incident.incidentId);

    if (peopleCovered < (incident.peopleAtRisk ?? 0)) {
      warnings.push(
        `Incident ${incident.incidentId}: partial coverage only (${peopleCovered} of ${incident.peopleAtRisk} people).`
      );
    }
  }

  for (const conflict of conflicts) {
    if (!conflict.resolved) {
      warnings.push(
        `Unresolved ${conflict.kind} conflict at place ${conflict.placeId}; review before approval.`
      );
    }
  }

  for (const incident of rankedIncidents) {
    if (incident.freshness === "stale") {
      warnings.push(
        `Incident ${incident.incidentId} has stale information.`
      );
    }
  }

  const unassignedIncidents = rankedIncidents
    .filter((incident) => !assignedIncidentIds.has(incident.incidentId))
    .map((incident) => incident.incidentId);

  const unassignedResources = availableResources
    .filter((resource) => !assignedResourceIds.has(resource.id))
    .map((resource) => resource.id);

  return {
    generatedAt: new Date().toISOString(),
    planningMode: "rule_based_explainable",
    requiresHumanApproval: true,
    priorityMethod:
      "Illustrative weighted score: severity 40, affected people 30, freshness 20, source reliability 10. Scores are advisory and require human review.",
    rankedIncidents,
    assignments,
    unassignedIncidents,
    unassignedResources,
    warnings,
  };
}
