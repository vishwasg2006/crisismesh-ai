
"use strict";

// ============================================================
// CRISISMESH AI — FRONTEND CONTROLLER
// Backend: http://localhost:5000
// Frontend: http://localhost:5500
// ============================================================

const API_BASE = "http://localhost:5000";
const REFRESH_INTERVAL = 15000;

let dashboardState = {};
let currentPlan = null;
let currentIncidents = [];
let currentConflicts = [];
let currentEvents = [];
let currentView = "overview";
let refreshTimer = null;
let isRefreshing = false;

const VIEW_INFO = {
  overview: {
    title: "Command Center",
    eyebrow: "DISASTER RESPONSE OVERVIEW",
    description:
      "A unified view of incoming incidents, response priorities, and available resources."
  },
  incidents: {
    title: "Incident Intelligence",
    eyebrow: "SITUATIONAL AWARENESS",
    description:
      "Review ranked incidents, priority scores, and reported conditions."
  },
  resources: {
    title: "Resource Planning",
    eyebrow: "LOGISTICS AND COVERAGE",
    description:
      "Inspect proposed allocations, available resources, and coverage gaps."
  },
  conflicts: {
    title: "Conflict Review",
    eyebrow: "HUMAN VERIFICATION",
    description:
      "Review conflicting reports and record verification notes."
  },
  approval: {
    title: "Plan Approval",
    eyebrow: "HUMAN DECISION CONTROL",
    description:
      "Review the proposed plan before recording an authorized decision."
  },
  activity: {
    title: "Activity Log",
    eyebrow: "SYSTEM TRACEABILITY",
    description:
      "Inspect recorded backend events and recent system activity."
  }
};

// ============================================================
// BASIC HELPERS
// ============================================================

function $(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value ?? "—";
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? number.toLocaleString()
    : "—";
}

function formatDate(value) {
  if (!value) return "Time unavailable";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function firstDefined(...values) {
  return values.find(
    value => value !== undefined && value !== null
  );
}

function getArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }

  return [];
}

function getObject(...values) {
  for (const value of values) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      return value;
    }
  }

  return {};
}

function getIncidentId(incident) {
  return firstDefined(
    incident?.id,
    incident?.incidentId,
    incident?._id,
    "unknown"
  );
}

function getIncidentTitle(incident) {
  return firstDefined(
    incident?.title,
    incident?.type,
    incident?.category,
    incident?.incidentType,
    incident?.description,
    "Reported incident"
  );
}

function getLocation(incident) {
  const location = incident?.location;

  if (typeof location === "string") {
    return location;
  }

  if (location && typeof location === "object") {
    return firstDefined(
      location.name,
      location.label,
      location.placeId,
      location.id,
      "Unknown location"
    );
  }

  return firstDefined(
    incident?.placeId,
    incident?.locationName,
    incident?.place,
    "Unknown location"
  );
}

function getPeopleCount(incident) {
  const value = firstDefined(
    incident?.affectedPeople,
    incident?.peopleAffected,
    incident?.peopleAtRisk,
    incident?.peopleCount,
    incident?.headcount,
    incident?.reportedCount,
    incident?.people
  );

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return "Unknown";
  }

  if (typeof value === "object") {
    return firstDefined(
      value.count,
      value.total,
      "Unknown"
    );
  }

  return value;
}

function getPriorityScore(incident) {
  const value = firstDefined(
    incident?.score,
    incident?.priorityScore,
    incident?.matchScore,
    incident?.ranking?.score,
    incident?.priority?.score
  );

  const score = Number(value);

  return Number.isFinite(score) ? score : null;
}

function getPriority(incident) {
  const explicit = firstDefined(
    incident?.priority,
    incident?.level,
    incident?.severityLabel,
    incident?.ranking?.level
  );

  if (typeof explicit === "string") {
    const normalized = explicit.toLowerCase();

    if (normalized.includes("critical")) return "critical";
    if (normalized.includes("high")) return "high";
    if (normalized.includes("medium")) return "medium";
    if (normalized.includes("low")) return "low";
  }

  const score = getPriorityScore(incident);

  if (score !== null) {
    if (score >= 75) return "critical";
    if (score >= 55) return "high";
    if (score >= 35) return "medium";
    return "low";
  }

  return "medium";
}

function priorityLabel(incident) {
  return getPriority(incident).toUpperCase();
}

function isStale(incident) {
  return Boolean(
    incident?.stale ||
    incident?.isStale ||
    incident?.flags?.stale ||
    incident?.freshness?.stale
  );
}

function showToast(message, type = "success") {
  const container = $("toastContainer");

  if (!container) {
    console.log(message);
    return;
  }

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  window.setTimeout(() => toast.remove(), 4500);
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers
    }
  });

  const raw = await response.text();
  let data = {};

  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { message: raw };
    }
  }

  if (!response.ok) {
    const message = firstDefined(
      data?.error,
      data?.message,
      `Request failed (${response.status})`
    );

    throw new Error(message);
  }

  return data;
}

// ============================================================
// NAVIGATION
// ============================================================

