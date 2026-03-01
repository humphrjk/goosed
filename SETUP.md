# Goose Web — Run the Goose Desktop UI from Any Browser

## What Is This?

[Goose](https://github.com/block/goose) is an AI coding agent from Block. It ships as an Electron desktop app, but this project makes it run in **any browser** — from a laptop, a phone, or an Apple Vision Pro — over a secure HTTPS URL, anywhere in the world.

We do this by:

1. Running the Goose backend (`goose web`) on a Linux server
2. Serving the Electron app's React frontend via a Node.js shim (`serve.js`) that fakes all the Electron APIs
3. Bridging the Electron frontend's REST+SSE protocol to the `goose web` WebSocket protocol
4. Exposing everything through [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) for zero-config HTTPS

The result: the full Goose UI, with all extensions, voice dictation, and chat — running on a headless Linux box but usable from any device with a browser.

## Why?

- **Remote access**: Use Goose from any device without installing anything
- **GPU power**: Run on a server with real compute (DGX Spark, cloud GPU, etc.)
- **Vision Pro / mobile**: Dictate to Goose from a headset or phone
- **Shared access**: Multiple people can use the same Goose instance
- **Always on**: Leave it running 24/7 on a server

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  ANY BROWSER                                                     │
│  (laptop, phone, Vision Pro, tablet)                             │
│  https://<your-machine>.ts.net                                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTPS (auto Let's Encrypt cert)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  TAILSCALE FUNNEL                                                │
│  Routes public HTTPS :443 → http://127.0.0.1:3001                │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  serve.js  (Node.js, port 3001)                                  │
│                                                                   │
│  ┌─ Serves the Goose Electron frontend (HTML/JS/CSS)             │
│  ├─ Injects window.electron shim (mocks 50+ Electron APIs)       │
│  ├─ Strips Content-Security-Policy headers                       │
│  ├─ Mocks /config/* endpoints (providers, extensions, settings)  │
│  ├─ Bridges /reply (REST+SSE) ↔ /ws (WebSocket) for chat        │
│  ├─ Mocks /sessions/* endpoints                                  │
│  ├─ Proxies /dictation/transcribe → whisper_server.py            │
│  └─ Proxies everything else → goosed                             │
└───────────┬──────────────────────────────┬──────────────────────┘
            │                              │
            ▼                              ▼
┌───────────────────────┐    ┌───────────────────────────────────┐
│  goose web  (port 3010)│    │  whisper_server.py  (port 3012)   │
│                        │    │                                    │
│  Goose backend         │    │  Persistent Whisper model          │
│  ├─ WebSocket API      │    │  ├─ Keeps model loaded in memory   │
│  ├─ AI provider:       │    │  ├─ ~0.8s per transcription        │
│  │  claude-code (CLI)  │    │  └─ Base model, 142MB              │
│  ├─ 26 extensions      │    │                                    │
│  └─ Tool execution     │    │  (voice dictation for Vision Pro,  │
│                        │    │   mobile, any device with mic)     │
└────────────────────────┘    └───────────────────────────────────┘
```

## The Problem We Solved

The Goose desktop app is an Electron app. Its frontend (React/Vite) talks to a backend via Electron's IPC preload bridge (`window.electron`). The backend (`goosed`) isn't distributed separately for all platforms, and its API differs between the Electron version and the CLI version.

**Challenge 1: No `window.electron` in a browser**

The React frontend calls `window.electron.getGoosedHostPort()`, `window.electron.getSetting()`, `window.electron.showNotification()`, and ~50 other Electron-specific APIs. In a regular browser, `window.electron` doesn't exist.

**Solution**: `serve.js` injects a `<script>` tag before `</head>` that defines a complete `window.electron` mock — every API the frontend calls gets a sensible default (promises that resolve null, no-ops, or browser-native equivalents like `Notification` and `window.open`).

**Challenge 2: Different backend protocols**

The Electron app's frontend uses REST+SSE (Server-Sent Events) for chat:
- `POST /reply` with `{user_message: Message, session_id: string}` → SSE stream back
- SSE events carry JSON with `{type: "Message" | "Finish" | "Error", ...}`

But `goose web` (the CLI backend) uses WebSocket:
- Connect to `/ws?token=...`
- Send `{type: "message", content: "...", session_id: "..."}`
- Receive `{type: "response" | "complete" | "error", ...}`

**Solution**: `serve.js` bridges between them. When the frontend POSTs to `/reply`, serve.js:
1. Extracts the text from the Message object's content array
2. Sends it over WebSocket to goosed
3. Accumulates WebSocket responses
4. Streams them back as SSE events in the format the frontend expects

**Challenge 3: Schema mismatches**

The frontend expects specific response shapes that goosed doesn't provide:
- `GET /sessions` must return `{sessions: [...]}` not a bare array
- `POST /agent/resume` must return `{session: Session, extension_results: []}` not a bare Session
- `Message` objects must include `metadata: {userVisible: true, agentVisible: true}`
- `GET /config/extensions` must return extensions from `~/.config/goose/config.yaml`

**Solution**: serve.js intercepts all these endpoints and returns correctly shaped responses.

**Challenge 4: Voice dictation on headless server**

The Goose desktop app supports voice input via local Whisper models. The Electron app handles recording, model management, and transcription. On a headless server, none of that exists.

**Solution**: We run a persistent Python Whisper server (`whisper_server.py`) that keeps the model loaded in memory. The browser records audio via `navigator.mediaDevices.getUserMedia()`, sends base64-encoded audio to serve.js, which proxies it to the whisper server. Result: sub-second transcription from any device with a microphone.

## File Layout

```
~/goose-web/                    # On the Linux server
├── goose                       # Goose CLI binary (ARM64 or x86_64)
├── serve.js                    # The main shim — Electron mock + API bridge
├── whisper_server.py           # Persistent Whisper transcription server
├── start.sh                    # Launches all 4 services
├── frontend/                   # Goose Electron frontend assets
│   ├── index.html              #   (extracted from the desktop app)
│   └── assets/
│       ├── index-*.js          # Main bundle
│       ├── App-*.js            # App chunk
│       └── *.css, *.woff2...   # Styles, fonts
├── goosed.log                  # Backend log
├── serve.log                   # Frontend/shim log
└── whisper.log                 # Whisper server log

~/.config/goose/
└── config.yaml                 # Extensions, provider, model config

D:\goose-web\                   # Local dev copies (Windows)
├── serve.js                    # Edit here, scp to server
├── whisper_server.py
├── config.yaml
├── start.sh
├── install.sh                  # Automated deploy script
├── package-frontend.sh         # Package frontend assets into tarball
├── SETUP.md                    # This document
└── CLAUDE.md                   # Claude Code project context
```

## Ports

| Port | Service | Binding | Purpose |
|------|---------|---------|---------|
| 3001 | serve.js | 0.0.0.0 | Frontend + API shim + proxy |
| 3010 | goose web | 0.0.0.0 | Goose backend (WebSocket API) |
| 3012 | whisper_server.py | 127.0.0.1 | Voice transcription |
| 443 | Tailscale Funnel | Tailscale | Public HTTPS ingress |

Ports 3000 and 8000 are avoided (reserved for other apps like IonScout).

## Extensions (26 total)

**Platform** (7): Todo, Extension Manager, Top Of Mind, Code Mode, Apps, Chat Recall, Summon

**Builtin** (5): Developer, Computer Controller, Auto Visualiser, Memory, Tutorial

**MCP/stdio** (13): Filesystem, Council of Mine, Fetch, PDF Reader, YouTube Transcript, Context7, Repomix, Knowledge Graph Memory, Beads, prompts.chat, Goose Docs, Container Use, Playwright

**Streamable HTTP** (1): Excalidraw

All extensions are configured in `~/.config/goose/config.yaml` with absolute paths to `npx` and `uvx`.

## Quick Deploy

For a fresh Ubuntu ARM64 machine (e.g. DGX Spark):

```bash
# 1. Clone the repo
git clone https://dev.azure.com/ionxs/goose-web/_git/goose-web
cd goose-web

# 2. Get the frontend assets (from a machine with the Goose desktop app)
#    On Windows: run package-frontend.sh in Git Bash
#    Then scp the tarball to the server

# 3. Run the install script
./install.sh goose-frontend.tar.gz

# 4. Log into Claude CLI
claude login

# 5. One-time Tailscale setup
sudo tailscale set --operator=$USER

# 6. Start everything
~/goose-web/start.sh
```

See `install.sh` for the full automated setup.

## Manual Start / Stop / Restart

```bash
# Start (kills existing processes first)
~/goose-web/start.sh

# Stop
kill $(netstat -tlnp 2>/dev/null | grep ':3010\|:3001\|:3012' | awk '{print $NF}' | cut -d/ -f1) 2>/dev/null

# Restart
~/goose-web/start.sh

# Check what's running
netstat -tlnp | grep -E '3001|3010|3012'

# View logs
tail -f ~/goose-web/serve.log      # Frontend/shim
tail -f ~/goose-web/goosed.log     # Backend
tail -f ~/goose-web/whisper.log    # Voice transcription
```

## Deploy Changes

After editing files locally:

```bash
# Deploy serve.js
scp serve.js user@<tailscale-ip>:~/goose-web/

# Deploy config
scp config.yaml user@<tailscale-ip>:~/.config/goose/config.yaml

# Deploy whisper server
scp whisper_server.py user@<tailscale-ip>:~/goose-web/

# Restart
ssh user@<tailscale-ip> ~/goose-web/start.sh
```

## Voice Dictation

Voice dictation works from any device with a microphone, including Apple Vision Pro.

**How it works:**
1. Click the microphone button in the chat input
2. Browser requests mic permission (requires HTTPS — Tailscale Funnel provides this)
3. Audio is recorded via `MediaRecorder` API
4. On stop, base64-encoded audio is sent to `POST /dictation/transcribe`
5. serve.js proxies to the persistent Whisper server on port 3012
6. Whisper transcribes the audio (~0.8 seconds)
7. Text appears in the chat input
8. Say "submit" to auto-send, or edit and click send

**Model**: OpenAI Whisper `base` (142MB, English). Installed via `uv tool install openai-whisper`. Model stays loaded in memory via `whisper_server.py` so subsequent transcriptions are fast.

**To upgrade the model** (for better accuracy):
```bash
# Edit start.sh: change --model base to --model small (or medium, large)
# Restart: ~/goose-web/start.sh
# First transcription will download the new model automatically
```

## Tailscale Setup

Tailscale Funnel gives you a public HTTPS URL with a valid Let's Encrypt certificate, no port forwarding or DNS needed.

```bash
# Install Tailscale (if not already)
curl -fsSL https://tailscale.com/install.sh | sh

# Log in
sudo tailscale up

# Allow non-root funnel (one-time)
sudo tailscale set --operator=$USER

# Enable funnel on port 3001 (done automatically by start.sh)
tailscale funnel --bg 3001

# Check your URL
tailscale funnel status
```

Your URL will be `https://<machine-name>.<tailnet>.ts.net`.

## Configuration

### AI Provider

The default provider is `claude-code`, which uses the Claude CLI as a backend. This means Claude handles all AI calls.

To change providers, edit `~/.config/goose/config.yaml`:
```yaml
GOOSE_PROVIDER: claude-code
GOOSE_MODEL: 'opus[1m]'
CLAUDE_CODE_COMMAND: /path/to/claude
```

### Adding Extensions

Add entries under `extensions:` in config.yaml. For MCP servers via npx:
```yaml
  myextension:
    enabled: true
    type: stdio
    name: My Extension
    description: What it does
    display_name: My Extension
    cmd: /full/path/to/npx
    args:
    - -y
    - '@scope/mcp-server-name'
    timeout: 300
    bundled: null
    available_tools: []
```

For Python MCP servers via uvx:
```yaml
  myextension:
    enabled: true
    type: stdio
    name: My Extension
    description: What it does
    cmd: /full/path/to/uvx
    args:
    - mcp-server-name
    timeout: 300
    bundled: null
    available_tools: []
```

**Important**: Use absolute paths for `cmd` (e.g. `/home/user/.nvm/versions/node/v22.22.0/bin/npx`).

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| "Connection not private" | Browser cached a bad cert | Try incognito mode |
| "Bad Gateway" | goosed not running | `~/goose-web/start.sh` |
| "Error loading UI" | Frontend assets missing | Check `ls ~/goose-web/frontend/index.html` |
| Blank page, no errors | CSP header blocking scripts | Check serve.js strips CSP |
| Messages disappear | WebSocket bridge bug | Check `serve.log` for errors |
| Extensions not showing | Config not loaded | Check `serve.log` for "Loaded N extensions" |
| Mic button missing | Dictation not configured | Check `/dictation/config` returns `configured: true` |
| Mic permission denied | Not on HTTPS | Must use Tailscale Funnel URL, not localhost |
| Slow transcription | Whisper server not running | Check port 3012: `netstat -tlnp | grep 3012` |
| "untitled" sessions | Session format wrong | Should be fixed in current serve.js |

### Logs

```bash
# Frontend/shim (most useful for debugging)
tail -f ~/goose-web/serve.log

# Backend
tail -f ~/goose-web/goosed.log

# Whisper
tail -f ~/goose-web/whisper.log
```

## Dependencies

| Package | Version | Install Method | Purpose |
|---------|---------|---------------|---------|
| Node.js | 22.x | nvm | serve.js, npx for MCP servers, Claude CLI |
| Goose CLI | latest | GitHub release | `goose web` backend |
| Claude CLI | latest | npm -g | AI provider (claude-code) |
| uv / uvx | latest | astral.sh | Python MCP extensions |
| openai-whisper | latest | uv tool | Voice transcription |
| ffmpeg | 6.x+ | apt | Audio format conversion (for whisper) |
| Tailscale | latest | tailscale.com | Funnel for HTTPS |

## How We Got Here

The Goose desktop app is Electron-only. We wanted to use it remotely on headless GPU servers. The approach:

1. **Extracted the frontend**: The Goose Electron app builds its React UI into `%TEMP%\goose-app\.vite\renderer\main_window\`. We tar'd these files and copied them to the server.

2. **Reverse-engineered the Electron bridge**: Read the minified frontend JS to find every `window.electron.*` call and the expected API response schemas. Built a complete mock.

3. **Reverse-engineered the API protocol**: The Electron frontend uses REST+SSE for chat, but `goose web` uses WebSocket. Traced the full message flow through the minified code to build the WebSocket-to-SSE bridge.

4. **Fixed schema mismatches**: The frontend expects specific shapes for sessions, messages, and agent responses. Each one had to be matched exactly (e.g., `Message.metadata.userVisible`, `SessionListResponse.sessions`, `ResumeAgentResponse.extension_results`).

5. **Added voice dictation**: The desktop app uses local Whisper for voice input. We installed Whisper on the server and created a persistent HTTP server that keeps the model in memory for fast transcription.

6. **Exposed via Tailscale Funnel**: Zero-config HTTPS with valid certs, accessible from anywhere.
