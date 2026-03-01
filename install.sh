#!/bin/bash
set -euo pipefail

# ============================================================
# Goose Web — Deploy Script
#
# Deploys the full Goose desktop UI as a web app on a Linux
# machine with Tailscale Funnel, voice dictation, and 26
# extensions.
#
# Supports: Ubuntu 22.04+ on ARM64 (DGX Spark) and x86_64
#
# Usage:
#   ./install.sh <frontend-tarball>
#   ./install.sh goose-frontend.tar.gz
#
# The frontend tarball contains the Goose Electron app's
# React/Vite build output. Create it on a machine where the
# Goose desktop app has been run at least once:
#   ./package-frontend.sh
#
# What this script installs:
#   - nvm + Node.js 22
#   - uv / uvx (Python package manager)
#   - Goose CLI (latest release)
#   - Claude CLI (via npm)
#   - OpenAI Whisper (via uv tool, for voice dictation)
#   - ffmpeg (via apt, for audio processing)
#   - serve.js, whisper_server.py, start.sh
#   - config.yaml template with 26 extensions
#
# What this script does NOT install:
#   - Tailscale (must be installed and logged in already)
#   - API keys, SSH keys, or credentials
#   - Claude CLI login (run 'claude login' after install)
# ============================================================

GOOSE_VERSION="latest"
NODE_VERSION="22"
INSTALL_DIR="$HOME/goose-web"
CONFIG_DIR="$HOME/.config/goose"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_TARBALL="${1:-}"

# ── Colors ────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }
step()  { echo -e "\n${GREEN}━━━ $* ━━━${NC}"; }

# ── Pre-flight checks ────────────────────────────
echo ""
echo "╔════════════════════════════════════════════╗"
echo "║       Goose Web — Deployment Script        ║"
echo "╚════════════════════════════════════════════╝"
echo ""

ARCH=$(uname -m)
if [ "$ARCH" != "aarch64" ] && [ "$ARCH" != "x86_64" ]; then
    err "Unsupported architecture: $ARCH (need aarch64 or x86_64)"
    exit 1
fi
info "Architecture: $ARCH"
info "Install dir:  $INSTALL_DIR"

if [ -z "$FRONTEND_TARBALL" ]; then
    warn "No frontend tarball specified."
    warn "Usage: $0 <path-to-goose-frontend.tar.gz>"
    warn "Create it with: ./package-frontend.sh"
    warn "Continuing without frontend (you can add it later)."
    echo ""
elif [ ! -f "$FRONTEND_TARBALL" ]; then
    err "Frontend tarball not found: $FRONTEND_TARBALL"
    exit 1
fi

# Check for Tailscale
if ! command -v tailscale &>/dev/null; then
    warn "Tailscale not found. Install it: https://tailscale.com/download/linux"
    warn "Continuing without Tailscale (no HTTPS URL will be set up)."
fi

# ── Create directories ────────────────────────────
step "1/9 — Creating directories"
mkdir -p "$INSTALL_DIR"
mkdir -p "$CONFIG_DIR"
ok "Directories created"

# ── Install nvm + Node.js ─────────────────────────
step "2/9 — Node.js $NODE_VERSION (via nvm)"
if [ ! -d "$HOME/.nvm" ]; then
    info "Installing nvm..."
    curl -so- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
if ! node --version &>/dev/null || [[ "$(node --version)" != v${NODE_VERSION}* ]]; then
    info "Installing Node.js $NODE_VERSION..."
    nvm install "$NODE_VERSION"
fi
nvm use "$NODE_VERSION" >/dev/null
NODE_BIN_DIR="$(dirname "$(which node)")"
NPX_PATH="$NODE_BIN_DIR/npx"
ok "Node.js $(node --version) at $NODE_BIN_DIR"

# ── Install uv/uvx ───────────────────────────────
step "3/9 — uv / uvx (Python package manager)"
if ! command -v uv &>/dev/null && [ ! -f "$HOME/.local/bin/uv" ]; then
    info "Installing uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
fi
UVX_PATH="$HOME/.local/bin/uvx"
ok "uv installed at $HOME/.local/bin/uv"