function showView(viewName) {
  if (!VIEW_INFO[viewName]) {
    console.error("Unknown dashboard view:", viewName);
    return;
  }

  const target = $(`${viewName}View`);

  if (!target) {
    console.error(
      `Missing section #${viewName}View in index.html`
    );

    showToast(
      `Dashboard section "${viewName}" was not found.`,
      "error"
    );

    return;
  }

  currentView = viewName;

  Object.keys(VIEW_INFO).forEach(name => {
    const section = $(`${name}View`);

    if (section) section.classList.add("hidden");
  });

  target.classList.remove("hidden");

  document
    .querySelectorAll(".nav-item[data-view]")
    .forEach(button => {
      const selected = button.dataset.view === viewName;

      button.classList.toggle("active", selected);

      button.setAttribute(
        "aria-current",
        selected ? "page" : "false"
      );
    });

  const info = VIEW_INFO[viewName];

  setText("breadcrumbTitle", info.title);
  setText("pageEyebrow", info.eyebrow);
  setText("pageDescription", info.description);

  const pageTitle = $("pageTitle");

  if (pageTitle) {
    pageTitle.replaceChildren(
      document.createTextNode(info.title)
    );

    const period = document.createElement("span");
    period.className = "heading-period";
    period.textContent = ".";

    pageTitle.appendChild(period);
  }

  renderCurrentData();
}

function setupNavigation() {
  document
    .querySelectorAll(".nav-item[data-view]")
    .forEach(button => {
      button.addEventListener("click", () => {
        showView(button.dataset.view);
      });
    });

  document.querySelectorAll("[data-go]").forEach(button => {
    button.addEventListener("click", () => {
      showView(button.dataset.go);
    });
  });

  const brandHome = $("brandHome");

  if (brandHome) {
    brandHome.addEventListener("click", event => {
      event.preventDefault();
      showView("overview");
    });
  }

  showView("overview");
}

// ============================================================
// BACKEND CONNECTION AND DATA LOADING
// ============================================================

function setConnectionStatus(connected, message) {
  setText(
    "sidebarConnection",
    connected ? "Backend connected" : "Backend offline"
  );

  setText("topStatus", message);

  ["sidebarDot", "topStatusDot"].forEach(id => {
    const dot = $(id);
    if (!dot) return;

    dot.classList.toggle("online", connected);
    dot.classList.toggle("offline", !connected);
  });
}

async function fetchState() {
  return apiRequest("/api/state");
}

async function fetchPlan() {
  return apiRequest("/api/plan");
}

async function fetchIncidents() {
  return apiRequest("/api/incidents");
}

async function fetchConflicts() {
  return apiRequest("/api/conflicts");
}

async function fetchEvents() {
  return apiRequest("/api/agent-events");
}

function unwrapList(data, keys) {
  if (Array.isArray(data)) return data;

  for (const key of keys) {
    if (Array.isArray(data?.[key])) {
      return data[key];
    }
  }

  return [];
}

function normalizePlan(data) {
  if (!data || typeof data !== "object") {
    return null;
  }

  return firstDefined(
    data.plan,
    data.currentPlan,
    data.result,
    data
  );
}

function extractIncidents(state, plan, incidentsResponse) {
  const direct = unwrapList(incidentsResponse, [
    "incidents",
    "items",
    "data",
    "results"
  ]);

  if (direct.length) return direct;

  const fromState = getArray(
    state?.incidents,
    state?.data?.incidents,
    state?.state?.incidents
  );

  if (fromState.length) return fromState;

  return getArray(
    plan?.rankedIncidents,
    plan?.ranked_incidents,
    plan?.prioritizedIncidents,
    plan?.incidents,
    plan?.ranked
  );
}

function extractConflicts(state, response) {
  const direct = unwrapList(response, [
    "conflicts",
    "items",
    "data",
    "results"
  ]);

  if (direct.length) return direct;

  return getArray(
    state?.conflicts,
    state?.data?.conflicts,
    state?.state?.conflicts
  );
}

function extractEvents(state, response) {
  const direct = unwrapList(response, [
    "events",
    "agentEvents",
    "items",
    "data",
    "results"
  ]);

  if (direct.length) return direct;

  return getArray(
    state?.agentEvents,
    state?.events,
    state?.data?.agentEvents
  );
}

async function loadDashboard({ silent = false } = {}) {
  if (isRefreshing) return;

  isRefreshing = true;

  if (!silent) {
    setText("topStatus", "Refreshing data...");
  }

  try {
    const results = await Promise.allSettled([
      fetchState(),
      fetchPlan(),
      fetchIncidents(),
      fetchConflicts(),
      fetchEvents()
    ]);

    const [
      stateResult,
      planResult,
      incidentsResult,
      conflictsResult,
      eventsResult
    ] = results;

    const stateOk = stateResult.status === "fulfilled";

    if (
      !stateOk &&
      planResult.status === "rejected"
    ) {
      throw (
        stateResult.reason ||
        planResult.reason ||
        new Error("Backend unavailable")
      );
    }

    dashboardState = stateOk
      ? stateResult.value
      : {};

    currentPlan =
      planResult.status === "fulfilled"
        ? normalizePlan(planResult.value)
        : null;

    const incidentResponse =
      incidentsResult.status === "fulfilled"
        ? incidentsResult.value
        : {};

    const conflictResponse =
      conflictsResult.status === "fulfilled"
        ? conflictsResult.value
        : {};

    const eventResponse =
      eventsResult.status === "fulfilled"
        ? eventsResult.value
        : {};

    currentIncidents = extractIncidents(
      dashboardState,
      currentPlan,
      incidentResponse
    );

    currentConflicts = extractConflicts(
      dashboardState,
      conflictResponse
    );

    currentEvents = extractEvents(
      dashboardState,
      eventResponse
    );

    setConnectionStatus(
      true,
      results.some(
        result => result.status === "rejected"
      )
        ? "Connected · partial data"
        : "Backend connected"
    );

    renderCurrentData();

    if (!silent) {
      showToast("Dashboard data refreshed.");
    }
  } catch (error) {
    console.error("Dashboard loading error:", error);

    setConnectionStatus(false, "Backend unavailable");

    if (!silent) {
      showToast(
        `Unable to load backend data: ${error.message}`,
        "error"
      );
    }
  } finally {
    isRefreshing = false;
  }
}

