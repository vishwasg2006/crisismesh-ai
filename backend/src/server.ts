
import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";

import {
  createTrackedPlan,
  approveTrackedPlan,
  TrackedPlan
} from "./approval";

import {
  processReport,
  Report,
  Incident,
  AgentEvent,
  Conflict
} from "./pipeline";

const app = express();

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:5500",
    ],
    credentials: true,
  })
);
app.use(express.json());

const server = createServer(app);

const wss = new WebSocketServer({
  server,
  path: "/ws"
});

// -------------------- APP STATE --------------------

type AppState = {
  reports: Report[];
  incidents: Incident[];
  resources: any[];
  places: any[];
  agentEvents: AgentEvent[];
  conflicts: Conflict[];
};

let appState: AppState = {
  reports: [],
  incidents: [],
  resources: [],
  places: [],
  agentEvents: [],
  conflicts: []
};

let currentPlan: TrackedPlan | null = null;

// -------------------- WEBSOCKET BROADCAST --------------------

function broadcastState(): void {
  const message = JSON.stringify({
    type: "STATE_UPDATE",
    data: appState
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// -------------------- OFFLINE STATE PERSISTENCE --------------------

const offlineStatePath = path.join(
  process.cwd(),
  "data",
  "offline-state.json"
);

function saveOfflineReports(): void {
  fs.mkdirSync(path.dirname(offlineStatePath), {
    recursive: true
  });

  fs.writeFileSync(
    offlineStatePath,
    JSON.stringify(
      {
        reports: appState.reports,
        conflicts: appState.conflicts
      },
      null,
      2
    ),
    "utf-8"
  );
}

function loadOfflineState(): {
  reports: Report[];
  conflicts: Conflict[];
} {
  if (!fs.existsSync(offlineStatePath)) {
    return {
      reports: [],
      conflicts: []
    };
  }

  const parsed = JSON.parse(
    fs.readFileSync(offlineStatePath, "utf-8")
  );

  return {
    reports: Array.isArray(parsed.reports)
      ? parsed.reports
      : [],
    conflicts: Array.isArray(parsed.conflicts)
      ? parsed.conflicts
      : []
  };
}

// Restore human decisions after conflicts are rebuilt from reports.
// Matching uses the location, conflict type, description and report IDs.
function restoreConflictResolutions(
  savedConflicts: Conflict[]
): void {
  for (const savedConflict of savedConflicts) {
    if (!savedConflict.resolved) continue;

    const savedReportIds = [...savedConflict.reportIds].sort();

    const currentConflict = appState.conflicts.find(
      (conflict) => {
        const currentReportIds = [...conflict.reportIds].sort();

        return (
          conflict.placeId === savedConflict.placeId &&
          conflict.kind === savedConflict.kind &&
          conflict.description === savedConflict.description &&
          currentReportIds.length === savedReportIds.length &&
          currentReportIds.every(
            (id, index) => id === savedReportIds[index]
          )
        );
      }
    );

    if (currentConflict) {
      currentConflict.resolved = true;
      currentConflict.resolvedAt = savedConflict.resolvedAt;
      currentConflict.resolvedBy = savedConflict.resolvedBy;
      currentConflict.resolutionNote =
        savedConflict.resolutionNote;
    }
  }
}

// -------------------- ADD REPORT --------------------

function addReport(input: any): Report {
  if (
    !input ||
    typeof input.rawText !== "string" ||
    !input.rawText.trim() ||
    typeof input.placeId !== "string" ||
    !appState.places.some(
      (place) => place.id === input.placeId
    )
  ) {
    throw new Error(
      "Valid rawText and placeId are required."
    );
  }

  const now = new Date().toISOString();

  const report: Report = {
    id:
      typeof input.id === "string" && input.id.trim()
        ? input.id
        : randomUUID(),

    placeId: input.placeId,
    rawText: input.rawText.trim(),

    source:
      typeof input.source === "string" &&
      input.source.trim()
        ? input.source.trim()
        : "citizen",

    eventTime:
      typeof input.eventTime === "string" &&
      !Number.isNaN(Date.parse(input.eventTime))
        ? input.eventTime
        : now,

    receivedAt: now
  };

  if (
    appState.reports.some(
      (existing) => existing.id === report.id
    )
  ) {
    throw new Error("Duplicate report ID.");
  }

  // Preserve the original report for traceability.
  appState.reports.push(report);

  // Process the report through the verification pipeline.
  processReport(
    report,
    appState.incidents,
    appState.agentEvents,
    appState.conflicts
  );

  saveOfflineReports();
  broadcastState();

  return report;
}

// -------------------- HEALTH CHECK --------------------

app.get("/", (_req, res) => {
  res.json({
    project: "CrisisMesh AI",
    status: "Backend running",
    version: "1.0.0"
  });
});

// -------------------- GET COMPLETE STATE --------------------

app.get("/api/state", (_req, res) => {
  res.json(appState);
});

// -------------------- LOAD FLOOD SCENARIO --------------------

app.post("/api/scenario/load", (req, res) => {
  try {
    const filePath = path.join(
      process.cwd(),
      "data",
      "scenario.json"
    );

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: `Scenario file not found: ${filePath}`
      });
    }

    const scenario = JSON.parse(
      fs.readFileSync(filePath, "utf-8")
    );

    if (!Array.isArray(scenario.places)) {
      return res.status(400).json({
        success: false,
        message: "Scenario must contain a places array."
      });
    }

    // Snapshot persisted data before addReport writes to disk.
    const savedState = loadOfflineState();

    appState = {
      reports: [],
      incidents: [],
      resources: Array.isArray(scenario.resources)
        ? scenario.resources
        : [],
      places: scenario.places,
      agentEvents: [],
      conflicts: []
    };

    // Process scenario reports first.
    for (const report of scenario.reports || []) {
      addReport(report);
    }

    // Restore previously submitted reports.
    for (const report of savedState.reports) {
      if (
        appState.reports.some(
          (existing) => existing.id === report.id
        )
      ) {
        continue;
      }

      if (
        !appState.places.some(
          (place) => place.id === report.placeId
        )
      ) {
        continue;
      }

      addReport(report);
    }

    // Restore human conflict decisions after rebuilding conflicts.
    restoreConflictResolutions(savedState.conflicts);

    saveOfflineReports();
    broadcastState();

    // Plans must be regenerated against the loaded state.
    currentPlan = null;

    return res.json({
      success: true,
      message: "Scenario loaded and processed successfully.",
      summary: {
        reports: appState.reports.length,
        incidents: appState.incidents.length,
        conflicts: appState.conflicts.length,
        resources: appState.resources.length,
        places: appState.places.length
      },
      state: appState
    });
  } catch (error) {
    console.error("Scenario loading failed:", error);

    return res.status(500).json({
      success: false,
      message:
        error instanceof Error
          ? error.message
          : "Failed to load scenario."
    });
  }
});