# ── Install Claude CLI ────────────────────────────
step "4/9 — Claude CLI"
if ! command -v claude &>/dev/null; then
    info "Installing Claude CLI..."
    npm install -g @anthropic-ai/claude-code 2>&1 | tail -1
fi
CLAUDE_PATH=$(which claude 2>/dev/null || echo "$NODE_BIN_DIR/claude")
ok "Claude CLI at $CLAUDE_PATH"

# ── Download Goose CLI ────────────────────────────
step "5/9 — Goose CLI"
cd "$INSTALL_DIR"

if [ "$GOOSE_VERSION" = "latest" ]; then
    info "Fetching latest Goose release..."
    GOOSE_VERSION=$(curl -sI https://github.com/block/goose/releases/latest | grep -i '^location:' | grep -oP 'v\K[0-9.]+' || echo "1.26.1")
    info "Latest version: v$GOOSE_VERSION"
fi

if [ "$ARCH" = "aarch64" ]; then
    GOOSE_ARCHIVE="goose-aarch64-unknown-linux-gnu.tar.bz2"
else
    GOOSE_ARCHIVE="goose-x86_64-unknown-linux-gnu.tar.bz2"
fi

if [ ! -f goose ] || [ "$(./goose --version 2>/dev/null | awk '{print $2}')" != "$GOOSE_VERSION" ]; then
    info "Downloading Goose v$GOOSE_VERSION for $ARCH..."
    curl -L -o goose.tar.bz2 "https://github.com/block/goose/releases/download/v$GOOSE_VERSION/$GOOSE_ARCHIVE"
    tar xjf goose.tar.bz2
    rm -f goose.tar.bz2
    chmod +x goose
fi
ok "Goose CLI $(./goose --version 2>/dev/null || echo "v$GOOSE_VERSION")"

# ── Install Whisper + ffmpeg ──────────────────────
step "6/9 — Whisper (voice dictation)"

# ffmpeg is required by whisper for audio format conversion
if ! command -v ffmpeg &>/dev/null; then
    info "Installing ffmpeg..."
    if command -v apt-get &>/dev/null; then
        sudo apt-get update -qq && sudo apt-get install -y -qq ffmpeg 2>&1 | tail -1
    else
        warn "Could not install ffmpeg (no apt-get). Install manually."
    fi
fi

WHISPER_PYTHON="$HOME/.local/share/uv/tools/openai-whisper/bin/python3"
if [ ! -x "$WHISPER_PYTHON" ]; then
    info "Installing openai-whisper via uv tool..."
    "$HOME/.local/bin/uv" tool install openai-whisper 2>&1 | tail -3
fi

if [ -x "$WHISPER_PYTHON" ]; then
    info "Pre-downloading whisper base model..."
    "$WHISPER_PYTHON" -c "import whisper; whisper.load_model('base'); print('Model ready')" 2>&1 | tail -1
    ok "Whisper installed with base model"
else
    warn "Whisper installation failed. Voice dictation will not work."
fi

# ── Extract frontend assets ──────────────────────
step "7/9 — Frontend assets"
if [ -n "$FRONTEND_TARBALL" ] && [ -f "$FRONTEND_TARBALL" ]; then
    mkdir -p "$INSTALL_DIR/frontend"
    tar xzf "$FRONTEND_TARBALL" -C "$INSTALL_DIR/frontend"
    ok "Frontend extracted from $FRONTEND_TARBALL"
elif [ -d "$INSTALL_DIR/frontend" ] && [ -f "$INSTALL_DIR/frontend/index.html" ]; then
    ok "Frontend assets already present"
else
    warn "No frontend assets found!"
    warn "Copy from a machine with the Goose desktop app:"
    warn "  1. Run the Goose desktop app at least once"
    warn "  2. Run: ./package-frontend.sh"
    warn "  3. Copy the tarball here and run: tar xzf goose-frontend.tar.gz -C $INSTALL_DIR/frontend/"
fi

# ── Deploy application files ─────────────────────
step "8/9 — Application files"

# Copy serve.js, whisper_server.py from the repo
for f in serve.js whisper_server.py; do
    if [ -f "$SCRIPT_DIR/$f" ]; then
        cp "$SCRIPT_DIR/$f" "$INSTALL_DIR/$f"
        ok "Copied $f"
    else
        warn "$f not found in $SCRIPT_DIR"
    fi
done

# Create start.sh
cat > "$INSTALL_DIR/start.sh" << STARTEOF
#!/bin/bash
# Goose Web — Startup Script (generated by install.sh)
export PATH=$NODE_BIN_DIR:\$HOME/.local/bin:\$PATH
cd $INSTALL_DIR

# Kill existing
kill \$(netstat -tlnp 2>/dev/null | grep ':3010 ' | sed 's|.*LISTEN *||' | cut -d/ -f1) 2>/dev/null
kill \$(netstat -tlnp 2>/dev/null | grep ':3001 ' | sed 's|.*LISTEN *||' | cut -d/ -f1) 2>/dev/null
kill \$(netstat -tlnp 2>/dev/null | grep ':3012 ' | sed 's|.*LISTEN *||' | cut -d/ -f1) 2>/dev/null
sleep 1

# 1. Goose backend (port 3010)
GOOSE_PROVIDER=claude-code GOOSE_MODEL='opus[1m]' CLAUDE_CODE_COMMAND=$CLAUDE_PATH GOOSE_MAX_TURNS=5000 nohup ./goose web --host 0.0.0.0 --port 3010 --no-auth > goosed.log 2>&1 &
echo '[1/4] goosed started (port 3010)'
sleep 4

# 2. Whisper transcription server (port 3012)
WHISPER_PYTHON=$WHISPER_PYTHON
if [ -x "\$WHISPER_PYTHON" ]; then
  nohup "\$WHISPER_PYTHON" whisper_server.py --model base --port 3012 > whisper.log 2>&1 &
  echo '[2/4] whisper server started (port 3012)'
else
  echo '[2/4] whisper server SKIPPED (not installed)'
fi
sleep 2

# 3. Frontend + API shim (port 3001)
GOOSED_HOST=127.0.0.1 GOOSED_PORT=3010 WHISPER_PORT=3012 nohup node serve.js > serve.log 2>&1 &
echo '[3/4] serve.js started (port 3001)'
sleep 1

# 4. Tailscale Funnel
if command -v tailscale &>/dev/null; then
  tailscale funnel --bg 3001 2>/dev/null
  echo '[4/4] Tailscale Funnel active'
  HOSTNAME=\$(tailscale status --self --json 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin).get('Self',{}).get('DNSName','').rstrip('.'))" 2>/dev/null || echo "unknown")
  echo ""
  echo "=== Goose Web Running ==="
  echo "  Local:  http://localhost:3001"
  echo "  Remote: https://\$HOSTNAME"
  echo "  Voice:  Whisper on port 3012"