// ============================================================
// INCIDENT REPORT SUBMISSION — NEW FEATURE
// ============================================================

function setupReportForm() {
  const openButton = $("openReportForm");
  const formPanel = $("reportFormPanel");
  const form = $("reportForm");
  const cancelButton = $("cancelReportBtn");
  const submitButton = $("submitReportBtn");
  const message = $("reportFormMessage");

  // The report form is optional until its HTML is added.
  if (!openButton || !formPanel || !form || !submitButton) {
    console.warn(
      "Report form elements not found. Check index.html."
    );
    return;
  }

  // Open the form.
  openButton.addEventListener("click", () => {
    formPanel.classList.remove("hidden");
    $("reportDescription")?.focus();
  });

  // Cancel and close the form.
  cancelButton?.addEventListener("click", () => {
    form.reset();
    formPanel.classList.add("hidden");

    if (message) {
      message.textContent = "";
      message.style.color = "";
    }
  });

  // Submit the report to the backend.
  form.addEventListener("submit", async event => {
    event.preventDefault();

    const rawText =
      $("reportDescription")?.value.trim();

    const placeId =
      $("reportLocation")?.value;

    const source =
      $("reportSource")?.value;

    if (!rawText || !placeId || !source) {
      if (message) {
        message.textContent =
          "Please complete all fields.";

        message.style.color = "#b42318";
      }

      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = "Submitting...";

    if (message) {
      message.textContent =
        "Sending report to the local backend...";

      message.style.color = "";
    }

    try {
      const result = await apiRequest("/api/reports", {
        method: "POST",
        body: JSON.stringify({
          rawText,
          placeId,
          source
        })
      });

      console.log(
        "Report submission response:",
        result
      );

      if (message) {
        message.textContent =
          "Report accepted. Updating the dashboard...";

        message.style.color = "#16803c";
      }

      showToast("Report submitted successfully.");

      form.reset();

      /*
       * A previous dashboard refresh may still be running.
       * Retry after it finishes so the new report can appear.
       */
      await refreshAfterReportSubmission();

      if (message) {
        message.textContent =
          "Report submitted. Check the incident list and activity log.";

        message.style.color = "#16803c";
      }
    } catch (error) {
      console.error(
        "Report submission failed:",
        error
      );

      if (message) {
        message.textContent =
          `Submission failed: ${error.message}. Please try again.`;

        message.style.color = "#b42318";
      }

      showToast(
        `Report submission failed: ${error.message}`,
        "error"
      );
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "Submit Report";
    }
  });
}

async function refreshAfterReportSubmission() {
  // Avoid calling loadDashboard while another refresh is active.
  // Otherwise its isRefreshing guard would return immediately.
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!isRefreshing) {
      await loadDashboard({ silent: true });
      return;
    }

    await new Promise(resolve => {
      window.setTimeout(resolve, 250);
    });
  }

  showToast(
    "Report was submitted. Use Refresh to reload the dashboard.",
    "error"
  );
}

// ============================================================
// PLAN DATA HELPERS
// ============================================================

function getAssignments(plan = currentPlan) {
  if (!plan) return [];

  return getArray(
    plan.assignments,
    plan.resourceAssignments,
    plan.allocations,
    plan.proposedAssignments,
    plan.plan?.assignments
  );
}

function getWarnings(plan = currentPlan) {
  if (!plan) return [];

  return getArray(
    plan.warnings,
    plan.planWarnings,
    plan.coverageWarnings,
    plan.diagnostics?.warnings,
    plan.plan?.warnings
  );
}

function getPlanStatus(plan = currentPlan) {
  return String(
    firstDefined(
      plan?.status,
      plan?.state,
      "UNAVAILABLE"
    )
  );
}

function getPlanId(plan = currentPlan) {
  return firstDefined(
    plan?.id,
    plan?.planId,
    plan?.plan_id,
    "—"
  );
}

function getAssignmentResource(assignment) {
  const resource = firstDefined(
    assignment?.resource,
    assignment?.resourceId,
    assignment?.resource_id,
    assignment?.unit,
    assignment?.resourceName
  );

  if (typeof resource === "object" && resource) {
    return firstDefined(
      resource.name,
      resource.id,
      resource.type,
      "Resource"
    );
  }

  return resource ?? "Resource";
}

function getAssignmentIncident(assignment) {
  const incident = firstDefined(
    assignment?.incident,
    assignment?.incidentId,
    assignment?.incident_id,
    assignment?.targetIncidentId,
    assignment?.target
  );

  if (typeof incident === "object" && incident) {
    return firstDefined(
      incident.title,
      incident.id,
      incident.type,
      "Incident"
    );
  }

  const matchingIncident = currentIncidents.find(item =>
    String(getIncidentId(item)) === String(incident)
  );

  return matchingIncident
    ? getIncidentTitle(matchingIncident)
    : incident ?? "Incident";
}

