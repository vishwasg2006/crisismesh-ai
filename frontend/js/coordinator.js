// CrisisMesh AI - Coordinator Dashboard (live backend, with local demo fallback)

document.addEventListener("DOMContentLoaded", () => {
  const $ = (id) => document.getElementById(id);
  const escape = (value) => window.CrisisUtils.escapeHTML(value);
  const API = window.CrisisAPI;
  const D = window.CrisisData;
  const COORDINATOR = "coordinator";

  // --------------------------------
  // HELPERS
  // --------------------------------

  function say(html, isError = false) {
    const box = $("syncResult");
    box.hidden = false;
    box.innerHTML = html;
    box.style.borderColor = isError ? "#d83b43" : "";
  }

  function fail(error) {
    const offline = !error.status;
    say(
      `<strong>${offline ? "Backend not reachable" : "Request failed"}</strong>
       <p>${escape(error.message)}</p>`,
      true,
    );
  }

  async function withBusy(button, task) {
    if (button) button.disabled = true;
    try {
      await task();
    } catch (error) {
      fail(error);
    } finally {
      if (button) button.disabled = false;
      renderNetwork();
    }
  }

  const minutes = (value) =>
    value === null || value === undefined
      ? "-"
      : `${Math.round(value)} min`;

  // --------------------------------
  // INCIDENT DISPLAY
  // --------------------------------

  function renderIncidents() {
    const container = $("incidentList");
    if (!container) return;

    if (D.incidents.length === 0) {
      container.innerHTML = `<div class="empty-state">No active incidents.</div>`;
      return;
    }

    container.innerHTML = D.incidents
      .map(
        (incident) => `
          <button
            type="button"
            class="incident-card"
            data-incident-id="${escape(incident.id)}"
            style="text-align:left; width:100%; cursor:pointer;"
          >
            <div class="panel-heading">
              <strong>${escape(incident.title)}</strong>
              <span class="severity-${String(incident.severity).toLowerCase()}">
                ${escape(incident.severity)}
              </span>
            </div>

            <p class="muted">
              ${escape(incident.id)} · ${escape(incident.location)}
              ${D.connected ? ` · Priority #${escape(incident.priority)}` : ""}
            </p>

            <p>${escape(incident.peopleRange || incident.people)} people affected</p>
            ${
              D.connected && incident.reportIds?.length > 1
                ? incident.independentSources < incident.reportIds.length
                  ? `<span class="echo-badge">${escape(incident.reportIds.length)} reports = only ${escape(incident.independentSources)} independent source${incident.independentSources === 1 ? "" : "s"}</span>`
                  : `<span class="indep-badge">${escape(incident.reportIds.length)} reports · ${escape(incident.independentSources)} independent</span>`
                : ""
            }

            <small>
              ${escape(incident.status)}
              ${(incident.flags || []).map((f) => ` · ${escape(f.type.replace(/_/g, " "))}`).join("")}
              · Click to view details
            </small>
          </button>
        `,
      )
      .join("");

    container.querySelectorAll("[data-incident-id]").forEach((button) => {
      button.addEventListener("click", () => {
        showIncidentDetails(
          D.incidents.find((item) => item.id === button.dataset.incidentId),
        );
      });
    });
  }

  // --------------------------------
  // INCIDENT DETAILS POPUP
  // --------------------------------

  function showIncidentDetails(incident) {
    if (!incident) return;

    let modal = $("incident-modal");

    if (!modal) {
      modal = document.createElement("div");
      modal.id = "incident-modal";
      modal.className = "modal-backdrop";

      modal.innerHTML = `
        <section class="modal-card" role="dialog" aria-modal="true">
          <button type="button" class="modal-close" id="close-modal">×</button>
          <div id="incident-modal-content"></div>
        </section>
      `;

      document.body.appendChild(modal);
    }

    const flags = (incident.flags || [])
      .map((f) => `<li>${escape(f.message)}</li>`)
      .join("");

    $("incident-modal-content").innerHTML = `
      <p class="eyebrow">INCIDENT DETAILS</p>

      <h2>${escape(incident.title)}</h2>

      <p><strong>Incident ID:</strong> ${escape(incident.id)}</p>
      <p><strong>Location:</strong> ${escape(incident.location)}</p>
      <p><strong>Severity:</strong> ${escape(incident.severity)}</p>
      <p><strong>People affected:</strong> ${escape(incident.peopleRange || incident.people)}</p>
      <p><strong>Status:</strong> ${escape(incident.status)}</p>
      ${
        incident.reportIds?.length
          ? `<p><strong>Evidence:</strong> ${escape(incident.reportIds.length)} report(s) from ${escape(incident.independentSources)} independent source(s). Copies of the same message count once.</p>`
          : ""
      }
      ${
        incident.timeLeftMin !== null && incident.timeLeftMin !== undefined
          ? `<p><strong>Time before access is lost:</strong> ~${escape(incident.timeLeftMin)} min</p>`
          : ""
      }
      ${
        incident.needs?.length
          ? `<p><strong>Needs:</strong> ${escape(incident.needs.join(", "))}</p>`
          : ""
      }
      ${incident.vulnerable ? `<p><strong>Vulnerable people present</strong></p>` : ""}

      <hr>

      <p>${escape(incident.description)}</p>

      ${
        incident.explanation
          ? `<p><strong>Why this priority:</strong> ${escape(incident.explanation)}</p>`
          : ""
      }
      ${flags ? `<p><strong>Data-quality flags</strong></p><ul>${flags}</ul>` : ""}

      <button type="button" class="primary-button" id="focus-map-btn">
        Locate on map
      </button>
    `;

    modal.hidden = false;
    modal.classList.add("active");

    $("close-modal").onclick = closeModal;
    modal.onclick = (event) => {
      if (event.target === modal) closeModal();
    };

    $("focus-map-btn").onclick = () => {
      window.CrisisMap?.focusIncident(incident.id);
      closeModal();
      $("emergencyMap")?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
  }

  function closeModal() {
    const modal = $("incident-modal");
    if (modal) {
      modal.hidden = true;
      modal.classList.remove("active");
    }
  }

  // --------------------------------
  // RESPONSE PLAN + PRIORITIES
  // --------------------------------

  function renderPriorities() {
    const container = $("approvalList");
    if (!container) return;

    const plan = D.plan;

    // Local demo fallback: plain priority list
    if (!plan) {
      container.innerHTML = [...D.incidents]
        .sort((a, b) => a.priority - b.priority)
        .map(
          (incident) => `
          <div class="approval-item">
            <strong>${escape(incident.id)}</strong>
            <span>${escape(incident.title)}</span>
            <span class="severity-${String(incident.severity).toLowerCase()}">${escape(incident.severity)}</span>
          </div>`,
        )
        .join("");
      return;
    }

    const isDraft = plan.status === "draft";
    const s = plan.summary;

    const header = `
      <div class="approval-item" style="display:block">
        <strong>Plan v${escape(plan.version)} · ${escape(plan.status)} · ${escape(plan.mode)}</strong>
        <p class="muted">
          ${escape(s.peopleCovered)} of ${escape(s.peopleAtRisk)} people covered ·
          ${escape(s.resourcesUsed)}/${escape(s.resourcesTotal)} resources used
          ${s.conflicts ? ` · ${escape(s.conflicts)} conflict(s)` : ""}
        </p>
        ${
          isDraft
            ? `<div class="button-row">
                 <button type="button" class="primary-button" data-plan-action="approve">✓ Approve plan</button>
                 <button type="button" class="danger-button" data-plan-action="reject">✕ Reject</button>
               </div>`
            : plan.approvedBy
              ? `<small class="muted">By ${escape(plan.approvedBy)}${plan.note ? ": " + escape(plan.note) : ""}</small>`
              : ""
        }
      </div>`;

    const assignments = plan.assignments
      .map(
        (a) => `
        <div class="approval-item" style="display:block">
          <strong>${escape(a.resourceName)} → ${escape(a.settlementName)}</strong>
          <p class="muted">
            ${escape(a.peopleServed)} people · ${escape(a.trips)} trip(s) ·
            ETA ${escape(minutes(a.etaMin))} · done by ${escape(minutes(a.finishMin))}
            ${a.atRisk ? " · ⚠ at risk" : ""}${a.locked ? " · 🔒 manual" : ""}
          </p>
        </div>`,
      )
      .join("");

    const unassigned = plan.unassigned
      .map(
        (u) => `
        <div class="approval-item" style="display:block">
          <strong class="critical-text">Unassigned: ${escape(u.settlementName)}</strong>
          <p class="muted">${escape(u.peopleRemaining)} people · ${escape(u.reason)}</p>
        </div>`,
      )
      .join("");

    const priorities = plan.priorities
      .map((p) => {
        const incident = D.incidents.find((i) => i.id === p.incidentId);
        return `
        <div class="approval-item">
          <strong>#${escape(p.rank)}</strong>
          <span>${escape(incident ? incident.location : p.incidentId)}</span>
          <span class="muted">score ${escape(Math.round(p.score * 100) / 100)}</span>
        </div>`;
      })
      .join("");

    const warnings = (plan.warnings || [])
      .map((w) => `<p class="muted">⚠ ${escape(w)}</p>`)
      .join("");

    container.innerHTML = header + assignments + unassigned + priorities + warnings;
  }

  $("approvalList")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-plan-action]");
    if (!button || !D.plan) return;

    const planId = D.plan.id;

    if (button.dataset.planAction === "approve") {
      if (!confirm("Approve this response plan for field teams?")) return;
      withBusy(button, async () => {
        await API.approvePlan(planId, COORDINATOR);
        say("<strong>Plan approved.</strong><p>Field teams now see their assignments.</p>");
        await reload();
      });
    } else {
      const reason = prompt("Reason for rejecting this plan:");
      if (reason === null) return;
      withBusy(button, async () => {
        await API.rejectPlan(planId, COORDINATOR, reason.trim());
        say("<strong>Plan rejected.</strong>");
        await reload();
      });
    }
  });

  // --------------------------------
  // TEAM / RESOURCE DISPLAY
  // --------------------------------

  function renderTeams() {
    const container = $("teamList");
    if (!container) return;

    container.innerHTML = D.teams
      .map(
        (team) => `
          <article class="team-card">
            <h3>${escape(team.name)}</h3>
            <p>${escape(team.type)}${team.mode ? ` · ${escape(team.mode)}` : ""}</p>
            <p>Capacity: ${escape(team.capacity)}</p>
            <span class="team-status">${escape(team.status)}</span>
          </article>
        `,
      )
      .join("");
  }

  // --------------------------------
  // FIELD REPORTS
  // --------------------------------

  function renderFieldReports() {
    const reports = D.reports || [];
    const reportsContainer = $("fieldReportsList");
    const countLabel = $("reportCountLabel");

    const pendingReview = reports.filter(
      (report) => !report.reviewStatus || report.reviewStatus === "pending",
    );

    if (countLabel) {
      countLabel.textContent = `${pendingReview.length} Awaiting Review`;
    }

    if (!reportsContainer) return;

    if (reports.length === 0) {
      reportsContainer.innerHTML = `<div class="empty-state">No field reports received yet.</div>`;
      return;
    }

    const sortedReports = [...reports].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    );

    reportsContainer.innerHTML = sortedReports
      .map((report) => {
        let related = [];
        if (D.connected) {
          related = (report.relatedReportIds || []).map((id) => ({
            reportId: id,
            similarity: null,
          }));
        } else {
          related = window.CrisisReports.getReportFlags(report, reports).duplicateMatches;
        }
        const isDuplicate = related.length > 0;
        const reviewStatus = report.reviewStatus || "pending";

        const badge =
          reviewStatus === "verified"
            ? `<span class="review-badge verified">Verified</span>`
            : reviewStatus === "rejected"
              ? `<span class="review-badge rejected">Rejected</span>`
              : `<span class="review-badge awaiting">Awaiting Review</span>`;

        const duplicateWarning = isDuplicate
          ? `
        <div class="duplicate-warning">
          <strong>⚠ ${D.connected ? "Merged with other reports" : "Possible Duplicate Report"}</strong>
          <p>${D.connected ? "The backend grouped this with the same incident as:" : "This report may match:"}</p>
          ${related
            .map(
              (m) => `<p>${escape(m.reportId)}${
                m.similarity === null ? "" : ` (${Math.round(m.similarity * 100)}% similarity)`
              }</p>`,
            )
            .join("")}
        </div>`
          : "";

        const actions =
          reviewStatus === "pending"
            ? `
        <div class="report-actions">
          <button type="button" class="primary-button" data-review-action="verify" data-report-id="${escape(report.id)}">✓ Verify Report</button>
          <button type="button" class="danger-button" data-review-action="reject" data-report-id="${escape(report.id)}">✕ Reject Report</button>
        </div>`
            : "";

        const rejection =
          reviewStatus === "rejected"
            ? `<div class="rejection-reason"><strong>Rejection reason:</strong><p>${escape(report.reviewReason || "No reason provided")}</p></div>`
            : "";

        return `
      <article class="incident-card report-card ${isDuplicate ? "duplicate-report" : ""}">
        <div class="panel-heading">
          <strong>${escape(report.id)}</strong>
          ${badge}
        </div>

        ${duplicateWarning}

        <p><strong>Reporter:</strong> ${escape(report.teamId || "Unknown")}</p>
        <p><strong>Incident:</strong> ${escape(report.incidentId || "Unknown")}</p>
        <p><strong>Source:</strong> ${escape(report.type || "Unknown")}</p>
        <p><strong>People affected:</strong> ${escape(report.peopleCount ?? 0)}</p>
        <p><strong>Description:</strong> ${escape(report.description || "No description")}</p>
        <p><strong>Synchronization:</strong> ${report.synced === true ? "Synchronized" : "Pending Synchronization"}</p>
        <p class="muted">Submitted: ${escape(window.CrisisUtils.formatTime(report.createdAt))}</p>
        ${
          report.reviewedAt
            ? `<p class="muted">Reviewed: ${escape(window.CrisisUtils.formatTime(report.reviewedAt))}</p>`
            : ""
        }
        ${rejection}
        ${actions}
      </article>`;
      })
      .join("");
  }

  function reviewFieldReport(reportId, action) {
    const report = D.reports.find((item) => String(item.id) === String(reportId));

    if (!report) return alert("Report not found.");
    if (report.reviewStatus && report.reviewStatus !== "pending") {
      return alert("This report has already been reviewed.");
    }

    let status;
    let reason = "";

    if (action === "verify") {
      if (!confirm("Are you sure you want to verify this field report?")) return;
      status = "verified";
    } else if (action === "reject") {
      const input = prompt("Enter the reason for rejecting this report:");
      if (input === null) return;
      if (!input.trim()) return alert("Please provide a rejection reason.");
      status = "rejected";
      reason = input.trim();
    } else {
      return;
    }

    if (D.connected) {
      D.setReview(reportId, status, reason);
    } else {
      // demo fallback keeps the review inside the local report store
      const reports = window.CrisisReports.getReports();
      const local = reports.find((item) => String(item.id) === String(reportId));
      if (local) {
        local.reviewStatus = status;
        local.reviewReason = reason;
        local.reviewedAt = new Date().toISOString();
        window.CrisisReports.saveReports(reports);
      }
    }

    reload();
  }

  $("fieldReportsList")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-review-action]");
    if (!button) return;
    reviewFieldReport(button.dataset.reportId, button.dataset.reviewAction);
  });

  // --------------------------------
  // METRICS
  // --------------------------------

  function renderMetrics() {
    const critical = D.incidents.filter((i) => i.severity === "Critical").length;
    const available = D.teams.filter((t) => t.status === "Available").length;
    const pending = D.connected
      ? (D.sync?.localUnsynced || 0) + (D.sync?.inboxPending || 0)
      : window.CrisisReports.getPendingCount();

    $("totalIncidents").textContent = D.incidents.length;
    $("criticalIncidents").textContent = critical;
    $("availableTeams").textContent = available;
    $("pendingReports").textContent = pending;
  }

  // --------------------------------
  // NETWORK DISPLAY
  // --------------------------------

  function renderNetwork() {
    const pill = $("connectionStatus");
    const details = $("networkDetails");

    if (!D.connected) {
      pill.textContent = "Backend unreachable · Demo data";
      pill.classList.add("offline");
      pill.classList.remove("online");
      details.textContent = `Cannot reach ${API.ORIGIN}. Start the backend (npm run dev in /backend) - showing local demo data.`;
      $("offlineBtn").disabled = true;
      $("reconnectBtn").disabled = true;
      return;
    }

    const online = D.network.online;
    pill.textContent = online ? "Online · Live" : "Offline · Live";
    pill.classList.toggle("offline", !online);
    pill.classList.toggle("online", online);

    const sync = D.sync || {};
    details.textContent = online
      ? `Node is online. ${sync.inboxPending || 0} remote report(s) waiting, ${sync.localUnsynced || 0} local report(s) unsynced.`
      : `Node is offline since ${window.CrisisUtils.formatTime(D.network.changedAt)}. Planning continues locally; ${sync.inboxPending || 0} remote report(s) are waiting in the inbox and ${sync.localUnsynced || 0} local report(s) await sync.`;

    $("offlineBtn").disabled = !online;
    $("reconnectBtn").disabled = online;
    if ($("remoteBtn")) $("remoteBtn").disabled = false;
    if ($("tickBtn")) $("tickBtn").disabled = false;
  }

  // --------------------------------
  // BUTTON EVENTS
  // --------------------------------

  $("offlineBtn")?.addEventListener("click", (e) =>
    withBusy(e.currentTarget, async () => {
      await API.setNetwork(false);
      await reload();
      say("<strong>Node is offline.</strong><p>Reports are stored locally and the plan keeps updating from local data.</p>");
    }),
  );

  $("reconnectBtn")?.addEventListener("click", (e) =>
    withBusy(e.currentTarget, async () => {
      const result = await API.setNetwork(true);
      await reload();
      const sync = result.sync;
      say(
        sync && sync.planId
          ? `<strong>Reconnected and synced.</strong>
             <p>Pulled ${escape(sync.pulled)} remote report(s), pushed ${escape(sync.pushed)} local report(s),
             merged into ${escape(sync.mergedIntoExisting)} existing incident(s), ${escape(sync.conflicts)} conflict(s).</p>
             <p class="muted">A new plan draft was created - use “View Plan Changes” to see what changed.</p>`
          : "<strong>Reconnected.</strong><p>Nothing needed syncing.</p>",
      );
    }),
  );

  $("remoteBtn")?.addEventListener("click", (e) =>
    withBusy(e.currentTarget, async () => {
      const result = await API.receiveRemoteReports();
      await reload();
      say(
        result.delivered
          ? `<strong>Remote reports delivered.</strong><p>${escape(result.queued)} report(s) merged and the plan was recomputed.</p>`
          : `<strong>Remote reports queued.</strong><p>${escape(result.queued)} report(s) wait in the inbox until you reconnect.</p>`,
      );
    }),
  );

  $("tickBtn")?.addEventListener("click", (e) =>
    withBusy(e.currentTarget, async () => {
      const result = await API.tick(30);
      await reload();
      say(
        `<strong>Simulated +30 minutes.</strong>
         ${(result.diff || []).map((d) => `<p>${escape(d)}</p>`).join("") || "<p>No plan changes.</p>"}`,
      );
    }),
  );

  $("diffBtn")?.addEventListener("click", () => {
    if (!D.connected || !D.plan) {
      return say("Plan changes need the backend (none reachable).", true);
    }

    const diff = D.plan.diff;
    const items = diff?.items || [];

    say(`
      <strong>Plan v${escape(D.plan.version)} vs v${escape(diff?.againstVersion ?? "-")}</strong>
      ${(diff?.summary || ["No baseline plan to compare with"]).map((l) => `<p>${escape(l)}</p>`).join("")}
      ${items
        .map(
          (i) => `<p class="muted">${escape(i.type)} · ${escape(i.settlementName)}: ${escape(i.detail)}</p>`,
        )
        .join("")}
      ${D.plan.narrative ? `<p class="muted">${escape(D.plan.narrative)}</p>` : ""}
    `);
  });

  $("refreshBtn")?.addEventListener("click", () => reload());

  $("resetBtn")?.addEventListener("click", (e) => {
    if (!confirm("Reset the scenario? This reloads the synthetic flood scenario and clears local review marks.")) return;

    withBusy(e.currentTarget, async () => {
      if (D.connected) await API.resetScenario();
      window.CrisisReports.clearReports();
      window.CrisisOffline.reconnect();
      D.clearReviews();
      D.clearMissionStatus();
      await reload();
      say("<strong>Scenario reset.</strong>");
    });
  });

  // --------------------------------
  // MAP
  // --------------------------------

  function renderMap() {
    if (!window.CrisisMap) return;
    const s = D.state;
    window.CrisisMap.initialize(D.incidents, {
      settlements: s?.settlements || [],
      routes: s?.routes || [],
      assignments: D.plan?.assignments || [],
    });
  }

  // --------------------------------
  // RENDER / LOAD
  // --------------------------------

  // --------------------------------
  // SPLIT-BRAIN MERGE
  // --------------------------------

  const PEER_KEY = "crisismesh_peer_url";

  function renderMerge() {
    const panel = $("mergePanel");
    if (!panel) return;
    const st = D.state;
    const banner = $("splitBanner");
    if (!st) {
      $("mergeConflicts").innerHTML = '<div class="empty-state">Backend not connected.</div>';
      $("claimsList").innerHTML = "";
      if (banner) banner.hidden = true;
      return;
    }
    $("nodeName").textContent = st.node || "-";

    const conflicts = st.mergeConflicts || [];
    const claims = st.claims || [];
    const open = conflicts.filter((c) => c.status === "needs_human");

    if (banner) {
      banner.hidden = open.length === 0;
      banner.innerHTML = open.length
        ? `⚠ SPLIT-BRAIN: ${open.length} resource(s) were approved twice by different coordinators for overlapping work. They are frozen until a human decides. <button type="button" class="secondary-button" onclick="document.getElementById('mergePanel').scrollIntoView({behavior:'smooth'})">Review</button>`
        : "";
    }

    const claimById = new Map(claims.map((c) => [c.id, c]));
    $("mergeConflicts").innerHTML = conflicts.length
      ? conflicts
          .map((c) => {
            const hum = c.status === "needs_human";
            const buttons = hum
              ? c.claimIds
                  .map((id) => {
                    const cl = claimById.get(id);
                    const label = cl
                      ? `Keep ${cl.resourceId} → ${cl.settlementName} (approved by ${cl.approvedBy || cl.nodeId})`
                      : `Keep ${id}`;
                    return `<button type="button" class="primary-button" data-keep="${escape(id)}" data-conflict="${escape(c.id)}">${escape(label)}</button>`;
                  })
                  .join("")
              : "";
            return `<div class="merge-item ${hum ? "" : "auto"}">
              <strong>${escape(c.kind.replace(/_/g, " "))}</strong> · ${escape(c.status.replace(/_/g, " "))} · ${escape(c.resourceId)}
              <p class="muted">${escape(c.message)}</p>
              ${hum ? `<div class="button-row">${buttons}</div>` : ""}
            </div>`;
          })
          .join("")
      : '<div class="empty-state">No merge conflicts. Nothing approved has been changed by a merge.</div>';

    const shown = claims.filter((c) => c.status !== "proposed" || c.nodeId !== st.node);
    $("claimsList").innerHTML = shown.length
      ? `<table class="claim-table"><tr><th>Resource</th><th>Assigned to</th><th>Decided on</th><th>State</th></tr>${shown
          .map(
            (c) =>
              `<tr><td>${escape(c.resourceId)}</td><td>${escape(c.settlementName)}</td><td>${escape(c.nodeId)}${c.approvedBy ? " · " + escape(c.approvedBy) : ""}</td><td><span class="pill ${escape(c.status)}">${escape(c.status)}</span>${c.contested ? " <strong>CONTESTED</strong>" : ""}</td></tr>`,
          )
          .join("")}</table>`
      : '<p class="muted">No approved assignments yet. Approve a plan to commit boats.</p>';
  }

  $("peerUrl") && ($("peerUrl").value = localStorage.getItem(PEER_KEY) || "");

  $("peerSyncBtn")?.addEventListener("click", () => {
    const url = $("peerUrl").value.trim();
    if (!url) return say("<strong>Enter the other coordinator's address first.</strong>", true);
    localStorage.setItem(PEER_KEY, url);
    withBusy($("peerSyncBtn"), async () => {
      const r = await API.peerSync(url);
      const m = r.merged;
      say(
        `<strong>Merged with ${escape(m.peer)}.</strong>
         <p>${escape(m.reportsPulled)} report(s) pulled · ${escape(m.conflicts.length)} conflict(s) ·
         ${escape(m.needsHuman)} need a human · approved assignments changed by merge: ${escape(m.approvedAssignmentsChanged)}.
         ${r.peerAlsoMerged ? "The other coordinator also received our state." : "The other coordinator could not be updated."}</p>`,
      );
      await reload();
    });
  });

  $("mergeConflicts")?.addEventListener("click", (event) => {
    const b = event.target.closest("[data-keep]");
    if (!b) return;
    if (!confirm("Keep this assignment and revoke the other? A new draft plan will need your approval.")) return;
    withBusy(b, async () => {
      await API.resolveConflict(b.dataset.conflict, b.dataset.keep, COORDINATOR);
      say("<strong>Conflict resolved by a human.</strong><p>A new draft plan was created. Review and approve it.</p>");
      await reload();
    });
  });

  function renderAll() {
    renderIncidents();
    renderPriorities();
    renderTeams();
    renderFieldReports();
    renderMetrics();
    renderNetwork();
    renderMap();
    renderMerge();
  }

  async function reload() {
    await D.refresh();
    renderAll();
  }

  reload();

  // Live updates: WebSocket pushes, plus a slow poll that also recovers a dropped backend.
  let pending = null;
  const scheduleReload = () => {
    clearTimeout(pending);
    pending = setTimeout(reload, 250);
  };

  const stopLive = API.connectLive(
    (event) => {
      if (event.type !== "hello") scheduleReload();
    },
    () => {},
  );

  const poll = setInterval(reload, 8000);

  window.addEventListener("focus", reload);
  window.addEventListener("beforeunload", () => {
    clearInterval(poll);
    stopLive();
  });

  console.log("CrisisMesh coordinator dashboard loaded");
});
