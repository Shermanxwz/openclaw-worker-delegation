# Direct public-IP deployment

This profile exposes the mobile Web panel through the VPS public IP without Cloudflare or Tailscale. Only Nginx listens publicly; the Node controller and agent API remain loopback-only.

## 1. Prepare the service

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin openclaw 2>/dev/null || true
sudo install -d -o openclaw -g openclaw -m 0700 /var/lib/openclaw-delegation
sudo install -d -o root -g openclaw -m 0750 /opt/openclaw-worker-delegation
sudo install -o root -g openclaw -m 0644 deploy/openclaw-delegation.service /etc/systemd/system/openclaw-delegation.service
sudo install -o root -g openclaw -m 0640 .env /etc/openclaw-delegation.env
```

Place the repository at `/opt/openclaw-worker-delegation`, then set `DATA_DIR=/var/lib/openclaw-delegation` and `PUBLIC_ORIGIN=https://<PUBLIC_IP>` in `/etc/openclaw-delegation.env`.

Generate credentials from `control-plane/`:

```bash
CONTROL_PASSWORD_INPUT='a unique long passphrase' npm run hash-password
npm run generate-token
npm run generate-totp-secret   # recommended
```

Use the generated agent token both as `AGENT_INGEST_TOKEN` for the controller and `OCWD_AGENT_TOKEN` in the OpenClaw Gateway service environment. Never expose it to the browser.

## 2. Install the native plugin

```bash
openclaw plugins install --link /opt/openclaw-worker-delegation/control-plane/openclaw-plugin
openclaw plugins enable delegation-guard
```

Merge `deploy/openclaw.example.json5` into the real OpenClaw configuration, restart the Gateway, and verify live registration:

```bash
openclaw gateway restart
openclaw plugins inspect delegation-guard --runtime --json
```

The runtime inspection must show the `before_prompt_build` and `before_tool_call` hooks. The panel remains `ADVISORY` until a real agent turn and a real tool call pass through those hooks.

## 3. Configure HTTPS

Install a trusted certificate whose SAN contains the public IP, or use a hostname. Put the certificate and key at the paths referenced by `deploy/nginx-public-ip.conf`, replace `<PUBLIC_IP>`, and then:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

A self-signed certificate is suitable only for a controlled test because phones will not trust it by default.

## 4. Start and verify

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-delegation
sudo systemctl status openclaw-delegation --no-pager
curl --fail http://127.0.0.1:8787/health/ready
```

Open only TCP 80/443 and the chosen SSH port. Do not expose 8787 or any OpenClaw internal API port.

## 5. Acceptance checks

1. Log in from the phone and confirm the model heartbeat appears.
2. Run one harmless read task so a real route and tool check occur.
3. Confirm the panel changes from `ADVISORY` to `HARD`.
4. Switch to Worker mode and verify main `read`, `web_search`, `exec`, `write`, `edit`, and `apply_patch` calls are blocked while `sessions_spawn` remains allowed.
5. Switch to Main for 15 minutes and verify workers are frozen immediately.
6. Arm “下一次任务” for a real session, confirm exactly one route uses it, and confirm the following route falls back.
7. Wait for Main expiry and confirm the effective mode returns to the configured default.
