
import express from "express";
import cors from "cors";
import { buildResponsePlan } from "./planner";
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

app.use(cors({ origin: "http://localhost:5173" }));
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

function broadcastState() {
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

// -------------------- OFFLINE REPORT PERSISTENCE --------------------

const offlineStatePath = path.join(process.cwd(), "data", "offline-state.json");

function saveOfflineReports(): void {
  fs.mkdirSync(path.dirname(offlineStatePath), { recursive: true });
  fs.writeFileSync(
    offlineStatePath,
    JSON.stringify({ reports: appState.reports }, null, 2),
    "utf-8"
  );
}

function loadOfflineReports(): Report[] {
  if (!fs.existsSync(offlineStatePath)) return [];

  const parsed = JSON.parse(fs.readFileSync(offlineStatePath, "utf-8"));
  return Array.isArray(parsed.reports) ? parsed.reports : [];
}
// -------------------- ADD REPORT --------------------

function addReport(input: any): Report {
  if (
    !input ||
    typeof input.rawText !== "string" ||
    !input.rawText.trim() ||
    typeof input.placeId !== "string" ||
    !appState.places.some((place) => place.id === input.placeId)
  ) {
    throw new Error("Valid rawText and placeId are required.");
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
      typeof input.source === "string" && input.source.trim()
        ? input.source.trim()
        : "citizen",

    eventTime:
      typeof input.eventTime === "string" &&
      !Number.isNaN(Date.parse(input.eventTime))
        ? input.eventTime
        : now,

    receivedAt: now
  };

  if (appState.reports.some((existing) => existing.id === report.id)) {
    throw new Error("Duplicate report ID.");
  }

  // Save the original report for traceability.
  appState.reports.push(report);


  // Process the report using the verification pipeline.
  processReport(
    report,
    appState.incidents,
    appState.agentEvents,
    appState.conflicts
  );

  // Persist the report after successful processing.
  saveOfflineReports();

  // Notify connected frontend clients.
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

app.post("/api/scenario/load", (_req, res) => {
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

    const savedReports = loadOfflineReports();
    // Reset state before loading a fresh scenario.
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

    // Validate and process each report through the same pipeline.
    for (const report of scenario.reports || []) {
      addReport(report);
    }

    
    // Restore saved reports after scenario places are available.
    for (const report of savedReports) {
      if (appState.reports.some((existing) => existing.id === report.id)) continue;
      if (!appState.places.some((place) => place.id === report.placeId)) continue;
      addReport(report);
    }

    saveOfflineReports();
    broadcastState();

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

// -------------------- GET AGENT AUDIT LOG --------------------

app.get("/api/agent-events", (_req, res) => {
  res.json(appState.agentEvents);
});

function getCurrentPlan() {
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

  res.json({
    success: true,
    message: "New plan proposed. Human approval is required.",
    plan: currentPlan
  });
});

// Explicit human approval.
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

    // Do not approve a plan containing unresolved conflicts.
    const unresolvedConflicts = appState.conflicts.filter(
      conflict => !conflict.resolved
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
      message: "Plan approved. No rescue team was automatically dispatched.",
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

// -------------------- SERVER START --------------------

// -------------------- STARTUP STATE INITIALIZATION --------------------

function initializeOfflineState(): void {
  const scenarioPath = path.join(process.cwd(), "data", "scenario.json");

  if (!fs.existsSync(scenarioPath)) {
    throw new Error(`Scenario file not found: ${scenarioPath}`);
  }

  const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf-8"));

  if (!Array.isArray(scenario.places)) {
    throw new Error("Scenario must contain a places array.");
  }

  appState = {
    reports: [],
    incidents: [],
    resources: Array.isArray(scenario.resources) ? scenario.resources : [],
    places: scenario.places,
    agentEvents: [],
    conflicts: []
  };

  const savedReports = loadOfflineReports();
  // Process base scenario reports first.
  for (const report of scenario.reports || []) {
    addReport(report);
  }

  // Restore saved reports that aren't already in the base scenario.
  for (const report of savedReports) {
    if (appState.reports.some((existing) => existing.id === report.id)) continue;
    if (!appState.places.some((place) => place.id === report.placeId)) continue;
    addReport(report);
  }

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






