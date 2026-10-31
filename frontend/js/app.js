// CrisisMesh AI - Landing Page

document.addEventListener("DOMContentLoaded", async () => {
  const statusElement = document.getElementById("networkStatus");

  if (!statusElement) return;

  statusElement.textContent = "Checking backend...";

  try {
    const health = await window.CrisisAPI.health();

    statusElement.textContent = health.online
      ? `Backend connected · ${health.node}`
      : `Backend connected · ${health.node} (offline mode)`;
    statusElement.classList.add("online");
    statusElement.classList.remove("offline");
  } catch (error) {
    statusElement.textContent = "Backend unreachable · demo data";
    statusElement.classList.add("offline");
    statusElement.classList.remove("online");
  }
});

console.log("CrisisMesh landing page loaded");
