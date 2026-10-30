// CrisisMesh AI - Data layer
// Loads the backend /api/state and converts it into the shapes the dashboards render.
// If the backend is unreachable the dashboards fall back to local demo data.

(function () {
  const U = window.CrisisUtils;
  const REVIEW_KEY = "crisismesh_reviews";
  const MISSION_KEY = "crisismesh_mission_status";

  const cap = (value) =>
    String(value || "").charAt(0).toUpperCase() + String(value || "").slice(1);

  const DEMO_INCIDENTS = [
    { id: "INC-001", title: "Flooded Residential Area", location: "Hiranandalli", severity: "Critical", people: 45, status: "Active", latitude: 12.99, longitude: 77.71, description: "Rising floodwater reported in a residential area. Several families may require evacuation.", priority: 1 },
    { id: "INC-002", title: "Road Blockage", location: "KR Puram", severity: "High", people: 12, status: "Active", latitude: 13.007, longitude: 77.695, description: "Road access is blocked, potentially delaying emergency response vehicles.", priority: 2 },
    { id: "INC-003", title: "Water Level Rising", location: "Mahadevapura", severity: "High", people: 28, status: "Active", latitude: 12.991, longitude: 77.687, description: "Water levels are rising near a residential stretch. Monitoring is required.", priority: 2 },
    { id: "INC-004", title: "Power Disruption", location: "Whitefield", severity: "Medium", people: 8, status: "Active", latitude: 12.969, longitude: 77.75, description: "A local power disruption has been reported. The situation requires assessment.", priority: 3 },
  ];

  const DEMO_TEAMS = [
    { id: "TEAM-01", name: "Rescue Team Alpha", type: "Rescue", capacity: 6, status: "Available" },
    { id: "TEAM-02", name: "Medical Team Beta", type: "Medical", capacity: 4, status: "Busy" },
    { id: "TEAM-03", name: "Rescue Team Gamma", type: "Rescue", capacity: 5, status: "Available" },
  ];

  function severityOf(incident) {
    const stage = incident.terrain?.stage;
    if (stage === "severe" || stage === "critical") return "Critical";
    if (stage === "warning") return "High";
    if (stage === "watch") return "Medium";
    return incident.people >= 15 ? "High" : "Medium";
  }

  function mapIncident(incident) {
    const rank = incident.priority?.rank ?? 99;
    return {
      id: incident.id,
      title: incident.landmark
        ? `${incident.landmark} - ${incident.settlementName}`
        : incident.settlementName,
      location: incident.settlementName,
      severity: severityOf(incident),
      people: incident.people,
      peopleRange:
        incident.peopleMin !== incident.peopleMax
          ? `${incident.peopleMin}-${incident.peopleMax}`
          : String(incident.people),
      status: cap(incident.status),
      latitude: incident.lat,
      longitude: incident.lng,
      description: incident.summary,
      priority: rank,
      explanation: incident.priority?.explanation || "",
      timeLeftMin: incident.priority?.timeLeftMin ?? null,
      flags: incident.flags || [],
      needs: incident.needs || [],
      hazards: incident.hazards || [],
      vulnerable: !!incident.vulnerable,
      reportIds: incident.reportIds || [],
      independentSources: incident.independentSources ?? (incident.reportIds || []).length,
      echoGroups: incident.echoGroups || [],
      settlementId: incident.settlementId,
    };
  }

  function mapResource(resource) {
    const medical = (resource.skills || []).includes("medical");
    return {
      id: resource.id,
      name: resource.name,
      type: resource.kind === "boat" ? "Boat" : medical ? "Medical" : "Rescue",
      capacity: resource.capacity,
      mode: resource.mode,
      status: cap(resource.status),
    };
  }

  function loadReviews() {
    return U.getStorage(REVIEW_KEY, {}) || {};
  }

  function mapReport(report, incidents, reviews) {
    const incident = incidents.find((item) => item.reportIds.includes(report.id));
    const others = incident
      ? incident.reportIds.filter((id) => id !== report.id)
      : [];
    const review = reviews[report.id] || {};

    return {
      id: report.id,
      teamId: report.reporterName || "Unknown",
      incidentId: incident?.id || "-",
      type: cap(report.source),
      peopleCount: report.peopleCount ?? report.parsed?.people ?? 0,
      description: report.text,
      createdAt: new Date(report.createdAt || report.timestamp).toISOString(),
      synced: report.synced === true,
      origin: report.origin,
      reviewStatus: review.status || "pending",
      reviewReason: review.reason || "",
      reviewedAt: review.at || null,
      relatedReportIds: others,
    };
  }

  const Data = {
    connected: false,
    state: null,
    incidents: [],
    teams: [],
    reports: [],
    plan: null,
    network: { online: true },
    sync: null,
    lastError: null,

    async refresh() {
      try {
        const state = await window.CrisisAPI.getState();
        this.state = state;
        this.connected = true;
        this.lastError = null;
        this.incidents = state.incidents.map(mapIncident);
        this.teams = state.resources.map(mapResource);
        this.reports = state.reports.map((r) =>
          mapReport(r, this.incidents, loadReviews()),
        );
        this.plan = state.plan;
        this.network = state.network;
        this.sync = state.sync;
      } catch (error) {
        this.connected = false;
        this.lastError = error;
        this.state = null;
        this.plan = null;
        this.sync = null;
        this.incidents = window.CrisisUtils.getStorage("crisismesh_incidents", DEMO_INCIDENTS);
        this.teams = DEMO_TEAMS;
        this.reports = window.CrisisReports ? window.CrisisReports.getReports() : [];
        this.network = { online: !(window.CrisisOffline?.isOffline?.()) };
      }
      return this.connected;
    },

    // Coordinator review is a client-side decision log (the backend has no review endpoint).
    setReview(reportId, status, reason = "") {
      const reviews = loadReviews();
      reviews[reportId] = { status, reason, at: new Date().toISOString() };
      U.setStorage(REVIEW_KEY, reviews);
    },
    clearReviews() {
      U.setStorage(REVIEW_KEY, {});
    },

    // Mission progress is tracked on the device (the backend plans, it does not track execution).
    getMissionStatus(key) {
      return (U.getStorage(MISSION_KEY, {}) || {})[key] || null;
    },
    setMissionStatus(key, status) {
      const all = U.getStorage(MISSION_KEY, {}) || {};
      all[key] = status;
      U.setStorage(MISSION_KEY, all);
    },
    clearMissionStatus() {
      U.setStorage(MISSION_KEY, {});
    },
  };

  window.CrisisData = Data;
  console.log("CrisisMesh data layer loaded");
})();
