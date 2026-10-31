(function () {
  const STORAGE_KEY = "crisismesh_reports";

  function getReports() {
    return window.CrisisUtils.getStorage(STORAGE_KEY, []) || [];
  }

  function saveReports(reports) {
    window.CrisisUtils.setStorage(STORAGE_KEY, reports);
  }

  function addReport(report) {
    const reports = getReports();

    const newReport = {
      ...report,
      id: report.id || window.CrisisUtils.createId("REPORT"),
      createdAt: report.createdAt || new Date().toISOString(),
      synced: false,
      reviewStatus: report.reviewStatus || "pending",
      reviewReason: report.reviewReason || "",
      reviewedAt: report.reviewedAt || null,
    };

    reports.push(newReport);
    saveReports(reports);

    return newReport;
  }

  // Synchronization and review are independent states.
  function getPendingReports() {
    return getReports().filter((report) => report.synced !== true);
  }

  function getPendingCount() {
    return getPendingReports().length;
  }

  function markAllSynced() {
    const reports = getReports().map((report) => ({
      ...report,
      synced: true,
    }));

    saveReports(reports);
  }

  function clearReports() {
    saveReports([]);
  }

  function normalizeText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function calculateSimilarity(first, second) {
    const wordsA = new Set(normalizeText(first).split(" ").filter(Boolean));
    const wordsB = new Set(normalizeText(second).split(" ").filter(Boolean));

    if (!wordsA.size || !wordsB.size) return 0;

    const commonWords = [...wordsA].filter((word) => wordsB.has(word));
    const totalWords = new Set([...wordsA, ...wordsB]);

    return commonWords.length / totalWords.size;
  }

  function isWithinTimeWindow(first, second) {
    const firstTime = new Date(first.createdAt).getTime();
    const secondTime = new Date(second.createdAt).getTime();

    if (!Number.isFinite(firstTime) || !Number.isFinite(secondTime)) {
      return false;
    }

    return Math.abs(firstTime - secondTime) <= 15 * 60 * 1000;
  }

  // Identify potentially correlated reports.
  // Similarity is a warning, NOT proof of fake reporting.
  function getDuplicateMatches(report, allReports = getReports()) {
    if (!report || !report.incidentId || !report.type) {
      return [];
    }

    return allReports
      .filter((other) => {
        if (other.id === report.id) return false;

        const sameIncident =
          String(other.incidentId) === String(report.incidentId);

        const sameType =
          normalizeText(other.type) === normalizeText(report.type);

        const closeInTime = isWithinTimeWindow(report, other);

        const similarity = calculateSimilarity(
          report.description,
          other.description,
        );

        return sameIncident && sameType && closeInTime && similarity >= 0.6;
      })
      .map((other) => ({
        reportId: other.id,
        similarity: calculateSimilarity(report.description, other.description),
        teamId: other.teamId || null,
        sourceId: other.sourceId || other.deviceId || null,
      }));
  }

  function getReportFlags(report, allReports = getReports()) {
    const duplicates = getDuplicateMatches(report, allReports);

    return {
      isPossibleDuplicate: duplicates.length > 0,
      duplicateMatches: duplicates,
      status:
        duplicates.length > 0
          ? "Possible Correlation"
          : "No Similar Reports Detected",
    };
  }

  function getReviewCounts() {
    const reports = getReports();

    return {
      total: reports.length,
      pending: reports.filter(
        (report) => !report.reviewStatus || report.reviewStatus === "pending",
      ).length,
      verified: reports.filter((report) => report.reviewStatus === "verified")
        .length,
      rejected: reports.filter((report) => report.reviewStatus === "rejected")
        .length,
      unsynced: reports.filter((report) => report.synced !== true).length,
    };
  }

  window.CrisisReports = {
    getReports,
    saveReports,
    addReport,
    getPendingReports,
    getPendingCount,
    markAllSynced,
    clearReports,
    getDuplicateMatches,
    getReportFlags,
    getReviewCounts,
  };
})();
