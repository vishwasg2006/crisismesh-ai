// CrisisMesh AI - Field Responder Dashboard (live backend, offline outbox)

document.addEventListener("DOMContentLoaded", () => {
  const $ = (id) => document.getElementById(id);
  const escape = (value) => window.CrisisUtils.escapeHTML(value);
  const API = window.CrisisAPI;
  const D = window.CrisisData;

  let selectedTeam = null;
  let approvedPlan = null;
  let incidentOptionsKey = "";
  let teamOptionsKey = "";

  // --------------------------------
  // OUTBOX (reports that could not reach the backend yet)
  // --------------------------------

  const outbox = () =>
    window.CrisisReports.getReports().filter((report) => report.synced !== true);

  function removeFromOutbox(id) {
    window.CrisisReports.saveReports(
      window.CrisisReports.getReports().filter((report) => report.id !== id),
    );
  }

  function toPayload(item) {
    const text = `${item.type}: ${item.description}`;
    const payload = {
      source: "field",
      text,
      reporterName: item.reporterName,
      settlementId: item.settlementId,
      minutesAgo: Math.max(
        0,
        Math.round((Date.now() - new Date(item.createdAt).getTime()) / 60000),
      ),
    };
    if (item.peopleCount > 0) payload.peopleCount = item.peopleCount;
    return payload;
  }

  let flushing = false;
  async function flushOutbox() {
    if (flushing || !D.connected) return 0;
    flushing = true;
    let sent = 0;
    try {
      for (const item of outbox()) {
        try {
          await API.submitReport(toPayload(item));
          removeFromOutbox(item.id);
          sent += 1;
        } catch (error) {
          if (!error.status) break; // still unreachable - keep the rest queued
          removeFromOutbox(item.id); // rejected by the server: it will never succeed
        }
      }
    } finally {
      flushing = false;
    }
    return sent;
  }

  // --------------------------------
  // SELECTS (teams + incident / area list come from the backend)
  // --------------------------------

  function renderTeamSelect() {
    const select = $("teamSelect");
    const key = D.teams.map((t) => t.id).join("|");

    if (key !== teamOptionsKey) {
      teamOptionsKey = key;
      select.innerHTML = D.teams
        .map((t) => `<option value="${escape(t.id)}">${escape(t.name)}</option>`)
        .join("");
    }

    if (!D.teams.some((t) => t.id === selectedTeam)) {
      selectedTeam = D.teams[0]?.id || null;
    }
    select.value = selectedTeam || "";
  }

  function renderIncidentSelect() {
    const select = $("reportIncident");
    const settlements = (D.state?.settlements || []).filter((s) => s.type !== "base");

    const key =
      D.incidents.map((i) => i.id).join("|") +
      "#" +
      settlements.map((s) => s.id).join("|");

    if (key === incidentOptionsKey) return;
    incidentOptionsKey = key;

    const previous = select.value;

    select.innerHTML = `
      <option value="">Select incident or area</option>
      <optgroup label="Active incidents">
        ${D.incidents
          .map(
            (i) =>
              `<option value="inc:${escape(i.id)}">${escape(i.id)} – ${escape(i.title)}</option>`,
          )
          .join("")}
      </optgroup>
      ${
        settlements.length
          ? `<optgroup label="Report from another area">
              ${settlements
                .map((s) => `<option value="set:${escape(s.id)}">${escape(s.name)}</option>`)
                .join("")}
             </optgroup>`
          : ""
      }`;

    if ([...select.options].some((o) => o.value === previous)) select.value = previous;
  }

  function resolveLocation(value) {
    if (value.startsWith("inc:")) {
      const incident = D.incidents.find((i) => i.id === value.slice(4));
      return { incident, settlementId: incident?.settlementId };
    }
    return { incident: null, settlementId: value.slice(4) };
  }

  // --------------------------------
  // TEAM INFORMATION
  // --------------------------------

  function renderTeamSummary() {
    const team = D.teams.find((item) => item.id === selectedTeam);

    if (!team) {
      $("teamSummary").textContent = "No teams available.";
      return;
    }

    $("teamSummary").innerHTML = `
      <h3>${escape(team.name)}</h3>
      <p>Type: ${escape(team.type)}${team.mode ? ` (${escape(team.mode)} access)` : ""}</p>
      <p>Capacity: ${escape(team.capacity)} people</p>
      <p>Status: ${escape(team.status)}</p>
    `;
  }

  // --------------------------------
  // MISSIONS (from the coordinator-approved plan)
  // --------------------------------

  function currentMissions() {
    if (!approvedPlan) return [];

    const names = {};
    (D.state?.settlements || []).forEach((s) => (names[s.id] = s.name));

    return approvedPlan.assignments
      .filter((a) => a.resourceId === selectedTeam)
      .map((a) => {
        const key = `${a.resourceId}:${a.incidentId}`;
        return {
          key,
          id: a.id,
          title: `${a.mode === "water" ? "Boat" : "Road"} rescue – ${a.settlementName}`,
          incidentId: a.incidentId,
          location: a.settlementName,
          status: D.getMissionStatus(key) || "Assigned",
          people: a.peopleServed,
          trips: a.trips,
          eta: Math.round(a.etaMin),
          route: (a.route || []).map((id) => names[id] || id).join(" → "),
          reason: a.reason,
          warnings: a.warnings || [],
        };
      });
  }

  function renderMissions() {
    const container = $("missionList");
    const missions = currentMissions();

    if (!D.connected) {
      container.innerHTML = `<div class="empty-state">Backend unreachable – missions cannot be loaded. Reports you submit are saved on this device and sent automatically later.</div>`;
    } else if (!approvedPlan) {
      container.innerHTML = `<div class="empty-state">No approved plan yet – waiting for the coordinator to approve a response plan.</div>`;
    } else if (missions.length === 0) {
      container.innerHTML = `<div class="empty-state">No missions currently assigned to this team (plan v${escape(approvedPlan.version)}).</div>`;
    } else {
      container.innerHTML = missions
        .map(
          (m) => `
      <article class="mission-card">
        <h3>${escape(m.title)}</h3>

        <p><strong>Incident:</strong> ${escape(m.incidentId)}</p>
        <p><strong>Location:</strong> ${escape(m.location)}</p>
        <p><strong>People to move:</strong> ${escape(m.people)} in ${escape(m.trips)} trip(s)</p>
        <p><strong>ETA:</strong> ${escape(m.eta)} min · <strong>Route:</strong> ${escape(m.route)}</p>
        <p><strong>Status:</strong> ${escape(m.status)}</p>
        ${m.reason ? `<p class="muted">${escape(m.reason)}</p>` : ""}
        ${m.warnings.map((w) => `<p class="muted">⚠ ${escape(w)}</p>`).join("")}

        <div class="button-row">
          <button class="secondary-button" data-mission="${escape(m.key)}" data-status="In Progress"
            ${m.status === "In Progress" ? "disabled" : ""}>Start Mission</button>
          <button class="primary-button" data-mission="${escape(m.key)}" data-status="Completed"
            ${m.status === "Completed" ? "disabled" : ""}>Complete Mission</button>
        </div>
      </article>`,
        )
        .join("");

      container.querySelectorAll("[data-mission]").forEach((button) => {
        button.addEventListener("click", () => {
          D.setMissionStatus(button.dataset.mission, button.dataset.status);
          renderMissions();
        });
      });
    }

    updateMetrics(missions);
  }

  // --------------------------------
  // METRICS + NETWORK
  // --------------------------------

  function updateMetrics(missions = currentMissions()) {
    $("assignedCount").textContent = missions.length;
    $("progressCount").textContent = missions.filter((m) => m.status === "In Progress").length;
    $("completedCount").textContent = missions.filter((m) => m.status === "Completed").length;
    $("responderPending").textContent =
      outbox().length + (D.connected ? D.sync?.localUnsynced || 0 : 0);
  }

  function renderNetworkStatus() {
    const pill = $("responderNetwork");

    if (!D.connected) {
      pill.textContent = "Backend unreachable · Saving locally";
      pill.classList.add("offline");
      pill.classList.remove("online");
      return;
    }

    const online = D.network.online;
    pill.textContent = online ? "Online · Live" : "Offline · Live";
    pill.classList.toggle("offline", !online);
    pill.classList.toggle("online", online);
  }

  // --------------------------------
  // TEAM SELECTION
  // --------------------------------

  $("teamSelect")?.addEventListener("change", (event) => {
    selectedTeam = event.target.value;
    renderTeamSummary();
    renderMissions();
  });

  // --------------------------------
  // FIELD REPORT FORM
  // --------------------------------

  $("reportForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const location = $("reportIncident").value;
    const type = $("reportType").value;
    const peopleCount = Number($("peopleCount").value);
    const description = $("reportDescription").value.trim();
    const message = $("reportMessage");
    const submit = event.submitter || $("reportForm").querySelector("[type=submit]");

    if (!location || !type || !description) {
      message.textContent = "Please complete all required fields.";
      return;
    }

    if (!Number.isFinite(peopleCount) || peopleCount < 0) {
      message.textContent = "Please enter a valid people count.";
      return;
    }

    const { incident, settlementId } = resolveLocation(location);
    const team = D.teams.find((t) => t.id === selectedTeam);

    const item = {
      teamId: selectedTeam,
      reporterName: team ? `${team.name} (field team)` : "Field team",
      incidentId: incident?.id || "",
      settlementId,
      type,
      peopleCount,
      description,
    };

    submit.disabled = true;
    message.textContent = "Sending report...";

    try {
      const result = await API.submitReport(toPayload({ ...item, createdAt: new Date().toISOString() }));
      const merged = D.incidents.find((i) => i.id === incident?.id);

      message.textContent =
        `Report ${result.report.id} ${result.report.synced ? "sent" : "saved on this node (offline) - it will sync when the network returns"}. ` +
        `Plan v${result.plan.version} drafted${merged ? ` for ${merged.id}` : ""}` +
        `${result.plan.status === "draft" ? " - awaiting coordinator approval." : "."}`;

      $("reportForm").reset();
      await load();
    } catch (error) {
      if (!error.status) {
        // Backend unreachable: keep the report on this device (offline-first)
        const saved = window.CrisisReports.addReport(item);
        message.textContent = `Backend unreachable. Report ${saved.id} saved on this device and will be sent automatically when the connection returns.`;
        $("reportForm").reset();
      } else {
        message.textContent = `Report rejected: ${error.message}`;
      }
      updateMetrics();
    } finally {
      submit.disabled = false;
    }
  });

  // --------------------------------
  // LOAD / LIVE UPDATES
  // --------------------------------

  async function load() {
    await D.refresh();

    approvedPlan = null;
    if (D.connected) {
      try {
        approvedPlan = await API.getApprovedPlan();
      } catch {
        approvedPlan = null;
      }
      if (await flushOutbox()) await D.refresh();
    }

    renderTeamSelect();
    renderIncidentSelect();
    renderTeamSummary();
    renderMissions();
    renderNetworkStatus();
  }

  load();

  let pending = null;
  const stopLive = API.connectLive((event) => {
    if (event.type === "hello") return;
    clearTimeout(pending);
    pending = setTimeout(load, 250);
  });

  const poll = setInterval(load, 8000);
  window.addEventListener("focus", load);
  window.addEventListener("beforeunload", () => {
    clearInterval(poll);
    stopLive();
  });

  console.log("CrisisMesh responder dashboard loaded");
});
