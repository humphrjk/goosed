# Goose Web — Remote Desktop UI via Tailscale

## What This Is
Serves the full Goose desktop UI (Electron app) as a web app accessible from any browser via Tailscale Funnel. A Node.js shim (`serve.js`) mocks all `window.electron` APIs so the React frontend runs natively in a browser. Includes voice dictation via a persistent Whisper server.

## Current Deployment: aitop2 (DGX Spark #2)
- **URL**: `https://aitop2.tailfb8701.ts.net`
- **SSH**: `humphrjk@100.104.229.35` (Tailscale IP)
- **Ports**: 3010 (goosed), 3001 (serve.js), 3012 (whisper server)
- **Config**: `~/.config/goose/config.yaml` on aitop2

## Architecture
```
Browser → Tailscale Funnel (HTTPS :443)
       → serve.js (:3001) — serves frontend, injects electron shim
         → goosed (:3010) — Goose backend (WebSocket API)
         → whisper_server.py (:3012) — voice transcription
```

## Key Files
| File | Purpose |
|------|---------|
| `serve.js` | Main Node.js server — serves frontend, mocks Electron APIs, bridges REST+SSE ↔ WebSocket, proxies dictation |
| `whisper_server.py` | Persistent Whisper HTTP server (keeps model in GPU memory) |
| `start.sh` | Startup script for aitop2 (launches all 4 services) |
| `config.yaml` | Goose config with 26 extensions (deploy to `~/.config/goose/config.yaml`) |
| `install.sh` | Fresh machine setup script (deps only, no credentials) |
| `package-frontend.sh` | Packages Electron app's Vite output into tarball |
| `SETUP.md` | Full architecture docs and troubleshooting |
| `frontend/` | Goose Electron frontend assets (gitignored, from tarball) |

## Mocked Endpoints in serve.js
- `/config/*` — config CRUD, providers, extensions, permissions
- `/agent/*` — start/resume/reply (bridges Electron REST+SSE ↔ goose web WebSocket)
- `/sessions/*` — session CRUD (SessionListResponse format)
- `/dictation/*` — voice dictation config, models, transcription
- `/reply` — SSE chat stream

## Key Schema Details (from Electron frontend reverse-engineering)
- **ChatRequest**: `{user_message: Message, session_id}` — Message is an object with `{role, content: [{type:"text", text}], metadata: {userVisible, agentVisible}}`
- **SessionListResponse**: `{sessions: Session[]}` — must be wrapped
- **ResumeAgentResponse**: `{session: Session, extension_results: []}`
- **SSE events**: type discriminator is INSIDE the JSON data, not the SSE `event:` field

## Voice Dictation
- Whisper `base` model via `openai-whisper` (installed with `uv tool`)
- Python venv at `~/.local/share/uv/tools/openai-whisper/bin/python3`
- Model stays loaded in memory via `whisper_server.py` for fast (~0.8s) transcriptions
- Frontend config key: `voice_dictation_provider: local`

## Deploy Workflow
1. Edit files locally in `D:\goose-web\`
2. `scp serve.js humphrjk@100.104.229.35:~/goose-web/`
3. `ssh humphrjk@100.104.229.35 ~/goose-web/start.sh`

## Important Constraints
- `goose web` CLI is used (not goosed.exe) — only CLI available for Linux ARM64
- Ports 3000/8000 reserved for IonScout on DGX Sparks
- Frontend assets come from Goose Electron app's Vite cache (`%TEMP%\goose-app\.vite\renderer\main_window\`)
- `sudo tailscale set --operator=$USER` required once for funnel without sudo
