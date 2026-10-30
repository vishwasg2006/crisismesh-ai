# CrisisMesh

CrisisMesh is a robust, resilient, and decentralized emergency coordination and response platform. It is designed to bridge communication gaps during critical crises, disasters, or resource-constraint scenarios by providing real-time data synchronization, multi-agent operational planning, offline-first support, and structured responder/coordinator workflows.

---

## 🏗️ Project Architecture

The project is structured as a monorepo containing a modular **Backend** API service and a progressive **Frontend** client application.

```text
crisismesh/
├── frontend/             # Progressive Web Application (HTML/CSS/JS)
│   ├── index.html        # Main entry point / dashboard view
│   ├── coordinator.html  # Emergency coordination interface
│   ├── responder.html    # Field responder operations interface
│   ├── css/              # Stylesheets and layout configurations
│   └── js/               # Application logic, offline sync, map handling, and API clients
└── backend/              # Node.js / TypeScript REST & Real-time API
    ├── src/
    │   ├── agents/       # Specialized decision-making and analysis agents
    │   ├── services/     # Core business logic (claims, pipeline, ops)
    │   ├── db/           # Database layer (MySQL, JSON store, seed data)
    │   ├── routes.ts     # API route controllers
    │   └── index.ts      # Application entry point
    ├── schema.sql        # Database schema definitions
    └── package.json      # Backend dependencies and scripts
