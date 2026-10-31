// CrisisMesh AI - Field Responder Dashboard (live backend, offline outbox)

document.addEventListener("DOMContentLoaded", () => {
  if (window.CrisisAuth?.blocked) return;
  const $ = (id) => document.getElementById(id);
  const escape = (value) => window.CrisisUtils.escapeHTML(value);
  const API = window.CrisisAPI;
  const D = window.CrisisData;

  let selectedTeam = null;
  let approvedPlan = null;
  let draftPlan = null; // newest plan still waiting for the coordinator
  const me = window.CrisisAuth?.user || null;
  // a responder login is tied to one team/boat; coordinators may look at any team
  const lockedTeam = null;
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
    const teams = lockedTeam ? D.teams.filter((t) => t.id === lockedTeam) : D.teams;
    const key = teams.map((t) => t.id).join("|");

    if (key !== teamOptionsKey) {
      teamOptionsKey = key;
      select.innerHTML = teams
        .map((t) => `<option value="${escape(t.id)}">${escape(t.name)}</option>`)
        .join("");
    }

    if (lockedTeam) selectedTeam = lockedTeam;
    else if (!teams.some((t) => t.id === selectedTeam)) {
      selectedTeam = teams[0]?.id || null;
    }
    select.value = selectedTeam || "";
    select.disabled = !!lockedTeam;
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

  // Status flow:  Pending approval -> Pending -> In Progress -> Completed  (see data.js buildMissions)
  const currentMissions = () => D.buildMissions(selectedTeam);

  const STATUS_CLASS = {
    "Pending approval": "awaiting",
    Pending: "pending",
    "In Progress": "progress",
    Completed: "completed",
  };

  function renderMissions() {
    const container = $("missionList");
    const missions = currentMissions();

    if (!D.connected) {
      container.innerHTML = `<div class="empty-state">Backend unreachable – missions cannot be loaded. Reports you submit are saved on this device and sent automatically later.</div>`;
    } else if (missions.length === 0 && !approvedPlan) {
      container.innerHTML = `<div class="empty-state">No plan yet – waiting for the coordinator to approve a response plan.</div>`;
    } else if (missions.length === 0) {
      container.innerHTML = `<div class="empty-state">No missions currently assigned to this team (plan v${escape(approvedPlan.version)}).</div>`;
    } else {
      container.innerHTML = missions
        .map(
          (m) => `
      <article class="mission-card">
        <div class="card-head">
          <h3>${escape(m.title)}</h3>
          <span class="mission-status ${STATUS_CLASS[m.status] || ""}">${escape(m.status)}</span>
        </div>

        <p><strong>Incident:</strong> ${escape(m.incidentId)}</p>
        <p><strong>Location:</strong> ${escape(m.location)}</p>
        <p><strong>People to move:</strong> ${escape(m.people)} in ${escape(m.trips)} trip(s)</p>
        <p><strong>ETA:</strong> ${escape(m.eta)} min · <strong>Route:</strong> ${escape(m.route)}</p>
        <p><strong>Status:</strong> ${escape(m.status)}</p>
        ${m.reason ? `<p class="muted">${escape(m.reason)}</p>` : ""}
        ${m.warnings.map((w) => `<p class="muted">⚠ ${escape(w)}</p>`).join("")}

        <div class="button-row">
          <button type="button" class="secondary-button" data-mission="${escape(m.key)}" data-status="In Progress"
            ${m.status === "Pending" ? "" : "disabled"}>Start Mission</button>
          <button type="button" class="primary-button" data-mission="${escape(m.key)}" data-status="Completed"
            ${m.status === "In Progress" ? "" : "disabled"}>Complete Mission</button>
        </div>
      </article>`,
        )
        .join("");

      container.querySelectorAll("button[data-mission]:not([disabled])").forEach((button) => {
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            await D.setMissionStatus(button.dataset.mission, button.dataset.status);
          } catch (error) {
            alert(`Could not update mission: ${error.message}`);
          }
          renderMissions();
        });
      });
    }

    updateMetrics(missions);
  }

  // --------------------------------
  // MY REPORTS (status of what this team has sent)
  // --------------------------------
  // Queued offline -> Pending review (sent, coordinator has not looked yet) -> Verified / Rejected

  function myReports() {
    const team = D.teams.find((t) => t.id === selectedTeam);
    if (!team) return [];

    const mine = (name) => String(name || "") === `${team.name} (field team)`;

    const queued = outbox()
      .filter((r) => r.teamId === selectedTeam)
      .map((r) => ({
        id: r.id,
        label: "Queued offline",
        css: "queued",
        text: `${r.type}: ${r.description}`,
        at: r.createdAt,
        pending: true,
      }));

    const sent = (D.connected ? D.reports : [])
      .filter((r) => mine(r.teamId))
      .map((r) => {
        const label = { verified: "Verified", rejected: "Rejected" }[r.reviewStatus] || "Pending review";
        return {
          id: r.id,
          label,
          css: { Verified: "completed", Rejected: "rejected" }[label] || "pending",
          text: r.description,
          at: r.createdAt,
          pending: label === "Pending review",
        };
      });

    return [...queued, ...sent].sort((a, b) => new Date(b.at) - new Date(a.at));
  }

  function renderMyReports(list = myReports()) {
    const box = $("myReports");
    if (!box) return;

    box.innerHTML = list.length
      ? list
          .slice(0, 8)
          .map(
            (r) => `
        <div class="report-row">
          <div>
            <strong>${escape(r.id)}</strong>
            <p>${escape(r.text)}</p>
          </div>
          <span class="mission-status ${r.css}">${escape(r.label)}</span>
        </div>`,
          )
          .join("")
      : `<div class="empty-state">No reports sent by this team yet.</div>`;
  }

  // --------------------------------
  // METRICS + NETWORK
  // --------------------------------

  function updateMetrics(missions = currentMissions()) {
    $("assignedCount").textContent = missions.length;
    $("progressCount").textContent = missions.filter((m) => m.status === "In Progress").length;
    $("completedCount").textContent = missions.filter((m) => m.status === "Completed").length;
    const reports = myReports();
    $("responderPending").textContent = reports.filter((r) => r.pending).length;
    renderMyReports(reports);
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
    draftPlan = null;
    if (D.connected) {
      try {
        approvedPlan = await API.getApprovedPlan();
      } catch {
        approvedPlan = null;
      }
      try {
        const latest = await API.getLatestPlan();
        if (latest && latest.status === "draft") draftPlan = latest;
      } catch {
        draftPlan = null;
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
