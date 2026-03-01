# Goose Web — Remote Desktop UI via Tailscale

## Overview

This setup runs the full Goose desktop UI (normally an Electron app) as a web application accessible from any browser, anywhere in the world, via a Tailscale Funnel HTTPS URL.

The Goose Electron app's frontend (React/Vite) is served by a Node.js shim (`serve.js`) that mocks all Electron preload APIs (`window.electron`), allowing the desktop UI to run natively in a browser. API calls and WebSocket connections are proxied to the `goosed` backend running on the same machine.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  ANY BROWSER (office, home, Vision Pro, phone)              │
│  https://aitop2.tailfb8701.ts.net                           │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTPS (Let's Encrypt cert)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  TAILSCALE FUNNEL (on aitop2)                               │
│  Routes public HTTPS → http://127.0.0.1:3001                │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  serve.js (Node.js, port 3001)                              │
│  ├─ Serves Goose Electron frontend (HTML/JS/CSS)            │
│  ├─ Injects window.electron shim (mocks Electron APIs)      │
│  ├─ Strips Content-Security-Policy headers                  │
│  ├─ Proxies /api/* requests → goosed (port 3010)            │
│  └─ Proxies WebSocket upgrades → goosed (port 3010)         │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  goosed (Goose backend, port 3010)                          │
│  ├─ Launched via: ./goose web --host 0.0.0.0 --port 3010    │
│  ├─ Provider: claude-code (Claude CLI)                      │
│  ├─ Model: opus                                             │
│  ├─ Extensions: developer, filesystem, memory, etc.         │
│  └─ Working directory: ~/goose-web                          │
└─────────────────────────────────────────────────────────────┘
```

## Components

### goosed (Goose Backend Server)
- **Binary**: `~/goose-web/goose` (Linux ARM64, downloaded from GitHub releases)
- **Port**: 3010
- **Role**: Handles all AI chat, extension calls, tool execution
- **Config**: `~/.config/goose/config.yaml`
- **Provider**: claude-code (requires Claude CLI installed)

### serve.js (Electron UI Shim)
- **Port**: 3001
- **Role**: Serves the Goose Electron app's frontend in a regular browser
- **Key trick**: Injects a `window.electron` object that mocks all Electron IPC APIs (file dialogs, notifications, settings, etc.) so the React app thinks it's running in Electron
- **Proxies**: All non-static requests forwarded to goosed on port 3010
- **Frontend assets**: `~/goose-web/frontend/` (copied from the Windows Electron app's Vite output)

### Tailscale Funnel
- **URL**: `https://aitop2.tailfb8701.ts.net`
- **Certificate**: Auto-provisioned Let's Encrypt via Tailscale
- **Routes**: HTTPS → http://127.0.0.1:3001

## File Locations (on aitop2)

```
~/goose-web/
├── goose                  # Goose CLI binary (ARM64 Linux)
├── serve.js               # Electron UI shim + proxy
├── start.sh               # Startup script (all 3 components)
├── start-serve.sh         # Node.js wrapper for serve.js
├── frontend/              # Goose Electron frontend assets
│   ├── index.html
│   └── assets/            # JS, CSS, fonts, images
├── goosed.log             # Backend log
└── serve.log              # Frontend log

~/.config/goose/
└── config.yaml            # Extensions, provider, model settings
```

## Port Assignments

| Port | Service | Binding |
|------|---------|---------|
| 3001 | serve.js (frontend + proxy) | 0.0.0.0 |
| 3010 | goosed (backend API) | 0.0.0.0 |
| 443  | Tailscale Funnel (HTTPS) | Tailscale |

Note: Ports 3000 and 8000 are reserved for IonScout (frontend/backend).

## Starting & Stopping

### Start (from Windows desktop)
Double-click **"Start Goose Web"** on the desktop, or:
```bash
ssh humphrjk@100.104.229.35 ~/goose-web/start.sh
```

### Stop (from Windows desktop)
Double-click **"Stop Goose Web"** on the desktop, or:
```bash
ssh humphrjk@100.104.229.35 "kill $(netstat -tlnp 2>/dev/null | grep ':3010 ' | sed 's|.*LISTEN *||' | cut -d/ -f1) 2>/dev/null; kill $(netstat -tlnp 2>/dev/null | grep ':3001 ' | sed 's|.*LISTEN *||' | cut -d/ -f1) 2>/dev/null"
```

### Restart
```bash
ssh humphrjk@100.104.229.35 ~/goose-web/start.sh
```
The start script kills existing processes before starting new ones.

## Tailscale Setup

The machine must be on a Tailscale tailnet with Funnel enabled:
```bash
# One-time: allow non-root tailscale commands
sudo tailscale set --operator=$USER

# Enable funnel (done by start.sh)
tailscale funnel --bg 3001
```

## Configuration

### Goose Config (`~/.config/goose/config.yaml`)

Key settings:
- `GOOSE_PROVIDER: claude-code` — uses Claude CLI as the AI provider
- `GOOSE_MODEL: opus[1m]` — Claude Opus model
- `CLAUDE_CODE_COMMAND` — full path to claude binary
- Extensions: developer, computercontroller, autovisualiser, memory, filesystem, etc.

### Changing the Model
Edit `~/.config/goose/config.yaml` and change `GOOSE_MODEL`, then restart.

### Adding Extensions
Edit `~/.config/goose/config.yaml` and add entries under `extensions:`, or use the Extension Manager within the Goose UI.

## Troubleshooting

### "Connection not private" in browser
- Try incognito mode (clears cached bad certs)
- The Let's Encrypt cert is valid; this is usually a browser cache issue

### "Bad Gateway - goosed not reachable"
- goosed crashed or isn't running
- Check: `ssh humphrjk@100.104.229.35 "netstat -tlnp | grep 3010"`
- Restart: `ssh humphrjk@100.104.229.35 ~/goose-web/start.sh`

### "Error loading UI"
- Frontend assets missing or STATIC_DIR wrong in serve.js
- Check: `ls ~/goose-web/frontend/index.html`

### Extensions not loading
- Check `~/goose-web/goosed.log` for extension errors
- Ensure paths in config.yaml are absolute Linux paths
- Ensure claude, npx, uvx are installed and in the right paths

### Port already in use
- Another process is on the port
- Check: `netstat -tlnp | grep <port>`
- Kill: `kill <PID>`

## Dependencies

| Dependency | Version | Purpose |
|-----------|---------|---------|
| Node.js | 22.x | serve.js, npx for MCP servers, Claude CLI |
| Goose CLI | 1.26.1 | goosed backend |
| Claude CLI | latest | AI provider (claude-code) |
| uv/uvx | latest | Python MCP extensions (Council of Mine) |
| Tailscale | latest | Funnel for public HTTPS access |