// -------------------- SUBMIT A NEW REPORT --------------------

app.post("/api/reports", (req, res) => {
  try {
    const report = addReport(req.body);

    // New reports can change incident priorities.
    currentPlan = null;

    return res.status(201).json({
      success: true,
      message: "Report received and processed.",
      report,
      incidents: appState.incidents,
      conflicts: appState.conflicts
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message:
        error instanceof Error
          ? error.message
          : "Invalid report."
    });
  }
});

// -------------------- GET INCIDENTS --------------------

app.get("/api/incidents", (_req, res) => {
  res.json(appState.incidents);
});

// -------------------- GET CONFLICTS --------------------

app.get("/api/conflicts", (_req, res) => {
  res.json(appState.conflicts);
});

// -------------------- RESOLVE A CONFLICT --------------------

app.post("/api/conflicts/:id/resolve", (req, res) => {
  try {
    const conflictId = req.params.id;

    const conflict = appState.conflicts.find(
      (item) => item.id === conflictId
    );

    if (!conflict) {
      return res.status(404).json({
        success: false,
        message: "Conflict not found."
      });
    }

    if (conflict.resolved) {
      return res.status(409).json({
        success: false,
        message: "This conflict has already been resolved.",
        conflict
      });
    }

    const reviewer =
      typeof req.body?.reviewer === "string"
        ? req.body.reviewer.trim()
        : "";

    const note =
      typeof req.body?.note === "string"
        ? req.body.note.trim()
        : "";

    if (!reviewer || !note) {
      return res.status(400).json({
        success: false,
        message:
          "Both reviewer and a resolution note are required."
      });
    }

    if (reviewer.length > 100 || note.length > 1000) {
      return res.status(400).json({
        success: false,
        message:
          "Reviewer must be at most 100 characters and note at most 1000 characters."
      });
    }

    const now = new Date().toISOString();

    // Record the review decision. Original reports are unchanged.
    conflict.resolved = true;
    conflict.resolvedAt = now;
    conflict.resolvedBy = reviewer;
    conflict.resolutionNote = note;

    appState.agentEvents.push({
      id: randomUUID(),
      agent: "Human Conflict Review",
      message:
        `Conflict ${conflict.id} reviewed by ${reviewer}. ` +
        `Decision note: ${note}. ` +
        "Original reports were retained.",
      timestamp: now
    });

    // Persist the decision and refresh connected clients.
    saveOfflineReports();

    // Existing proposals may no longer reflect current state.
    currentPlan = null;

    broadcastState();

    return res.json({
      success: true,
      message:
        "Conflict resolution recorded. Review does not independently verify the reports.",
      conflict
    });
  } catch (error) {
    console.error("Conflict resolution failed:", error);

    return res.status(500).json({
      success: false,
      message:
        error instanceof Error
          ? error.message
          : "Failed to resolve conflict."
    });
  }
});


