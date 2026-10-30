// CrisisMesh AI - Common Utilities

window.CrisisUtils = {
  // Safely find an HTML element
  element(id) {
    return document.getElementById(id);
  },

  // Prevent HTML injection when displaying user-entered text
  escapeHTML(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#039;",
        })[character],
    );
  },

  // Read JSON from localStorage
  getStorage(key, fallback = null) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  },

  // Save JSON to localStorage
  setStorage(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },

  // Display a readable date and time
  formatTime(value) {
    return new Date(value).toLocaleString();
  },

  // Generate a unique ID
  createId(prefix = "ID") {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  },
};

console.log("CrisisMesh utilities loaded");
