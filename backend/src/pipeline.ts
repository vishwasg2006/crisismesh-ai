
import { randomUUID } from "crypto";

export type Report = {
  id: string;
  placeId: string;
  rawText: string;
  source: string;
  eventTime: string;
  receivedAt: string;
};

export type Incident = {
  id: string;
  placeId: string;
  type: string;
  peopleAtRisk: number | null;
  reportIds: string[];
  confidence: number;
  flags: string[];
  followUpQuestions: string[];
  bridgeStatus?: string;
  sourceTypes: string[];
  sourceReliability: number;
  freshness: "fresh" | "aging" | "stale";
  lastEventTime: string;
};

export type Conflict = {
  id: string;
  incidentId: string;
  placeId: string;
  kind: "bridge_status" | "headcount";
  description: string;
  reportIds: string[];
  createdAt: string;
  resolved: boolean;
};

export type AgentEvent = {
  id: string;
  agent: string;
  message: string;
  timestamp: string;
};

const SOURCE_RELIABILITY: Record<string, number> = {
  official: 0.95,
  sensor: 0.95,
  field_team: 0.85,
  volunteer: 0.7,
  citizen: 0.55,
  anonymous: 0.35,
  unknown: 0.5,
};

function normalizeSource(source: string): string {
  const value = source.trim().toLowerCase().replace(/[\s-]+/g, "_");

  if (value.includes("official")) return "official";
  if (value.includes("sensor")) return "sensor";
  if (value.includes("field")) return "field_team";
  if (value.includes("volunteer")) return "volunteer";
  if (value.includes("anonymous")) return "anonymous";
  if (value.includes("citizen") || value.includes("resident")) {
    return "citizen";
  }

  return SOURCE_RELIABILITY[value] !== undefined ? value : "unknown";
}

function getReliability(source: string): number {
  return SOURCE_RELIABILITY[normalizeSource(source)] ?? 0.5;
}

function getFreshness(
  eventTime: string,
  now = Date.now()
): "fresh" | "aging" | "stale" {
  const timestamp = Date.parse(eventTime);

  if (!Number.isFinite(timestamp)) return "stale";

  const ageMinutes = Math.max(0, (now - timestamp) / 60_000);

  if (ageMinutes <= 30) return "fresh";
  if (ageMinutes <= 120) return "aging";
  return "stale";
}

function extractPeopleAtRisk(text: string): number | null {
  const patterns = [
    /(\d{1,6})\s+(?:people|persons|person|residents|victims|families|children|patients)\b/i,
    /\b(?:people|persons|residents|victims|families|children|patients)\s*[:=]\s*(\d{1,6})\b/i,
    /\b(\d{1,6})\s+(?:people|persons|residents)\s+(?:are|were|remain|stuck|trapped|stranded|affected)\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }

  return null;
}

function classifyReport(
  text: string
): { type: string; confidence: number } {
  const value = text.toLowerCase();

  if (
    /\b(trapped|stranded|stuck|people on roof|people on rooftop|cannot escape|can't escape)\b/.test(
      value
    )
  ) {
    return { type: "people_trapped", confidence: 0.9 };
  }

  if (
    /\b(medical emergency|injured|injury|ambulance|urgent medicine|medical help|patient critical)\b/.test(
      value
    )
  ) {
    return { type: "medical", confidence: 0.88 };
  }

  if (
    /\b(hospital|clinic|nursing home|care home|school|shelter)\b/.test(value) &&
    /\b(flood|water|damaged|blocked|danger|evacuat|cut off|cutoff)\b/.test(
      value
    )
  ) {
    return { type: "at_risk_facility", confidence: 0.8 };
  }

  if (
    /\b(bridge|overpass|culvert)\b/.test(value) &&
    /\b(damaged|collapsed|collapse|unsafe|washed away|broken|inundated)\b/.test(
      value
    )
  ) {
    return { type: "bridge_damaged", confidence: 0.85 };
  }

  if (
    /\b(road|street|highway|route|path)\b/.test(value) &&
    /\b(blocked|closed|impassable|washed away|submerged|inaccessible)\b/.test(
      value
    )
  ) {
    return { type: "road_blocked", confidence: 0.82 };
  }

  if (
    /\b(drinking water|water supply|clean water|no water|water shortage)\b/.test(
      value
    )
  ) {
    return { type: "water_supply", confidence: 0.8 };
  }

  if (
    /\b(food shortage|no food|food supply|need food|hungry|ration)\b/.test(
      value
    )
  ) {
    return { type: "food_supply", confidence: 0.8 };
  }

  if (
    /\b(flood|flooded|flooding|rising water|water level|heavy rain|inundat)\b/.test(
      value
    )
  ) {
    return { type: "unknown", confidence: 0.55 };
  }

  return { type: "unknown", confidence: 0.35 };
}

function addEvent(
  events: AgentEvent[],
  agent: string,
  message: string
): void {
  events.push({
    id: randomUUID(),
    agent,
    message,
    timestamp: new Date().toISOString(),
  });
}

function addFlag(incident: Incident, flag: string): void {
  if (!incident.flags.includes(flag)) {
    incident.flags.push(flag);
  }
}