else
  echo '[4/4] Tailscale not found — no HTTPS URL'
  echo ""
  echo "=== Goose Web Running ==="
  echo "  Local:  http://localhost:3001"
fi
STARTEOF
chmod +x "$INSTALL_DIR/start.sh"
ok "start.sh created"

# ── Create config.yaml ────────────────────────────
step "9/9 — Goose configuration"

if [ -f "$CONFIG_DIR/config.yaml" ]; then
    warn "Config already exists at $CONFIG_DIR/config.yaml"
    warn "Backing up to config.yaml.bak"
    cp "$CONFIG_DIR/config.yaml" "$CONFIG_DIR/config.yaml.bak"
fi

cat > "$CONFIG_DIR/config.yaml" << CONFIGEOF
extensions:
  todo:
    enabled: true
    type: platform
    name: todo
    description: Enable a todo list for goose so it can keep track of what it is doing
    display_name: Todo
    bundled: true
    available_tools: []
  extensionmanager:
    enabled: true
    type: platform
    name: Extension Manager
    description: Enable extension management tools for discovering, enabling, and disabling extensions
    display_name: Extension Manager
    bundled: true
    available_tools: []
  tom:
    enabled: true
    type: platform
    name: tom
    description: Inject custom context into every turn via GOOSE_MOIM_MESSAGE_TEXT and GOOSE_MOIM_MESSAGE_FILE environment variables
    display_name: Top Of Mind
    bundled: true
    available_tools: []
  code_execution:
    enabled: true
    type: platform
    name: code_execution
    description: Goose will make extension calls through code execution, saving tokens
    display_name: Code Mode
    bundled: true
    available_tools: []
  apps:
    enabled: true
    type: platform
    name: apps
    description: Create and manage custom Goose apps through chat. Apps are HTML/CSS/JavaScript and run in sandboxed windows.
    display_name: Apps
    bundled: true
    available_tools: []
  chatrecall:
    enabled: true
    type: platform
    name: chatrecall
    description: Search past conversations and load session summaries for contextual memory
    display_name: Chat Recall
    bundled: true
    available_tools: []
  summon:
    enabled: true
    type: platform
    name: summon
    description: Load knowledge and delegate tasks to subagents
    display_name: Summon
    bundled: true
    available_tools: []
  developer:
    enabled: true
    type: builtin
    name: developer
    description: General development tools useful for software engineering.
    display_name: Developer
    timeout: 300
    bundled: true
    available_tools: []
  computercontroller:
    enabled: true
    type: builtin
    name: computercontroller
    description: General computer control tools that don't require you to be a developer or engineer.
    display_name: Computer Controller
    timeout: 300
    bundled: true
    available_tools: []
  autovisualiser:
    enabled: true
    type: builtin
    name: autovisualiser
    description: Data visualization and UI generation tools
    display_name: Auto Visualiser
    timeout: 300
    bundled: true
    available_tools: []
  memory:
    enabled: true
    type: builtin
    name: memory
    description: Teach goose your preferences as you go.
    display_name: Memory
    timeout: 300
    bundled: true
    available_tools: []
  tutorial:
    enabled: true
    type: builtin
    name: tutorial
    description: Access interactive tutorials and guides
    display_name: Tutorial
    timeout: 300
    bundled: true
    available_tools: []
  filesystem:
    enabled: true
    type: stdio
    name: Filesystem
    description: File system operations and management
    cmd: $NPX_PATH
    args:
    - -y
    - '@modelcontextprotocol/server-filesystem'
    - \$HOME
    envs: {}
    env_keys: []
    timeout: 300
    bundled: null
    available_tools: []
  councilofmine:
    enabled: true
    type: stdio
    name: Council of Mine
    description: LLM council debate with 9 distinct personas for decision-making
    cmd: $UVX_PATH
    args:
    - --from
    - git+https://github.com/block/mcp-council-of-mine
    - mcp_council_of_mine
    envs: {}
    env_keys: []
    timeout: 300
    bundled: null
    available_tools: []
  fetch:
    enabled: true
    type: stdio
    name: Fetch
    description: Web content fetching and conversion to markdown
    display_name: Fetch
    cmd: $UVX_PATH
    args:
    - mcp-server-fetch
    envs: {}
    env_keys: []
    timeout: 300
    bundled: null
    available_tools: []
  pdfreader:
    enabled: true
    type: stdio
    name: PDF Reader
    description: Read large and complex PDF documents
    display_name: PDF Reader
    cmd: $UVX_PATH
    args:
    - mcp-read-pdf
    envs: {}
    env_keys: []
    timeout: 300
    bundled: null
    available_tools: []
  youtube_transcript:
    enabled: true
    type: stdio
    name: YouTube Transcript
    description: Extract video transcripts from YouTube
    display_name: YouTube Transcript
    cmd: $UVX_PATH
    args:
    - --from
    - git+https://github.com/jkawamoto/mcp-youtube-transcript
    - mcp-youtube-transcript
    envs: {}
    env_keys: []
    timeout: 300
    bundled: null
    available_tools: []
  context7:
    enabled: true
    type: stdio
    name: Context7
    description: Access up-to-date code documentation and examples for any library
    display_name: Context7
    cmd: $NPX_PATH
    args:
    - -y
    - '@upstash/context7-mcp'
    envs: {}
    env_keys: []
    timeout: 300
    bundled: null
    available_tools: []
  repomix:
    enabled: true
    type: stdio
    name: Repomix
    description: Repository analysis and code organization into single files
    display_name: Repomix
    cmd: $NPX_PATH
    args:
    - -y
    - repomix-mcp
    envs: {}
    env_keys: []
    timeout: 300
    bundled: null
    available_tools: []
  knowledgegraph:
    enabled: true
    type: stdio
    name: Knowledge Graph Memory
    description: Graph-based memory system for persistent knowledge storage
    display_name: Knowledge Graph Memory
    cmd: $NPX_PATH
    args:
    - -y
    - '@modelcontextprotocol/server-memory'
    envs: {}
    env_keys: []
    timeout: 300
    bundled: null
    available_tools: []
  beads:
    enabled: true
    type: stdio
    name: Beads
    description: Git-backed issue tracker for AI agent task management
    display_name: Beads
    cmd: $UVX_PATH
    args:
    - beads-mcp
    envs: {}
    env_keys: []
    timeout: 300
    bundled: null
    available_tools: []
  promptschat:
    enabled: true
    type: stdio
    name: prompts.chat
    description: Access thousands of curated AI prompts
    display_name: prompts.chat
    cmd: $NPX_PATH
    args:
    - -y
    - '@fkadev/prompts.chat-mcp@latest'
    envs: {}
    env_keys: []
    timeout: 300
    bundled: null
    available_tools: []
  excalidraw:
    enabled: true
    type: streamable_http
    name: Excalidraw
    description: Diagramming and visual collaboration
    display_name: Excalidraw
    uri: https://excalidraw-mcp-app.vercel.app/mcp
    envs: {}
    env_keys: []
    headers: {}
    timeout: 300
    bundled: null
    available_tools: []
  goosedocs:
    enabled: true
    type: stdio
    name: Goose Docs
    description: Access Goose documentation via GitMCP
    display_name: Goose Docs
    cmd: $NPX_PATH
    args:
    - -y
    - mcp-remote
    - https://block.gitmcp.io/goose/
    envs: {}
    env_keys: []
    timeout: 300
    bundled: null
    available_tools: []
  containeruse:
    enabled: true
    type: stdio
    name: Container Use
    description: Container workflows and Docker integration
    display_name: Container Use
    cmd: $NPX_PATH
    args:
    - -y
    - mcp-remote
    - https://container-use.com/mcp
    envs: {}
    env_keys: []
    timeout: 300
    bundled: null
    available_tools: []
  playwright:
    enabled: true
    type: stdio
    name: Playwright
    description: Browser automation and web interaction via accessibility snapshots
    display_name: Playwright
    cmd: $NPX_PATH
    args:
    - -y
    - '@playwright/mcp@latest'
    envs: {}
    env_keys: []
    timeout: 300
    bundled: null
    available_tools: []
