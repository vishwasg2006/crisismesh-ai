const CrisisMap = {
  map: null,
  markerLayer: null,
  markers: {},

  CARTO_API_KEY: "cb1_4yj6_1_b1fda1a001071bb62994bc02",

  overlayLayer: null,
  extras: {},

  initialize(incidents = [], extras = {}) {
    const mapElement = document.getElementById("emergencyMap");

    if (!mapElement || typeof L === "undefined") {
      console.error("Map container or Leaflet not found.");
      return;
    }

    this.extras = extras;

    // Already created: only refresh the layers so pan/zoom survive live updates.
    if (this.map) {
      this.renderOverlay(extras);
      this.renderMarkers(incidents, false);
      return;
    }

    this.markers = {};

    this.map = L.map("emergencyMap", {
      center: [12.9716, 77.5946],
      zoom: 11,
    });

    const tileUrl = `https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=${this.CARTO_API_KEY}`;

    L.tileLayer(tileUrl, {
      maxZoom: 20,
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    }).addTo(this.map);

    this.overlayLayer = L.layerGroup().addTo(this.map);
    this.markerLayer = L.layerGroup().addTo(this.map);

    this.renderOverlay(extras);
    this.renderMarkers(incidents, true);

    setTimeout(() => {
      if (this.map) this.map.invalidateSize();
    }, 500);

    console.log("CrisisMesh map initialized.");
  },

  getCoordinates(incident) {
    if (!incident) return null;

    let lat;
    let lng;

    if (incident.latitude !== undefined) {
      lat = incident.latitude;
      lng = incident.longitude;
    } else if (incident.lat !== undefined) {
      lat = incident.lat;
      lng = incident.lng ?? incident.lon;
    } else if (Array.isArray(incident.coordinates)) {
      lat = incident.coordinates[0];
      lng = incident.coordinates[1];
    } else if (incident.coordinates) {
      lat = incident.coordinates.lat;
      lng = incident.coordinates.lng ?? incident.coordinates.lon;
    }

    lat = Number(lat);
    lng = Number(lng);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      return null;
    }

    return [lat, lng];
  },

  getMarkerColor(severity) {
    const level = String(severity || "").toLowerCase();

    if (level === "critical") return "#d83b43";
    if (level === "high") return "#e58b24";
    if (level === "medium") return "#2864d7";

    return "#168451";
  },

  // Settlements, road/water routes and the plan's assignment paths.
  renderOverlay({ settlements = [], routes = [], assignments = [] } = {}) {
    if (!this.map || !this.overlayLayer) return;

    this.overlayLayer.clearLayers();

    const byId = {};
    settlements.forEach((s) => (byId[s.id] = [s.lat, s.lng]));

    const routeColor = { open: "#9aa5b1", blocked: "#d83b43", flooded: "#e58b24" };

    routes.forEach((route) => {
      const a = byId[route.a];
      const b = byId[route.b];
      if (!a || !b) return;

      L.polyline([a, b], {
        color: routeColor[route.status] || "#9aa5b1",
        weight: route.status === "open" ? 1.5 : 3,
        opacity: route.status === "open" ? 0.45 : 0.85,
        dashArray: route.mode === "water" ? "2 6" : route.status === "open" ? null : "6 6",
      })
        .bindTooltip(
          `${route.mode} route ${route.a}-${route.b}: ${route.status}${route.note ? " (" + route.note + ")" : ""}`,
        )
        .addTo(this.overlayLayer);
    });

    assignments.forEach((assignment) => {
      const path = (assignment.route || []).map((id) => byId[id]).filter(Boolean);
      if (path.length < 2) return;

      L.polyline(path, {
        color: assignment.mode === "water" ? "#2864d7" : "#168451",
        weight: 5,
        opacity: assignment.atRisk ? 0.6 : 0.9,
      })
        .bindTooltip(
          `${this.escapeHTML(assignment.resourceName)} -> ${this.escapeHTML(assignment.settlementName)} (ETA ${assignment.etaMin} min)`,
        )
        .addTo(this.overlayLayer);
    });

    settlements.forEach((s) => {
      L.circleMarker([s.lat, s.lng], {
        radius: s.type === "base" ? 7 : 4,
        color: "#ffffff",
        weight: 1,
        fillColor: s.type === "base" ? "#111827" : "#64748b",
        fillOpacity: 0.9,
      })
        .bindTooltip(
          `${this.escapeHTML(s.name)}${s.type === "base" ? "" : ` - water ${s.waterLevelM} m`}`,
        )
        .addTo(this.overlayLayer);
    });
  },

  renderMarkers(incidents = [], fit = true) {
    if (!this.map || !this.markerLayer) return;

    this.markerLayer.clearLayers();
    this.markers = {};

    const validLocations = [];

    incidents.forEach((incident) => {
      const coordinates = this.getCoordinates(incident);

      if (!coordinates) {
        console.warn("Invalid incident coordinates:", incident);
        return;
      }

      const severity = incident.severity || "Medium";
      const color = this.getMarkerColor(severity);

      const marker = L.circleMarker(coordinates, {
        radius: 9,
        color: "#ffffff",
        weight: 2,
        fillColor: color,
        fillOpacity: 1,
      });

      const incidentId = incident.id || incident.incidentId || "Unknown";

      const title = incident.title || incident.name || "Emergency Incident";

      const location = incident.location || incident.address || "Unknown";

      marker.bindPopup(`
                <div style="min-width:180px">
                    <strong>${this.escapeHTML(title)}</strong>
                    <hr>
                    <div><b>ID:</b> ${this.escapeHTML(incidentId)}</div>
                    <div><b>Location:</b> ${this.escapeHTML(location)}</div>
                    <div><b>Severity:</b> ${this.escapeHTML(severity)}</div>
                </div>
            `);

      marker.addTo(this.markerLayer);

      this.markers[String(incidentId)] = marker;
      validLocations.push(coordinates);
    });

    if (fit && validLocations.length > 0) {
      this.map.fitBounds(validLocations, {
        padding: [35, 35],
        maxZoom: 14,
      });
    }
  },

  escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => {
      const entities = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      };

      return entities[char];
    });
  },

  focusIncident(incidentId) {
    if (!this.map) return;

    const marker = this.markers[String(incidentId)];

    if (!marker) {
      console.warn("Incident marker not found:", incidentId);
      return;
    }

    this.map.setView(marker.getLatLng(), 15);
    marker.openPopup();
  },

  init(incidents = [], extras = {}) {
    this.initialize(incidents, extras);
  },

  destroy() {
    if (this.map) {
      this.map.remove();
      this.map = null;
      this.markerLayer = null;
      this.overlayLayer = null;
      this.markers = {};
    }
  },
};

window.CrisisMap = CrisisMap;
