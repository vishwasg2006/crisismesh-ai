import { randomUUID } from "crypto";
const sourceWeights = {
    official: 0.95,
    sensor: 0.95,
    field_team: 0.85,
    volunteer: 0.7,
    citizen: 0.55,
    anonymous: 0.35
};
function getSourceWeight(source) {
    return sourceWeights[source.toLowerCase()] ?? 0.5;
}
function getFreshness(type, eventTime, receivedAt) {
    const parsed = Date.parse(eventTime);
    const received = Date.parse(receivedAt);
    const referenceTime = Number.isFinite(parsed)
        ? parsed
        : Number.isFinite(received)
            ? received
            : Date.now();
    const ageMinutes = Math.max(0, (Date.now() - referenceTime) / 60000);
    // Demo thresholds, not real emergency-response standards.
    const agingAfter = type === "bridge_damaged" || type === "road_blocked"
        ? 120
        : 60;
    const staleAfter = type === "bridge_damaged" || type === "road_blocked"
        ? 240
        : 180;
    if (ageMinutes >= staleAfter)
        return "stale";
    if (ageMinutes >= agingAfter)
        return "aging";
    return "fresh";
}
export function extractReport(report) {
    const text = report.rawText.toLowerCase();
    let type = "unknown";
    // Incident classification
    if (text.includes("bridge") &&
        /(collapsed|damaged|washed away|unsafe|open|closed)/.test(text)) {
        type = "bridge_damaged";
    }
    else if (["road blocked", "road closed", "road flooded"].some(word => text.includes(word))) {
        type = "road_blocked";
    }
    else if ([
        "water shortage",
        "drinking water",
        "need water",
        "needs water",
        "water needed",
        "no clean water",
        "water supply"
    ].some(word => text.includes(word))) {
        type = "water_supply";
    }
    else if ([
        "food shortage",
        "need food",
        "needs food",
        "food needed",
        "no food",
        "food supply"
    ].some(word => text.includes(word))) {
        type = "food_supply";
    }
    else if (["injured", "medical", "ambulance"].some(word => text.includes(word))) {
        type = "medical";
    }
    else if (["trapped", "stuck", "stranded", "roof", "hotel"].some(word => text.includes(word))) {
        type = "people_trapped";
    }
    else if (["hospital", "college", "school"].some(word => text.includes(word))) {
        type = "at_risk_facility";
    }
    // Headcount extraction:
    // Supports "30 people", "12 residents", "patients: 8",
    // and "children 15", for example.
    const numberMatch = text.match(/\b(\d+)\s*(?:people|persons|residents|patients|students|families|children|victims|individuals)\b/) ??
        text.match(/\b(?:people|persons|residents|patients|students|families|children|victims|individuals)\s*[:=]?\s*(\d+)\b/);
    const peopleAtRisk = numberMatch
        ? Number(numberMatch[1])
        : 0;
    // Bridge status extraction
    let bridgeStatus = "unknown";
    if (type === "bridge_damaged") {
        if (/(collapsed|damaged|washed away|unsafe)/.test(text)) {
            bridgeStatus = "collapsed_or_unsafe";
        }
        else if (/\b(open|passable)\b/.test(text)) {
            bridgeStatus = "reported_open";
        }
        else if (/\bclosed\b/.test(text)) {
            bridgeStatus = "reported_closed";
        }
    }
    return {
        type,
        placeId: report.placeId,
        peopleAtRisk,
        bridgeStatus
    };
}
function recordConflict(conflicts, incident, kind, description, reportIds) {
    const existing = conflicts.find(conflict => conflict.incidentId === incident.id &&
        conflict.kind === kind &&
        !conflict.resolved);
    if (existing) {
        existing.description = description;
        for (const id of reportIds) {
            if (!existing.reportIds.includes(id)) {
                existing.reportIds.push(id);
            }
        }
        return;
    }
    conflicts.push({
        id: randomUUID(),
        incidentId: incident.id,
        placeId: incident.placeId,
        kind,
        description,
        reportIds: [...new Set(reportIds)],
        createdAt: new Date().toISOString(),
        resolved: false
    });
}
export function processReport(report, incidents, events, conflicts) {
    const extracted = extractReport(report);
    const weight = getSourceWeight(report.source);
    const freshness = getFreshness(extracted.type, report.eventTime, report.receivedAt);
    events.push({
        id: randomUUID(),
        agent: "Incident Analysis",
        message: `Classified report as ${extracted.type}; headcount: ${extracted.peopleAtRisk || "unknown"}; source weight: ${weight}; freshness: ${freshness}.`,
        timestamp: new Date().toISOString()
    });
    const existing = incidents.find(incident => incident.placeId === extracted.placeId &&
        incident.type === extracted.type);
    if (existing) {
        if (!existing.reportIds.includes(report.id)) {
            existing.reportIds.push(report.id);
        }
        // Flag materially different headcounts for human verification.
        if (existing.peopleAtRisk > 0 &&
            extracted.peopleAtRisk > 0 &&
            existing.peopleAtRisk !== extracted.peopleAtRisk &&
            Math.abs(existing.peopleAtRisk - extracted.peopleAtRisk) >=
                Math.max(5, existing.peopleAtRisk * 0.25)) {
            const description = `Headcount disagreement: ${existing.peopleAtRisk} versus ` +
                `${extracted.peopleAtRisk}. Verify the current number on the ground.`;
            existing.flags.push("Conflicting headcounts");
            recordConflict(conflicts, existing, "headcount", description, existing.reportIds);
            events.push({
                id: randomUUID(),
                agent: "Verification",
                message: description,
                timestamp: new Date().toISOString()
            });
        }
        // Flag bridge status disagreements.
        if (extracted.type === "bridge_damaged" &&
            existing.bridgeStatus &&
            extracted.bridgeStatus !== "unknown" &&
            existing.bridgeStatus !== extracted.bridgeStatus) {
            const description = `Bridge status disagreement: ${existing.bridgeStatus} versus ` +
                `${extracted.bridgeStatus}. Human verification required.`;
            existing.flags.push("Conflicting bridge status");
            recordConflict(conflicts, existing, "bridge_status", description, existing.reportIds);
            events.push({
                id: randomUUID(),
                agent: "Verification",
                message: description,
                timestamp: new Date().toISOString()
            });
        }
        if (extracted.type === "bridge_damaged" &&
            (!existing.bridgeStatus || existing.bridgeStatus === "unknown")) {
            existing.bridgeStatus = extracted.bridgeStatus;
        }
        // Keep the maximum reported count to avoid adding duplicate reports.
        // This is not a verified count of unique people.
        existing.peopleAtRisk = Math.max(existing.peopleAtRisk, extracted.peopleAtRisk);
        const parsedNewTime = Date.parse(report.eventTime);
        const parsedOldTime = Date.parse(existing.lastEventTime);
        // An older report must not make newer information appear fresh.
        if (Number.isFinite(parsedNewTime) &&
            (!Number.isFinite(parsedOldTime) ||
                parsedNewTime > parsedOldTime)) {
            existing.lastEventTime = report.eventTime;
            existing.freshness = freshness;
        }
        if (!existing.sourceTypes.includes(report.source)) {
            existing.sourceTypes.push(report.source);
        }
        const weights = existing.sourceTypes.map(getSourceWeight);
        existing.sourceReliability =
            weights.reduce((sum, value) => sum + value, 0) /
                weights.length;
        existing.confidence = Math.min(0.95, 0.5 + (existing.reportIds.length - 1) * 0.15);
        if (existing.freshness === "stale") {
            existing.flags.push("Latest report is stale");
        }
        else if (existing.freshness === "aging") {
            existing.flags.push("Latest report is aging");
        }
        // Ask for a count when a new incident still has no known headcount.
        if (existing.peopleAtRisk === 0 &&
            !existing.followUpQuestions.includes("How many people are affected?") &&
            ["water_supply", "food_supply", "medical"].includes(extracted.type)) {
            existing.flags.push("Headcount unknown");
            existing.followUpQuestions.push("How many people are affected?");
        }
        events.push({
            id: randomUUID(),
            agent: "Verification",
            message: `Merged report ${report.id} into incident ${existing.id}. Conflicts remain visible for human review.`,
            timestamp: new Date().toISOString()
        });
        return existing;
    }
    const flags = [];
    const followUpQuestions = [];
    if (extracted.type === "unknown") {
        flags.push("Incident type unclear");
        followUpQuestions.push("What exactly happened and where?");
    }
    if (extracted.type === "people_trapped" &&
        extracted.peopleAtRisk === 0) {
        flags.push("Headcount unknown");
        followUpQuestions.push("How many people require rescue?");
    }
    if (["water_supply", "food_supply", "medical"].includes(extracted.type) &&
        extracted.peopleAtRisk === 0) {
        flags.push("Headcount unknown");
        followUpQuestions.push("How many people are affected?");
    }
    if (extracted.type === "bridge_damaged" &&
        extracted.bridgeStatus === "unknown") {
        flags.push("Bridge status unclear");
        followUpQuestions.push("Is the bridge collapsed, closed, unsafe, or passable?");
    }
    if (freshness === "stale") {
        flags.push("Report is stale");
        followUpQuestions.push("Can someone verify the current situation?");
    }
    else if (freshness === "aging") {
        flags.push("Report is aging");
        followUpQuestions.push("Can the reported situation be reconfirmed?");
    }
    const incident = {
        id: randomUUID(),
        placeId: extracted.placeId,
        type: extracted.type,
        peopleAtRisk: extracted.peopleAtRisk,
        reportIds: [report.id],
        confidence: 0.5 * weight + 0.25,
        flags: [...new Set(flags)],
        followUpQuestions,
        bridgeStatus: extracted.bridgeStatus,
        sourceTypes: [report.source],
        sourceReliability: weight,
        freshness,
        lastEventTime: report.eventTime
    };
    incidents.push(incident);
    events.push({
        id: randomUUID(),
        agent: "Verification",
        message: `Created incident ${incident.id}; freshness: ${freshness}; follow-up questions: ${followUpQuestions.length}.`,
        timestamp: new Date().toISOString()
    });
    return incident;
}
