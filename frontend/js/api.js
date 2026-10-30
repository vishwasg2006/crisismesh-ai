// CrisisMesh AI - Backend API client
//
// Backend URL resolution (first match wins):
//   1. ?api=http://host:4000   in the page URL (remembered in localStorage)
//   2. the page is served by the backend itself (port 4000)  -> same origin
//   3. http://localhost:4000

(function () {
  const KEY = "crisismesh_api_base";

  function resolveBase() {
    try {
      const fromQuery = new URLSearchParams(location.search).get("api");
      if (fromQuery) {
        localStorage.setItem(KEY, fromQuery.replace(/\/+$/, ""));
      }
      const saved = localStorage.getItem(KEY);
      if (saved) return saved;
    } catch {
      /* storage unavailable */
    }

    if (
      location.protocol.startsWith("http") &&
      (location.port === "4000" || location.pathname.startsWith("/app/"))
    ) {
      return location.origin;
    }
    return "http://localhost:4000";
  }

  const ORIGIN = resolveBase();

  window.CrisisAPI = {
    ORIGIN,
    BASE_URL: `${ORIGIN}/api`,
    WS_URL: ORIGIN.replace(/^http/, "ws") + "/ws",

    async request(endpoint, options = {}, timeoutMs = 20000) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(`${this.BASE_URL}${endpoint}`, {
          ...options,
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            ...(options.headers || {}),
          },
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          const error = new Error(data.error || `API error: ${response.status}`);
          error.status = response.status;
          throw error;
        }

        return data;
      } finally {
        clearTimeout(timeout);
      }
    },

    post(endpoint, body = {}, timeoutMs) {
      return this.request(
        endpoint,
        { method: "POST", body: JSON.stringify(body) },
        timeoutMs,
      );
    },

    // ---- read
    health() {
      return this.request("/health", {}, 3000);
    },
    getState() {
      return this.request("/state", {}, 8000);
    },
    getApprovedPlan() {
      return this.request("/plans/approved", {}, 8000).catch((error) => {
        if (error.status === 404) return null;
        throw error;
      });
    },

    // ---- reports
    submitReport(report) {
      return this.post("/reports", report, 30000);
    },

    // ---- network / sync
    setNetwork(online) {
      return this.post("/network", { online }, 30000);
    },
    syncNow() {
      return this.post("/sync", {}, 30000);
    },
    receiveRemoteReports() {
      return this.post("/sync/remote-inbox", { demo: true }, 30000);
    },

    // ---- plans (human in the loop)
    approvePlan(id, by, note) {
      return this.post(`/plans/${encodeURIComponent(id)}/approve`, { by, note });
    },
    rejectPlan(id, by, reason) {
      return this.post(`/plans/${encodeURIComponent(id)}/reject`, { by, reason });
    },
    replan() {
      return this.post("/plans/replan", {}, 30000);
    },

    // ---- split-brain / peer coordinator merge
    peerSync(peerUrl) {
      return this.post("/peer/sync", { peerUrl }, 30000);
    },
    resolveConflict(id, keepClaimId, by, note) {
      return this.post(`/merge/conflicts/${encodeURIComponent(id)}/resolve`, { keepClaimId, by, note });
    },

    // ---- simulation
    tick(minutes = 30) {
      return this.post("/simulate/tick", { minutes }, 30000);
    },
    resetScenario() {
      return this.post("/scenario/reset", {}, 30000);
    },

    // ---- live updates (WebSocket, auto-reconnect). Returns a stop() function.
    connectLive(onEvent, onStatus) {
      let socket = null;
      let stopped = false;
      let retry = null;

      const open = () => {
        if (stopped) return;
        try {
          socket = new WebSocket(this.WS_URL);
        } catch {
          retry = setTimeout(open, 4000);
          return;
        }
        socket.onopen = () => onStatus?.(true);
        socket.onmessage = (message) => {
          try {
            onEvent(JSON.parse(message.data));
          } catch {
            /* ignore malformed frames */
          }
        };
        socket.onclose = () => {
          onStatus?.(false);
          if (!stopped) retry = setTimeout(open, 4000);
        };
        socket.onerror = () => socket.close();
      };

      open();

      return () => {
        stopped = true;
        clearTimeout(retry);
        socket?.close();
      };
    },
  };

  console.log("CrisisMesh API module loaded ->", window.CrisisAPI.BASE_URL);
})();
