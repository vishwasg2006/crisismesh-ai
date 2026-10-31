// CrisisMesh AI - login / register page

document.addEventListener("DOMContentLoaded", () => {
  const $ = (id) => document.getElementById(id);
  const API = window.CrisisAPI;
  const params = new URLSearchParams(location.search);

  const message = (text, ok = false) => {
    const box = $("loginMessage");
    box.textContent = text;
    box.classList.toggle("ok", ok);
  };

  // where to go after signing in (only pages the role is allowed to see)
  function destination(user) {
    const next = params.get("next");
    const safe = next && /^[a-z-]+\.html$/.test(next) && next !== "login.html";
    const coordinatorOnly = ["coordinator.html", "split-brain.html"];
    if (safe && (user.role === "coordinator" || !coordinatorOnly.includes(next))) return next;
    return window.CrisisAuth.homeFor(user.role);
  }

  // already signed in with a valid-looking session -> skip the form
  const existing = API.getUser();
  if (existing && API.getToken() && !params.get("expired")) {
    location.replace(destination(existing));
    return;
  }
  if (params.get("expired")) message("Your session expired - please sign in again.");

  // tabs
  document.querySelectorAll(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      $("loginForm").hidden = tab.dataset.tab !== "login";
      $("registerForm").hidden = tab.dataset.tab !== "register";
      message("");
    }),
  );

  // register form: team list (public endpoint) + role-specific fields
  API.getTeams()
    .then((teams) => {
      $("regTeam").innerHTML = teams
        .map((t) => `<option value="${window.CrisisUtils.escapeHTML(t.id)}">${window.CrisisUtils.escapeHTML(t.name)}</option>`)
        .join("");
    })
    .catch(() => {
      $("regTeam").innerHTML = `<option value="">Backend unreachable</option>`;
    });

  $("regRole").addEventListener("change", () => {
    const coordinator = $("regRole").value === "coordinator";
    $("teamGroup").hidden = coordinator;
    $("codeGroup").hidden = !coordinator;
  });

  async function submit(event, action) {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    message("Please wait...", true);
    try {
      const user = await action();
      message(`Welcome, ${user.name}`, true);
      location.replace(destination(user));
    } catch (error) {
      message(error.status ? error.message : "Backend unreachable - is the server running?");
      button.disabled = false;
    }
  }

  $("loginForm").addEventListener("submit", (event) =>
    submit(event, () => API.login($("loginUser").value.trim(), $("loginPass").value)),
  );

  $("registerForm").addEventListener("submit", (event) =>
    submit(event, () => {
      const role = $("regRole").value;
      return API.register({
        role,
        name: $("regName").value.trim(),
        username: $("regUser").value.trim(),
        password: $("regPass").value,
        ...(role === "responder" ? { teamId: $("regTeam").value } : { code: $("regCode").value.trim() }),
      });
    }),
  );
});