/* -------------------- REOPEN A CONFLICT -------------------- */

app.post("/api/conflicts/:id/reopen", (req, res) => {
  try {
    const conflict = appState.conflicts.find(
      (item) => item.id === req.params.id
    );

    if (!conflict) {
      return res.status(404).json({
        success: false,
        message: "Conflict not found."
      });
    }

    if (!conflict.resolved) {
      return res.status(409).json({
        success: false,
        message: "This conflict is already open.",
        conflict
      });
    }

    const reviewer =
      typeof req.body?.reviewer === "string"
        ? req.body.reviewer.trim()
        : "";

    const note =
      typeof req.body?.note === "string"
        ? req.body.note.trim()
        : "";

    if (!reviewer || !note) {
      return res.status(400).json({
        success: false,
        message: "Reviewer and reopening reason are required."
      });
    }

    if (reviewer.length > 100 || note.length > 1000) {
      return res.status(400).json({
        success: false,
        message: "Reviewer must be at most 100 characters and note at most 1000 characters."
      });
    }

    const now = new Date().toISOString();

    // Reopen the conflict without changing its original reports.
    conflict.resolved = false;
    conflict.resolvedAt = undefined;
    conflict.resolvedBy = undefined;
    conflict.resolutionNote = undefined;

    appState.agentEvents.push({
      id: randomUUID(),
      agent: "Human Conflict Review",
      message:
        `Conflict ${conflict.id} reopened by ${reviewer}. ` +
        `Reason: ${note}. Original reports were retained.`,
      timestamp: now
    });

    // Persist the reopened status.
    saveOfflineReports();

    // Require a fresh plan based on the current conflict state.
    currentPlan = null;

    broadcastState();

    return res.json({
      success: true,
      message: "Conflict reopened. Human review is required again.",
      conflict
    });
  } catch (error) {
    console.error("Conflict reopening failed:", error);

    return res.status(500).json({
      success: false,
      message:
        error instanceof Error
          ? error.message
          : "Failed to reopen conflict."
    });
  }
});


// -------------------- GET AGENT AUDIT LOG --------------------

app.get("/api/agent-events", (_req, res) => {
  res.json(appState.agentEvents);
});

// -------------------- PLAN MANAGEMENT --------------------

function getCurrentPlan(): TrackedPlan {
  if (!currentPlan) {
    currentPlan = createTrackedPlan(
      appState.incidents,
      appState.resources,
      appState.conflicts
    );
  }

  return currentPlan;
}

// Get the current tracked plan.
app.get("/api/plan", (_req, res) => {
  res.json(getCurrentPlan());
});