GOOSE_TELEMETRY_ENABLED: true
GOOSE_PROVIDER: claude-code
GOOSE_MODEL: 'opus[1m]'
CLAUDE_CODE_COMMAND: $CLAUDE_PATH
GOOSE_MAX_TURNS: 5000
SECURITY_PROMPT_ENABLED: true
CONFIGEOF

ok "Config written to $CONFIG_DIR/config.yaml"
info "26 extensions configured (all no-API-key)"

# ── Done ──────────────────────────────────────────
echo ""
echo "╔════════════════════════════════════════════╗"
echo "║         Installation Complete!             ║"
echo "╚════════════════════════════════════════════╝"
echo ""
echo "  Installed to: $INSTALL_DIR"
echo ""
echo "  Next steps:"
echo ""
echo "  1. Log into Claude CLI:"
echo "     claude login"
echo ""
if command -v tailscale &>/dev/null; then
    echo "  2. Allow non-root Tailscale Funnel (one-time):"
    echo "     sudo tailscale set --operator=\$USER"
    echo ""
fi
if [ ! -f "$INSTALL_DIR/frontend/index.html" ]; then
    echo "  3. Copy frontend assets:"
    echo "     On a machine with the Goose desktop app, run:"
    echo "       ./package-frontend.sh"
    echo "     Then copy and extract:"
    echo "       scp goose-frontend.tar.gz $(whoami)@\$(hostname):$INSTALL_DIR/"
    echo "       cd $INSTALL_DIR && mkdir -p frontend && tar xzf goose-frontend.tar.gz -C frontend"
    echo ""
fi
echo "  Start Goose Web:"
echo "     ~/goose-web/start.sh"
echo ""