function recordConflict(
  conflicts: Conflict[],
  incident: Incident,
  kind: Conflict["kind"],
  description: string,
  reportIds: string[]
): void {
  const existing = conflicts.find(
    (conflict) =>
      !conflict.resolved &&
      conflict.incidentId === incident.id &&
      conflict.kind === kind &&
      conflict.description === description
  );

  if (existing) {
    existing.reportIds = Array.from(
      new Set([...existing.reportIds, ...reportIds])
    );
    return;
  }

  conflicts.push({
    id: randomUUID(),
    incidentId: incident.id,
    placeId: incident.placeId,
    kind,
    description,
    reportIds: Array.from(new Set(reportIds)),
    createdAt: new Date().toISOString(),
    resolved: false,
  });
}

function updateFollowUpQuestions(incident: Incident): void {
  const questions: string[] = [];

  if (incident.peopleAtRisk === null) {
    if (
      [
        "people_trapped",
        "medical",
        "water_supply",
        "food_supply",
        "at_risk_facility",
      ].includes(incident.type)
    ) {
      questions.push("How many people are affected or at risk?");
    }
  }

  if (incident.type === "bridge_damaged" && !incident.bridgeStatus) {
    questions.push("Is the bridge confirmed unsafe or completely impassable?");
  }

  if (incident.freshness === "stale") {
    questions.push("Can a responder confirm whether this situation is current?");
  }

  incident.followUpQuestions = questions;
}

export function processReport(
  report: Report,
  incidents: Incident[],
  events: AgentEvent[],
  conflicts: Conflict[]
): Incident {
  const text = report.rawText.trim();
  const classification = classifyReport(text);
  const reportedPeople = extractPeopleAtRisk(text);
  const reliability = getReliability(report.source);
  const freshness = getFreshness(report.eventTime);

  // Merge with an existing incident at the same place and of the same type.
  let incident = incidents.find(
    (item) =>
      item.placeId === report.placeId &&
      item.type === classification.type
  );

  if (!incident) {
    incident = {
      id: randomUUID(),
      placeId: report.placeId,
      type: classification.type,
      peopleAtRisk: reportedPeople,
      reportIds: [],
      confidence: classification.confidence,
      flags: [],
      followUpQuestions: [],
      sourceTypes: [],
      sourceReliability: reliability,
      freshness,
      lastEventTime: report.eventTime,
    };

    incidents.push(incident);

    addEvent(
      events,
      "Incident Analysis",
      `Created ${incident.type} incident at place ${incident.placeId}.`
    );
  } else {
    addEvent(
      events,
      "Verification",
      `Matched report ${report.id} with existing incident ${incident.id}.`
    );

    incident.confidence = Math.max(
      incident.confidence,
      classification.confidence
    );

    incident.sourceReliability = Math.max(
      incident.sourceReliability,
      reliability
    );

    // Keep the newest event time and freshness.
    const oldTime = Date.parse(incident.lastEventTime);
    const newTime = Date.parse(report.eventTime);

    if (
      Number.isFinite(newTime) &&
      (!Number.isFinite(oldTime) || newTime > oldTime)
    ) {
      incident.lastEventTime = report.eventTime;
      incident.freshness = getFreshness(report.eventTime);
    }

    // Flag conflicting headcounts rather than silently overwriting them.
    if (
      reportedPeople !== null &&
      incident.peopleAtRisk !== null &&
      reportedPeople !== incident.peopleAtRisk
    ) {
      const description =
        `Conflicting headcounts reported: ${incident.peopleAtRisk} and ${reportedPeople}.`;

      addFlag(incident, "Headcount conflict");
      recordConflict(
        conflicts,
        incident,
        "headcount",
        description,
        [...incident.reportIds, report.id]
      );

      addEvent(events, "Verification", description);
    } else if (
      reportedPeople !== null &&
      incident.peopleAtRisk === null
    ) {
      incident.peopleAtRisk = reportedPeople;
      incident.flags = incident.flags.filter(
        (flag) => flag !== "Headcount unknown"
      );
    }

    // Detect conflicting bridge status reports.
    if (incident.type === "bridge_damaged") {
      const newStatus = /\b(collapsed|washed away)\b/i.test(text)
        ? "collapsed"
        : /\b(unsafe|damaged|broken|impassable)\b/i.test(text)
          ? "damaged_or_unsafe"
          : undefined;

      if (
        newStatus &&
        incident.bridgeStatus &&
        newStatus !== incident.bridgeStatus
      ) {
        const description =
          `Conflicting bridge status reports: ${incident.bridgeStatus} and ${newStatus}.`;

        addFlag(incident, "Bridge status conflict");
        recordConflict(
          conflicts,
          incident,
          "bridge_status",
          description,
          [...incident.reportIds, report.id]
        );

        addEvent(events, "Verification", description);
      } else if (newStatus) {
        incident.bridgeStatus = newStatus;
      }
    }
  }

  if (!incident.reportIds.includes(report.id)) {
    incident.reportIds.push(report.id);
  }

  const normalizedSource = normalizeSource(report.source);

  if (!incident.sourceTypes.includes(normalizedSource)) {
    incident.sourceTypes.push(normalizedSource);
  }

  if (reportedPeople === null && incident.peopleAtRisk === null) {
    addFlag(incident, "Headcount unknown");
  }

  if (freshness === "stale") {
    addFlag(incident, "Report may be stale");
  }

  updateFollowUpQuestions(incident);

  addEvent(
    events,
    "Verification",
    `Processed report ${report.id}; source reliability ${reliability.toFixed(
      2
    )}; freshness ${incident.freshness}.`
  );

  return incident;
}
