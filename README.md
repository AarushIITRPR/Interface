# Multimodal Session Console

A full-stack refactor of the IIT Ropar multimodal protocol console. The interface remains framework-free so the existing experiment behavior stays easy to audit, while an Express server now serves the frontend and persists configuration and exported sessions.

## Project structure

```text
multimodal-session-console/
├── frontend/
│   ├── index.html
│   ├── styles/main.css
│   ├── scripts/
│   │   ├── api.js
│   │   └── app.js
│   └── media/
├── backend/
│   ├── config/defaultMedia.js
│   ├── routes/
│   │   ├── mediaConfig.js
│   │   └── sessions.js
│   ├── services/jsonStore.js
│   ├── data/sessions/
│   └── server.js
├── .env.example
├── .gitignore
└── package.json
```

## Run locally

Requirements: Node.js 20 or newer.

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:3000`.

For a production-style run:

```bash
npm start
```

## API

- `GET /api/health` — server health check
- `GET /api/media-config` — current media configuration
- `PUT /api/media-config` — update media configuration
- `POST /api/sessions` — persist an exported session JSON payload

Session JSON files are written to `backend/data/sessions/`. The interface still downloads CSV and JSON files in the browser, so operators retain the original manual export workflow.

## Notes

- The Media & Admin UI was intentionally removed from the setup screen during the decluttering pass. Media paths can now be managed through the backend endpoint or by placing clips under `frontend/media/` using the default names.
- Runtime media configuration and recorded sessions are excluded from Git by default.
