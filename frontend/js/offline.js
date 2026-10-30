// CrisisMesh AI - Offline Simulation

window.CrisisOffline = {
  STORAGE_KEY: "crisismesh_network",

  getState() {
    return window.CrisisUtils.getStorage(this.STORAGE_KEY, {
      mode: "online",
      offlineSince: null,
    });
  },

  saveState(state) {
    window.CrisisUtils.setStorage(this.STORAGE_KEY, state);
  },

  isOffline() {
    return this.getState().mode === "offline";
  },

  goOffline() {
    const state = {
      mode: "offline",
      offlineSince: new Date().toISOString(),
    };

    this.saveState(state);
    return state;
  },

  reconnect() {
    const state = {
      mode: "online",
      offlineSince: null,
    };

    this.saveState(state);
    return state;
  },

  getPendingCount() {
    const reports = window.CrisisReports
      ? window.CrisisReports.getReports()
      : [];

    return reports.filter((report) => !report.synced).length;
  },
};

console.log("CrisisMesh offline module loaded");