function getUnassignedIncidents(plan = currentPlan) {
  const explicit = getArray(
    plan?.unassignedIncidents,
    plan?.unassigned,
    plan?.unallocatedIncidents,
    plan?.unassigned_incidents
  );

  if (explicit.length) return explicit;

  const assignedIds = new Set(
    getAssignments(plan).map(assignment =>
      String(
        firstDefined(
          assignment?.incidentId,
          assignment?.incident_id,
          assignment?.targetIncidentId,
          typeof assignment?.incident === "object"
            ? assignment.incident.id
            : assignment?.incident
        )
      )
    )
  );

  return currentIncidents.filter(
    incident =>
      !assignedIds.has(String(getIncidentId(incident)))
  );
}

// ============================================================
// METRICS
// ============================================================

function renderMetrics() {
  const assignments = getAssignments();
  const warnings = getWarnings();
  const unassigned = getUnassignedIncidents();

  const criticalCount = currentIncidents.filter(
    incident => getPriority(incident) === "critical"
  ).length;

  const openConflicts = currentConflicts.filter(
    conflict => !isConflictResolved(conflict)
  ).length;

  setText(
    "totalIncidents",
    formatNumber(currentIncidents.length)
  );

  setText(
    "criticalIncidents",
    formatNumber(criticalCount)
  );

  setText(
    "assignedResources",
    formatNumber(assignments.length)
  );

  setText(
    "openConflicts",
    formatNumber(openConflicts)
  );

  setText(
    "navIncidentCount",
    formatNumber(currentIncidents.length)
  );

  setText(
    "navConflictCount",
    formatNumber(openConflicts)
  );

  setText(
    "warningCount",
    formatNumber(warnings.length)
  );

  const totalResources = firstDefined(
    dashboardState?.resources?.length,
    dashboardState?.data?.resources?.length,
    currentPlan?.resourceCount,
    currentPlan?.totalResources,
    assignments.length
  );

  const assignedCount = assignments.length;

  const unassignedResources = Math.max(
    0,
    Number(totalResources || 0) - assignedCount
  );

  const percent = Number(totalResources) > 0
    ? Math.round(
        (assignedCount / Number(totalResources)) * 100
      )
    : 0;

  setText("allocationPercent", `${percent}%`);
  setText("assignedStat", formatNumber(assignedCount));

  setText(
    "unassignedStat",
    formatNumber(unassignedResources)
  );

  setText(
    "unplannedStat",
    formatNumber(unassigned.length)
  );

  const ring = $("allocationRing");

  if (ring) {
    ring.style.background =
      `conic-gradient(#16a36a ${percent}%, #e7ebf1 ${percent}% 100%)`;
  }

  const status = getPlanStatus();

  setText("planStatus", status);

  const statusElement = $("planStatus");

  if (statusElement) {
    statusElement.classList.toggle(
      "approved",
      status.toLowerCase().includes("approved")
    );

    statusElement.classList.toggle(
      "proposed",
      !status.toLowerCase().includes("approved")
    );
  }

  setText("planId", getPlanId());
}

// ============================================================
// INCIDENT RENDERING
// ============================================================

function incidentPriorityHTML(incident) {
  const priority = getPriority(incident);
  const score = getPriorityScore(incident);

  return `
    <span class="priority-tag ${priority}">
      ${escapeHTML(priorityLabel(incident))}
    </span>
    <span class="score-box ${priority}">
      ${score === null ? "—" : escapeHTML(score)}
    </span>
  `;
}

function renderPriorityList() {
  const container = $("priorityList");
  if (!container) return;

  const ranked = [...currentIncidents]
    .sort((a, b) => {
      const scoreA = getPriorityScore(a) ?? -1;
      const scoreB = getPriorityScore(b) ?? -1;

      return scoreB - scoreA;
    })
    .slice(0, 6);

  if (!ranked.length) {
    container.innerHTML =
      '<div class="empty-state">No incidents available from the backend.</div>';

    return;
  }

  container.innerHTML = ranked.map(incident => {
    const people = getPeopleCount(incident);

    return `
      <article class="priority-row">
        <div class="priority-row-main">
          <div class="incident-name">
            ${escapeHTML(getIncidentTitle(incident))}
          </div>
          <div class="incident-meta">
            ${escapeHTML(getLocation(incident))}
            · ${escapeHTML(people)} people
            ${isStale(incident) ? " · Stale report" : ""}
          </div>
        </div>
        <div class="priority-row-score">
          ${incidentPriorityHTML(incident)}
        </div>
      </article>
    `;
  }).join("");
}

