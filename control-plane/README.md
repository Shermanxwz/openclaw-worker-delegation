# OpenClaw Delegation Control Plane

A small, dependency-free Node.js sidecar that adds three runtime modes, a public-web-ready mobile panel, routing explanations, model visibility, event monitoring and a policy API.

## Modes

- `worker`: main plans/reviews; tool work routes to a worker. Pure text Q&A stays in main unless `workerAll` is requested.
- `auto`: score task properties and fail closed to worker for mutation, execution, scans and retry loops.
- `main`: main receives execution tools and automatic worker spawning is disabled. Web switches require password re-authentication and expire by default.

Mode precedence is `task > session > project > global`.

## Run locally

```bash
cd control-plane
CONTROL_PASSWORD_INPUT='a-long-password' npm run hash-password
cp .env.example .env
# Put the generated hash and a random AGENT_INGEST_TOKEN in your environment.
set -a; . ./.env; set +a
npm test
npm start
```

The service binds to `127.0.0.1:8787`. Put Caddy or Nginx in front and expose only ports 80/443.

## Runtime model reporting

The controller does not guess the active model from configuration. The OpenClaw runtime should call `POST /api/runtime-status`:

- on main-session startup;
- whenever the main model changes or falls back;
- whenever a worker starts, stops or changes model;
- periodically while the runtime is active.

Example payload:

```json
{
  "main": {
    "model": "provider/active-strong-model",
    "configuredModel": "provider/configured-strong-model",
    "provider": "provider-name",
    "status": "running",
    "sessionId": "session-123"
  },
  "workers": [
    {
      "id": "worker-42",
      "model": "provider/worker-model",
      "role": "body-worker",
      "status": "running"
    }
  ],
  "enforcement": {
    "routeWired": true,
    "toolCheckWired": true
  },
  "sessionId": "session-123",
  "projectId": "project-abc"
}
```

Until this heartbeat is wired, the panel intentionally shows `未上报` rather than presenting a configured model as the current active model.

## Runtime enforcement contract

The panel is not itself an OpenClaw tool sandbox. The runtime adapter must:

1. Call `POST /api/route` before selecting main vs worker.
2. Call `POST /api/tool-check` before every tool invocation.
3. Refuse the invocation when `allowed` is false.
4. Publish attempted/allowed/blocked and worker lifecycle events to `POST /api/events`.
5. Publish the active main/worker models and enforcement wiring to `POST /api/runtime-status`.

See `integration/openclaw-sidecar-hook.mjs`. If the runtime only reads the policy but does not enforce it, the protection is advisory rather than hard.

The Web panel makes this distinction visible:

- `HARD`: the runtime reports both routing and pre-tool-check wiring as active.
- `ADVISORY`: either integration is missing or has not been reported.

### Integration completion checklist

- [x] Control-plane mode store, router, policy and `/api/tool-check` endpoint.
- [x] Runtime-neutral sidecar client.
- [x] Web display for active models and enforcement state.
- [ ] Wire the sidecar client into the actual OpenClaw agent loop.
- [ ] Ensure every tool execution is blocked when `toolCheck().allowed === false`.
- [ ] Emit runtime/model heartbeats from the actual OpenClaw process.

The unchecked items are deployment/runtime integration work; cloning and starting this repository alone does not complete them.

## API summary

Browser session endpoints:

- `POST /api/login`
- `GET /api/status`
- `PUT /api/mode`
- `POST /api/route`
- `GET /api/events`
- `GET /api/stream`

Agent bearer-token endpoints:

- `POST /api/route`
- `POST /api/policy`
- `POST /api/tool-check`
- `POST /api/runtime-status`
- `POST /api/events`

## VPS deployment

1. Create a dedicated `openclaw` system user.
2. Place the repository under `/opt/openclaw-worker-delegation`.
3. Store secrets in `/etc/openclaw-delegation.env` with mode `0600`.
4. Store state in `/var/lib/openclaw-delegation` and set `DATA_DIR` accordingly.
5. Install the systemd unit from `deploy/openclaw-delegation.service`.
6. Configure Caddy or Nginx with the files under `deploy/`.
7. Open only HTTPS/HTTP and the chosen SSH port; do not expose port 8787.

The UI is responsive and intended for direct phone use.
