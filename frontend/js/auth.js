// CrisisMesh AI - login session + role guard
// Load AFTER api.js. Pages declare what they need with <body data-require-role="coordinator">
// (or "any" = any logged-in user). Elements with data-role-only="coordinator" are removed for other roles.

(function () {
  const A = window.CrisisAPI;
  const here = location.pathname.split("/").pop() || "index.html";

  const HOME = { coordinator: "coordinator.html", responder: "responder.html" };

  function go(url) {
    location.replace(url);
  }

  const Auth = {
    blocked: false,

    get user() {
      return A.getUser();
    },
    get role() {
      return A.getUser()?.role || null;
    },
    homeFor(role) {
      return HOME[role] || "index.html";
    },

    logout() {
      A.clearSession();
      go("login.html");
    },

    // called by api.js when the server says the token is missing / expired
    expired() {
      A.clearSession();
      if (here !== "login.html") go(`login.html?next=${encodeURIComponent(here)}&expired=1`);
    },
  };

  window.CrisisAuth = Auth;

  const need = document.body?.dataset.requireRole;
  const user = A.getUser();

  if (need) {
    if (!user || !A.getToken()) {
      Auth.blocked = true;
      go(`login.html?next=${encodeURIComponent(here)}`);
    } else if (need === "coordinator" && user.role !== "coordinator") {
      Auth.blocked = true;
      go(Auth.homeFor(user.role));
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    // hide things this role may not use
    document.querySelectorAll("[data-role-only]").forEach((el) => {
      if (user && el.dataset.roleOnly !== user.role) el.remove();
    });

    // user chip + logout in the header
    const bar = document.querySelector(".header-actions");
    if (!bar || Auth.blocked) return;

    const chip = document.createElement("span");
    chip.className = "user-chip";
    if (user) {
      chip.innerHTML = `<b></b><small></small>`;
      chip.querySelector("b").textContent = user.name || user.username;
      chip.querySelector("small").textContent = user.role;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secondary-button logout-button";
    btn.textContent = user ? "Log out" : "Log in";
    btn.addEventListener("click", () => (user ? Auth.logout() : go("login.html")));

    bar.append(...(user ? [chip, btn] : [btn]));
  });
})();