function renderIncidentsTable() {
  const body = $("incidentsTable");
  if (!body) return;

  if (!currentIncidents.length) {
    body.innerHTML =
      '<tr><td colspan="7">No incidents available.</td></tr>';

    return;
  }

  const ranked = [...currentIncidents].sort(
    (a, b) =>
      (getPriorityScore(b) ?? -1) -
      (getPriorityScore(a) ?? -1)
  );

  body.innerHTML = ranked.map(incident => {
    const id = getIncidentId(incident);
    const freshness = isStale(incident)
      ? "Stale"
      : "Check report";

    const score = getPriorityScore(incident);

    return `
      <tr>
        <td>
          <span class="priority-tag ${getPriority(incident)}">
            ${escapeHTML(priorityLabel(incident))}
          </span>
        </td>
        <td>
          <strong>
            ${escapeHTML(getIncidentTitle(incident))}
          </strong>
          <div class="incident-meta">
            ${escapeHTML(id)}
          </div>
        </td>
        <td>${escapeHTML(getLocation(incident))}</td>
        <td>
          ${score === null ? "—" : escapeHTML(score)}
        </td>
        <td>${escapeHTML(getPeopleCount(incident))}</td>
        <td>${escapeHTML(freshness)}</td>
        <td>
          <button
            class="text-button"
            type="button"
            data-review-incident="${escapeHTML(id)}"
          >
            Details
          </button>
        </td>
      </tr>
    `;
  }).join("");

  body.querySelectorAll("[data-review-incident]")
    .forEach(button => {
      button.addEventListener("click", () => {
        const incident = currentIncidents.find(
          item =>
            String(getIncidentId(item)) ===
            button.dataset.reviewIncident
        );

        if (incident) {
          openIncidentDetails(incident);
        } else {
          showToast(
            "Incident data could not be found. Refresh the dashboard.",
            "error"
          );
        }
      });
    });
}

function displayIncidentType(type) {
  return String(type || "Unknown")
    .replaceAll("_", " ")
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function openIncidentDetails(incident) {
  const modal = $("incidentDetailsModal");
  const content = $("incidentDetailsContent");

  if (!modal || !content) {
    showToast(
      "Incident details modal is missing from index.html.",
      "error"
    );

    return;
  }

  const incidentId = getIncidentId(incident);
  const people = incident.peopleAtRisk;
  const confidence = Number(incident.confidence);
  const reliability = Number(incident.sourceReliability);

  const details = [
    ["Incident ID", incidentId],
    [
      "Incident type",
      displayIncidentType(incident.type)
    ],
    [
      "Location ID",
      incident.placeId || "Unknown"
    ],
    [
      "People at risk",
      people == null
        ? "Unknown — requires verification"
        : formatNumber(people)
    ],
    [
      "Priority score",
      getPriorityScore(incident) ??
        "Not supplied by backend"
    ],
    [
      "Priority level",
      getPriorityScore(incident) === null
        ? "Not calculated"
        : priorityLabel(incident)
    ],
    [
      "Classification confidence",
      Number.isFinite(confidence)
        ? `${Math.round(confidence * 100)}%`
        : "Unavailable"
    ],
    [
      "Source reliability",
      Number.isFinite(reliability)
        ? `${Math.round(reliability * 100)}%`
        : "Unavailable"
    ],
    [
      "Freshness",
      displayIncidentType(
        incident.freshness || "Unknown"
      )
    ],
    [
      "Last event time",
      formatDate(incident.lastEventTime)
    ],
    [
      "Bridge status",
      incident.bridgeStatus || "Not recorded"
    ],
    [
      "Linked reports",
      Array.isArray(incident.reportIds)
        ? incident.reportIds.length
        : 0
    ],
    [
      "Reporting sources",
      Array.isArray(incident.sourceTypes) &&
      incident.sourceTypes.length
        ? incident.sourceTypes.join(", ")
        : "Unknown"
    ]
  ];

  const detailRows = details.map(([label, value]) => `
    <div class="plan-summary-row">
      <span>${escapeHTML(label)}</span>
      <strong>${escapeHTML(value)}</strong>
    </div>
  `).join("");

  const flags = Array.isArray(incident.flags)
    ? incident.flags
    : [];

  const questions = Array.isArray(
    incident.followUpQuestions
  )
    ? incident.followUpQuestions
    : [];

  content.innerHTML = `
    <div class="detail-card">
      <h3>Incident overview</h3>
      <div class="plan-summary">${detailRows}</div>
    </div>

    <div class="detail-card">
      <h3>Verification flags</h3>
      ${
        flags.length
          ? `<ul>${flags.map(flag =>
              `<li>${escapeHTML(flag)}</li>`
            ).join("")}</ul>`
          : "<p>No flags recorded.</p>"
      }
    </div>

    <div class="detail-card">
      <h3>Follow-up questions</h3>
      ${
        questions.length
          ? `<ul>${questions.map(question =>
              `<li>${escapeHTML(question)}</li>`
            ).join("")}</ul>`
          : "<p>No follow-up questions recorded.</p>"
      }
    </div>

    <div class="detail-card">
      <h3>Linked report IDs</h3>
      ${
        Array.isArray(incident.reportIds) &&
        incident.reportIds.length
          ? `<ul>${incident.reportIds.map(id =>
              `<li><code>${escapeHTML(id)}</code></li>`
            ).join("")}</ul>`
          : "<p>No linked report IDs.</p>"
      }
    </div>

    <p class="microcopy">
      A missing priority score means the backend has not supplied one
      for this incident. Do not interpret missing data as low risk.
    </p>
  `;

  modal.classList.remove("hidden");
}

function setupIncidentDetails() {
  $("closeIncidentDetails")?.addEventListener(
    "click",
    () => {
      $("incidentDetailsModal")?.classList.add("hidden");
    }
  );

  $("incidentDetailsModal")?.addEventListener(
    "click",
    event => {
      if (event.target === $("incidentDetailsModal")) {
        $("incidentDetailsModal").classList.add("hidden");
      }
    }
  );

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      $("incidentDetailsModal")?.classList.add("hidden");
    }
  });
}