// Generate a new proposal.
app.post("/api/plan/recompute", (_req, res) => {
  currentPlan = createTrackedPlan(
    appState.incidents,
    appState.resources,
    appState.conflicts
  );

  broadcastState();

  return res.json({
    success: true,
    message: "New plan proposed. Human approval is required.",
    plan: currentPlan
  });
});

// -------------------- HUMAN PLAN APPROVAL --------------------

app.post("/api/plan/approve", (req, res) => {
  try {
    const plan = getCurrentPlan();

    if (plan.status === "APPROVED") {
      return res.status(409).json({
        success: false,
        message: "This plan has already been approved."
      });
    }

    const approver =
      typeof req.body?.approver === "string"
        ? req.body.approver.trim()
        : "";

    const note =
      typeof req.body?.note === "string"
        ? req.body.note.trim()
        : "";

    if (!approver) {
      return res.status(400).json({
        success: false,
        message: "An approver identifier is required."
      });
    }

    // Block approval while any conflict remains unresolved.
    const unresolvedConflicts = appState.conflicts.filter(
      (conflict) => !conflict.resolved
    );

    if (unresolvedConflicts.length > 0) {
      return res.status(409).json({
        success: false,
        message:
          "Resolve or explicitly review all report conflicts before approval.",
        unresolvedConflicts
      });
    }

    const approvedPlan = approveTrackedPlan(
      plan,
      approver,
      note,
      appState.agentEvents
    );

    broadcastState();

    return res.json({
      success: true,
      message:
        "Plan approved. No rescue team was automatically dispatched.",
      plan: approvedPlan
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message:
        error instanceof Error
          ? error.message
          : "Plan approval failed."
    });
  }
});

// -------------------- WEBSOCKET CONNECTION --------------------

wss.on("connection", (socket) => {
  console.log("Frontend connected through WebSocket.");

  socket.send(
    JSON.stringify({
      type: "STATE_UPDATE",
      data: appState
    })
  );

  socket.on("error", (error) => {
    console.error("WebSocket error:", error.message);
  });
});

// -------------------- STARTUP STATE INITIALIZATION --------------------

function initializeOfflineState(): void {
  const scenarioPath = path.join(
    process.cwd(),
    "data",
    "scenario.json"
  );

  if (!fs.existsSync(scenarioPath)) {
    throw new Error(
      `Scenario file not found: ${scenarioPath}`
    );
  }

  const scenario = JSON.parse(
    fs.readFileSync(scenarioPath, "utf-8")
  );

  if (!Array.isArray(scenario.places)) {
    throw new Error("Scenario must contain a places array.");
  }

  // Load saved data before replaying reports.
  const savedState = loadOfflineState();

  appState = {
    reports: [],
    incidents: [],
    resources: Array.isArray(scenario.resources)
      ? scenario.resources
      : [],
    places: scenario.places,
    agentEvents: [],
    conflicts: []
  };

  // Rebuild state from the original scenario.
  for (const report of scenario.reports || []) {
    addReport(report);
  }

  // Replay additional saved reports.
  for (const report of savedState.reports) {
    if (
      appState.reports.some(
        (existing) => existing.id === report.id
      )
    ) {
      continue;
    }

    if (
      !appState.places.some(
        (place) => place.id === report.placeId
      )
    ) {
      continue;
    }

    addReport(report);
  }

  // Restore resolutions after conflicts have been reconstructed.
  restoreConflictResolutions(savedState.conflicts);

  saveOfflineReports();
}

const PORT = Number(process.env.PORT) || 5000;

initializeOfflineState();

server.listen(PORT, () => {
  console.log("------------------------------------");
  console.log("       CrisisMesh AI Backend");
  console.log("------------------------------------");
  console.log(`Server:       http://localhost:${PORT}`);
  console.log(`State:        http://localhost:${PORT}/api/state`);
  console.log(`Incidents:    http://localhost:${PORT}/api/incidents`);
  console.log(`Conflicts:    http://localhost:${PORT}/api/conflicts`);
  console.log(`Agent Events: http://localhost:${PORT}/api/agent-events`);
  console.log(`WebSocket:    ws://localhost:${PORT}/ws`);
  console.log("------------------------------------");
});
