const severityWeights = {
    people_trapped: 45,
    medical: 40,
    at_risk_facility: 30,
    bridge_damaged: 25,
    road_blocked: 20,
    unknown: 15
};
function calculatePriority(incident, conflicts) {
    const reasons = [];
    // 1. Base severity: 0–45 points.
    const severity = severityWeights[incident.type] ?? 15;
    let score = severity;
    reasons.push(`Incident severity: +${severity}`);
    // 2. Reported headcount: up to 25 points.
    const headcountScore = Math.min(25, Math.round(Math.max(0, incident.peopleAtRisk) / 2));
    score += headcountScore;
    if (incident.peopleAtRisk > 0) {
        reasons.push(`Reported people at risk: ${incident.peopleAtRisk} (+${headcountScore})`);
    }
    else {
        reasons.push("No headcount confirmed; follow-up may be needed");
    }
    // 3. Freshness: up to 15 points.
    const freshnessScore = {
        fresh: 15,
        aging: 8,
        stale: 0
    };
    const freshnessPoints = freshnessScore[incident.freshness] ?? 0;
    score += freshnessPoints;
    reasons.push(`Report freshness: +${freshnessPoints}`);
    // 4. Source reliability: up to 10 points.
    const reliabilityPoints = Math.round(Math.max(0, Math.min(1, incident.sourceReliability)) * 10);
    score += reliabilityPoints;
    reasons.push(`Source reliability: +${reliabilityPoints}`);
    // 5. Conflicts require human review. They do not erase urgency.
    const activeConflicts = conflicts.filter(conflict => conflict.incidentId === incident.id &&
        !conflict.resolved);
    if (activeConflicts.length > 0) {
        reasons.push(`${activeConflicts.length} unresolved conflict(s): human verification required`);
    }
    // Keep the score in the 0–100 range.
    score = Math.max(0, Math.min(100, score));
    let level;
    if (score >= 75) {
        level = "CRITICAL";
    }
    else if (score >= 55) {
        level = "HIGH";
    }
    else if (score >= 35) {
        level = "MEDIUM";
    }
    else {
        level = "LOW";
    }
    return {
        incidentId: incident.id,
        placeId: incident.placeId,
        type: incident.type,
        score,
        level,
        reasons,
        peopleAtRisk: incident.peopleAtRisk,
        freshness: incident.freshness,
        hasConflict: activeConflicts.length > 0
    };
}
export function buildResponsePlan(incidents, resources, conflicts) {
    // Rank incidents by score, highest first.
    const rankedIncidents = incidents
        .map(incident => calculatePriority(incident, conflicts))
        .sort((a, b) => b.score - a.score);
    // Only allocate resources that are available and have valid capacity.
    const availableResources = resources
        .filter(resource => resource.available === true &&
        Number.isFinite(resource.capacity) &&
        resource.capacity > 0)
        .map(resource => ({ ...resource }))
        .sort((a, b) => b.capacity - a.capacity);
    const assignments = [];
    const assignedIncidentIds = new Set();
    // Demo strategy: at most one boat per incident in this planning round.
    // Human responders can recompute the plan for later rescue rounds.
    for (const resource of availableResources) {
        const nextIncident = rankedIncidents.find(incident => incident.peopleAtRisk > 0 &&
            !assignedIncidentIds.has(incident.incidentId));
        if (!nextIncident)
            break;
        const peopleCovered = Math.min(resource.capacity, nextIncident.peopleAtRisk);
        assignments.push({
            resourceId: resource.id,
            resourceName: resource.name,
            incidentId: nextIncident.incidentId,
            placeId: nextIncident.placeId,
            capacity: resource.capacity,
            peopleAtRisk: nextIncident.peopleAtRisk,
            peopleCovered,
            peopleRemaining: Math.max(0, nextIncident.peopleAtRisk - peopleCovered),
            status: peopleCovered >= nextIncident.peopleAtRisk
                ? "FULL_COVERAGE"
                : "PARTIAL_COVERAGE",
            requiresHumanApproval: true
        });
        assignedIncidentIds.add(nextIncident.incidentId);
    }
    const assignedResourceIds = new Set(assignments.map(assignment => assignment.resourceId));
    const unassignedResources = availableResources.filter(resource => !assignedResourceIds.has(resource.id));
    const unassignedIncidents = rankedIncidents
        .filter(incident => !assignedIncidentIds.has(incident.incidentId))
        .map(incident => ({
        incidentId: incident.incidentId,
        placeId: incident.placeId,
        type: incident.type,
        score: incident.score,
        reason: incident.peopleAtRisk > 0
            ? "No available boat assigned in this planning round."
            : "No confirmed headcount; assess the incident and determine suitable resources."
    }));
    const warnings = [];
    if (rankedIncidents.some(incident => incident.hasConflict)) {
        warnings.push("Unresolved reports conflict. Human verification is required.");
    }
    if (rankedIncidents.some(incident => incident.freshness === "stale")) {
        warnings.push("Some incident reports are stale. Confirm current conditions before dispatch.");
    }
    if (assignments.some(assignment => assignment.status === "PARTIAL_COVERAGE")) {
        warnings.push("Some assigned incidents exceed the allocated boat capacity. Additional rescue rounds or resources may be needed.");
    }
    if (unassignedIncidents.length > 0) {
        warnings.push("Some incidents remain unassigned. A responder must review resource needs.");
    }
    return {
        generatedAt: new Date().toISOString(),
        planningMode: "transparent-rule-based-demo",
        requiresHumanApproval: true,
        priorityMethod: {
            severity: "Up to 45 points",
            reportedHeadcount: "Up to 25 points",
            freshness: "Up to 15 points",
            sourceReliability: "Up to 10 points",
            note: "Demo scoring weights only; validate with emergency-response experts before real-world use."
        },
        rankedIncidents,
        assignments,
        unassignedIncidents,
        unassignedResources,
        warnings
    };
}