// ============================================================
// RESOURCE PLANNING
// ============================================================

function renderResources() {
  const assignments = getAssignments();
  const unassigned = getUnassignedIncidents();
  const warnings = getWarnings();

  const details = $("resourceDetails");

  if (details) {
    details.innerHTML = assignments.length
      ? assignments.map(assignment => `
          <article class="assignment-card">
            <div>
              <strong>
                ${escapeHTML(getAssignmentResource(assignment))}
              </strong>
              <div class="incident-meta">
                Assigned incident:
                ${escapeHTML(getAssignmentIncident(assignment))}
              </div>
            </div>
            <span class="priority-tag medium">PROPOSED</span>
          </article>
        `).join("")
      : '<div class="empty-state">No proposed resource assignments.</div>';
  }

  const unassignedList = $("unassignedList");

  if (unassignedList) {
    unassignedList.innerHTML = unassigned.length
      ? unassigned.map(incident => `
          <article class="assignment-card">
            <div>
              <strong>
                ${escapeHTML(getIncidentTitle(incident))}
              </strong>
              <div class="incident-meta">
                ${escapeHTML(getLocation(incident))}
                · ${escapeHTML(getPeopleCount(incident))} people
              </div>
            </div>
            <span class="priority-tag ${getPriority(incident)}">
              ${escapeHTML(priorityLabel(incident))}
            </span>
          </article>
        `).join("")
      : '<div class="empty-state">No unassigned incidents detected from available data.</div>';
  }

  const resourceWarnings = $("resourceWarnings");

  if (resourceWarnings) {
    resourceWarnings.innerHTML = warnings.length
      ? warnings.map(renderWarning).join("")
      : '<div class="empty-state">No plan warnings were returned.</div>';
  }

  const warningList = $("warningList");

  if (warningList) {
    warningList.innerHTML = warnings.length
      ? warnings.slice(0, 5).map(renderWarning).join("")
      : '<div class="empty-state">No operational warnings returned.</div>';
  }

  const resourceWarning = $("resourceWarning");

  if (resourceWarning) {
    const paragraph = resourceWarning.querySelector("p");

    if (paragraph) {
      paragraph.textContent = warnings.length
        ? `${warnings.length} warning(s) require review.`
        : "No warnings reported by the current plan.";
    }
  }
}

function renderWarning(warning) {
  const message = typeof warning === "string"
    ? warning
    : firstDefined(
        warning?.message,
        warning?.description,
        warning?.reason,
        warning?.detail,
        warning?.type,
        JSON.stringify(warning)
      );

  return `
    <div class="warning-item">
      <span class="warning-symbol">⚠</span>
      <span>${escapeHTML(message)}</span>
    </div>
  `;
}

// ============================================================
// CONFLICT REVIEW
// ============================================================

function isConflictResolved(conflict) {
  const status = String(
    firstDefined(
      conflict?.status,
      conflict?.resolutionStatus,
      conflict?.state,
      ""
    )
  ).toLowerCase();

  return Boolean(
    conflict?.resolved === true ||
    conflict?.isResolved === true ||
    ["resolved", "closed", "reviewed"].includes(status)
  );
}

function getConflictId(conflict) {
  return firstDefined(
    conflict?.id,
    conflict?.conflictId,
    conflict?._id,
    ""
  );
}

function getConflictMessage(conflict) {
  return firstDefined(
    conflict?.message,
    conflict?.description,
    conflict?.reason,
    conflict?.summary,
    conflict?.type,
    "Conflicting reports need human review."
  );
}


function renderConflicts() {
  const container = $("conflictList");
  if (!container) return;

  if (!currentConflicts.length) {
    container.innerHTML =
      '<div class="empty-state">No report conflicts returned by the backend.</div>';
    return;
  }

  container.innerHTML = currentConflicts.map(conflict => {
    const resolved = isConflictResolved(conflict);
    const id = getConflictId(conflict);

    const reviewer = firstDefined(
      conflict?.reviewer,
      conflict?.reviewedBy,
      conflict?.resolvedBy,
      ""
    );

    const note = firstDefined(
      conflict?.reviewNote,
      conflict?.resolutionNote,
      conflict?.note,
      ""
    );

    return `
      <article class="conflict-card">
        <div class="conflict-card-header">
          <strong>
            ${escapeHTML(getConflictMessage(conflict))}
          </strong>
          <span class="${resolved ? "resolved-label" : "open-label"}">
            ${resolved ? "Resolved / Reviewed" : "Open — Pending Review"}
          </span>
        </div>

        <div class="incident-meta">
          Conflict ID: ${escapeHTML(id || "Unavailable")}
        </div>

        ${
          conflict?.placeId
            ? `<p>Location: ${escapeHTML(conflict.placeId)}</p>`
            : ""
        }

        ${
          reviewer
            ? `<p>Reviewer: ${escapeHTML(reviewer)}</p>`
            : ""
        }

        ${
          note
            ? `<p>Review note: ${escapeHTML(note)}</p>`
            : ""
        }

        ${
          !resolved && id
            ? `
              <button
                class="btn btn-secondary"
                type="button"
                data-open-review="${escapeHTML(id)}"
              >
                Record review
              </button>
            `
            : ""
        }

        ${
          resolved && id
            ? `
              <button
                class="btn btn-secondary"
                type="button"
                data-reopen-conflict="${escapeHTML(id)}"
              >
                Reopen Conflict
              </button>
            `
            : ""
        }

        <p class="microcopy">
          Human review records a decision; it does not independently
          verify the reports or dispatch real resources.
        </p>
      </article>
    `;
  }).join("");

  // Existing review action.
  container.querySelectorAll("[data-open-review]")
    .forEach(button => {
      button.addEventListener("click", () => {
        openReviewModal(button.dataset.openReview);
      });
    });

  // New action: reopen a resolved conflict.
  container.querySelectorAll("[data-reopen-conflict]")
    .forEach(button => {
      button.addEventListener("click", async () => {
        const conflictId = button.dataset.reopenConflict;

        const reviewer = window.prompt(
          "Enter the reviewer name:"
        )?.trim();

        if (!reviewer) {
          showToast("Reopening cancelled: reviewer name is required.", "error");
          return;
        }

        const note = window.prompt(
          "Why are you reopening this conflict?"
        )?.trim();

        if (!note) {
          showToast("Reopening cancelled: a reason is required.", "error");
          return;
        }

        button.disabled = true;
        button.textContent = "Reopening...";

        try {
          await apiRequest(
            `/api/conflicts/${encodeURIComponent(conflictId)}/reopen`,
            {
              method: "POST",
              body: JSON.stringify({ reviewer, note })
            }
          );

          await loadDashboard({ silent: true });

          showToast(
            "Conflict reopened. It requires review again."
          );
        } catch (error) {
          console.error("Conflict reopening failed:", error);

          showToast(
            `Could not reopen conflict: ${error.message}`,
            "error"
          );

          button.disabled = false;
          button.textContent = "Reopen Conflict";
        }
      });
    });
}


function openReviewModal(conflictId) {
  setText("reviewConflictId", conflictId);

  const idInput = $("reviewConflictId");

  if (idInput) {
    idInput.value = conflictId;
  }

  const modal = $("reviewModal");

  if (modal) {
    modal.classList.remove("hidden");
  }
}

function closeReviewModal() {
  const modal = $("reviewModal");

  if (modal) {
    modal.classList.add("hidden");
  }

  const form = $("reviewForm");

  if (form) {
    form.reset();
  }
}

function setupConflictReview() {
  $("closeModal")?.addEventListener(
    "click",
    closeReviewModal
  );

  $("cancelReview")?.addEventListener(
    "click",
    closeReviewModal
  );

  $("reviewModal")?.addEventListener(
    "click",
    event => {
      if (event.target === $("reviewModal")) {
        closeReviewModal();
      }
    }
  );

  $("reviewForm")?.addEventListener(
    "submit",
    async event => {
      event.preventDefault();

      const conflictId =
        $("reviewConflictId")?.value?.trim();

      const reviewer =
        $("reviewerName")?.value?.trim();

      const note =
        $("reviewNote")?.value?.trim();

      if (!conflictId || !reviewer || !note) {
        showToast(
          "Enter the reviewer identifier and review note.",
          "error"
        );

        return;
      }

      try {
        await apiRequest(
          `/api/conflicts/${encodeURIComponent(conflictId)}/resolve`,
          {
            method: "POST",
            body: JSON.stringify({
              reviewer,
              reviewerName: reviewer,
              note,
              reviewNote: note
            })
          }
        );

        closeReviewModal();

        await loadDashboard({ silent: true });

        showToast("Conflict review recorded.");
      } catch (error) {
        console.error(
          "Conflict review failed:",
          error
        );

        showToast(
          `Could not record review: ${error.message}`,
          "error"
        );
      }
    }
  );
}

// ============================================================
// PLAN APPROVAL
// ============================================================

function renderApproval() {
  const container = $("approvalDetails");
  if (!container) return;

  if (!currentPlan) {
    container.innerHTML =
      '<div class="empty-state">Plan information is unavailable. Refresh the dashboard.</div>';

    return;
  }

  const assignments = getAssignments();
  const warnings = getWarnings();
  const status = getPlanStatus();

  const requiresApproval = firstDefined(
    currentPlan?.requiresHumanApproval,
    currentPlan?.requiresApproval,
    true
  );

  container.innerHTML = `
    <div class="detail-card">
      <h3>Proposed plan summary</h3>
      <div class="plan-summary">
        <div class="plan-summary-row">
          <span>Plan ID</span>
          <code>${escapeHTML(getPlanId())}</code>
        </div>

        <div class="plan-summary-row">
          <span>Status</span>
          <strong>${escapeHTML(status)}</strong>
        </div>

        <div class="plan-summary-row">
          <span>Planning method</span>
          <strong>
            ${escapeHTML(
              firstDefined(
                currentPlan?.planningMode,
                currentPlan?.method,
                "Explainable rules"
              )
            )}
          </strong>
        </div>

        <div class="plan-summary-row">
          <span>Proposed assignments</span>
          <strong>${assignments.length}</strong>
        </div>

        <div class="plan-summary-row">
          <span>Unassigned incidents</span>
          <strong>${getUnassignedIncidents().length}</strong>
        </div>

        <div class="plan-summary-row">
          <span>Warnings</span>
          <strong>${warnings.length}</strong>
        </div>

        <div class="plan-summary-row">
          <span>Human approval required</span>
          <strong>
            ${requiresApproval ? "Yes" : "Check backend policy"}
          </strong>
        </div>
      </div>
    </div>

    <div class="notice-banner">
      <span class="notice-icon">ⓘ</span>
      <div>
        <strong>Simulation and human oversight</strong>
        <span>
          Recording approval does not dispatch resources.
          Verify all field reports, availability, and safety
          conditions independently.
        </span>
      </div>
    </div>

    <h3 class="subheading">Proposed assignments</h3>

    ${
      assignments.length
        ? assignments.map(assignment => `
            <article class="assignment-card">
              <div>
                <strong>
                  ${escapeHTML(getAssignmentResource(assignment))}
                </strong>
                <div class="incident-meta">
                  ${escapeHTML(getAssignmentIncident(assignment))}
                </div>
              </div>
              <span class="priority-tag medium">PROPOSED</span>
            </article>
          `).join("")
        : '<div class="empty-state">No assignments are available for approval.</div>'
    }

    <h3 class="subheading">Plan warnings</h3>

    ${
      warnings.length
        ? warnings.map(renderWarning).join("")
        : '<div class="empty-state">No warnings returned.</div>'
    }
  `;

  const approveButton = $("approveBtn");

  if (approveButton) {
    const approved = status.toLowerCase().includes("approved");

    approveButton.disabled = approved;

    approveButton.textContent = approved
      ? "Plan Already Approved"
      : "Record Plan Approval";
  }
}

function setupPlanActions() {
  $("recomputeBtn")?.addEventListener(
    "click",
    async () => {
      const button = $("recomputeBtn");

      if (button) button.disabled = true;

      try {
        await apiRequest("/api/plan/recompute", {
          method: "POST",
          body: JSON.stringify({})
        });

        await loadDashboard({ silent: true });

        showToast(
          "Plan recomputed. Review the updated proposal."
        );
      } catch (error) {
        console.error(
          "Plan recomputation failed:",
          error
        );

        showToast(
          `Could not recompute plan: ${error.message}`,
          "error"
        );
      } finally {
        if (button) button.disabled = false;
      }
    }
  );

  $("approveBtn")?.addEventListener(
    "click",
    async () => {
      const approver =
        $("approverName")?.value?.trim();

      if (!approver) {
        showToast(
          "Enter the authorized approver identifier first.",
          "error"
        );

        $("approverName")?.focus();

        return;
      }

      const confirmed = window.confirm(
        "Record approval for this simulated plan? This does not dispatch real resources."
      );

      if (!confirmed) return;

      const button = $("approveBtn");

      if (button) button.disabled = true;

      try {
        await apiRequest("/api/plan/approve", {
          method: "POST",
          body: JSON.stringify({
            approver,
            approverName: approver
          })
        });

        await loadDashboard({ silent: true });

        showToast(
          "Approval request recorded by the backend."
        );
      } catch (error) {
        console.error(
          "Plan approval failed:",
          error
        );

        showToast(
          `Could not record approval: ${error.message}`,
          "error"
        );
      } finally {
        if (button) button.disabled = false;

        renderApproval();
      }
    }
  );
}

// ============================================================
// ACTIVITY LOG
// ============================================================

function getEventTitle(event) {
  if (typeof event === "string") return event;

  return firstDefined(
    event?.message,
    event?.description,
    event?.event,
    event?.type,
    event?.action,
    event?.name,
    "System event"
  );
}

function getEventTime(event) {
  if (typeof event === "string") return "";

  return firstDefined(
    event?.timestamp,
    event?.createdAt,
    event?.receivedAt,
    event?.time,
    event?.at,
    ""
  );
}

function renderActivityList(events, containerId) {
  const container = $(containerId);
  if (!container) return;

  if (!events.length) {
    container.innerHTML =
      '<div class="empty-state">No activity events returned by the backend.</div>';

    return;
  }

  container.innerHTML = [...events]
    .reverse()
    .slice(0, 50)
    .map(event => {
      const title = getEventTitle(event);
      const time = getEventTime(event);

      return `
        <article class="activity-row">
          <span class="activity-symbol">•</span>

          <div class="activity-text">
            <strong>${escapeHTML(title)}</strong>

            ${
              event &&
              typeof event === "object" &&
              event.details
                ? `<p>${escapeHTML(event.details)}</p>`
                : ""
            }
          </div>

          <span class="activity-time">
            ${escapeHTML(formatDate(time))}
          </span>
        </article>
      `;
    })
    .join("");
}

// ============================================================
// RENDER CURRENT VIEW
// ============================================================

function renderCurrentData() {
  renderMetrics();
  renderPriorityList();
  renderIncidentsTable();
  renderResources();
  renderConflicts();
  renderApproval();

  renderActivityList(
    currentEvents,
    "recentActivity"
  );

  renderActivityList(
    currentEvents,
    "fullActivity"
  );
}

// ============================================================
// INITIALIZATION
// ============================================================

function initializeDashboard() {
  setupNavigation();
  setupIncidentDetails();
  setupConflictReview();
  setupPlanActions();

  // NEW: register the incident report form.
  setupReportForm();

  $("refreshBtn")?.addEventListener(
    "click",
    () => {
      loadDashboard();
    }
  );

  loadDashboard();

  if (refreshTimer) {
    window.clearInterval(refreshTimer);
  }

  refreshTimer = window.setInterval(
    () => {
      loadDashboard({ silent: true });
    },
    REFRESH_INTERVAL
  );
}

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    initializeDashboard,
    { once: true }
  );
} else {
  initializeDashboard();
}
