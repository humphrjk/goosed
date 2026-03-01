#!/bin/bash
set -euo pipefail

# ============================================================
# Goose Web — Install Script
# Sets up the full Goose desktop UI as a web app on a Linux
# ARM64 machine (e.g., NVIDIA DGX Spark) with Tailscale Funnel.
#
# Prerequisites:
#   - Ubuntu 24.04+ ARM64
#   - Tailscale installed and logged in
#   - Internet access
#   - Frontend assets tarball: goose-frontend.tar.gz
#     (create with: tar czf goose-frontend.tar.gz -C frontend .)
#
# What this does NOT install:
#   - SSH keys or credentials
#   - API keys or auth tokens
#   - Tailscale login (must be done separately)
#
# Usage:
#   chmod +x install.sh
#   ./install.sh [--frontend-tarball /path/to/goose-frontend.tar.gz]
# ============================================================

GOOSE_VERSION="1.26.1"
NODE_VERSION="22"
INSTALL_DIR="$HOME/goose-web"
CONFIG_DIR="$HOME/.config/goose"
FRONTEND_TARBALL="${1:-}"

echo "============================================"
echo "  Goose Web — Installation"
echo "============================================"
echo ""

# ── Check architecture ──────────────────────────
ARCH=$(uname -m)
if [ "$ARCH" != "aarch64" ] && [ "$ARCH" != "x86_64" ]; then
    echo "ERROR: Unsupported architecture: $ARCH"
    echo "       This script supports aarch64 and x86_64."
    exit 1
fi

if [ "$ARCH" = "aarch64" ]; then
    GOOSE_ARCHIVE="goose-aarch64-unknown-linux-gnu.tar.bz2"
else
    GOOSE_ARCHIVE="goose-x86_64-unknown-linux-gnu.tar.bz2"
fi

# ── Create directories ──────────────────────────
echo "[1/8] Creating directories..."
mkdir -p "$INSTALL_DIR"
mkdir -p "$CONFIG_DIR"

# ── Install nvm + Node.js ───────────────────────
echo "[2/8] Installing nvm + Node.js $NODE_VERSION..."
if [ ! -d "$HOME/.nvm" ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm install "$NODE_VERSION"
nvm use "$NODE_VERSION"
echo "  Node.js $(node --version) installed"

# ── Install uv/uvx ─────────────────────────────
echo "[3/8] Installing uv/uvx..."
if ! command -v uvx &>/dev/null && [ ! -f "$HOME/.local/bin/uvx" ]; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
fi
echo "  uvx installed at $HOME/.local/bin/uvx"

# ── Install Claude CLI ──────────────────────────
echo "[4/8] Installing Claude CLI..."
npm install -g @anthropic-ai/claude-code
CLAUDE_PATH=$(which claude || echo "$NVM_DIR/versions/node/v$(node --version | tr -d v)/bin/claude")
echo "  Claude CLI installed at $CLAUDE_PATH"

# ── Download Goose CLI ──────────────────────────
echo "[5/8] Downloading Goose CLI v$GOOSE_VERSION ($ARCH)..."
cd "$INSTALL_DIR"
if [ ! -f goose ] || [ "$(./goose --version 2>/dev/null | awk '{print $2}')" != "$GOOSE_VERSION" ]; then
    curl -L -o goose.tar.bz2 "https://github.com/block/goose/releases/download/v$GOOSE_VERSION/$GOOSE_ARCHIVE"
    tar xjf goose.tar.bz2
    rm -f goose.tar.bz2
    chmod +x goose
fi
echo "  Goose $(./goose --version) installed"

# ── Extract frontend assets ─────────────────────
echo "[6/8] Setting up frontend assets..."
if [ -n "$FRONTEND_TARBALL" ] && [ -f "$FRONTEND_TARBALL" ]; then
    mkdir -p "$INSTALL_DIR/frontend"
    tar xzf "$FRONTEND_TARBALL" -C "$INSTALL_DIR/frontend"
    echo "  Frontend extracted from $FRONTEND_TARBALL"
elif [ -d "$INSTALL_DIR/frontend" ] && [ -f "$INSTALL_DIR/frontend/index.html" ]; then
    echo "  Frontend assets already present"
else
    echo "  WARNING: No frontend assets found!"
    echo "  Copy the Goose Electron app's frontend to $INSTALL_DIR/frontend/"
    echo "  On Windows: %TEMP%\\goose-app\\.vite\\renderer\\main_window\\"
    echo "  Or provide --frontend-tarball /path/to/goose-frontend.tar.gz"
fi

# ── Create serve.js ─────────────────────────────
echo "[7/8] Creating serve.js..."
NODE_BIN_DIR=$(dirname "$(which node)")
NPX_PATH="$NODE_BIN_DIR/npx"

cat > "$INSTALL_DIR/serve.js" << 'SERVEJS'
const http = require('http');
const fs = require('fs');
const path = require('path');

const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, 'frontend');
const PORT = parseInt(process.env.PORT || '3001');
const GOOSED_HOST = process.env.GOOSED_HOST || '127.0.0.1';
const GOOSED_PORT = parseInt(process.env.GOOSED_PORT || '3010');
const SECRET = process.env.SECRET || 'goose-web-access';

const STATIC_EXT = new Set(['.html', '.js', '.css', '.json', '.png', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.mp3', '.wav', '.map']);

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

const SHIM = `<script>
  const noopAsync = () => Promise.resolve(null);
  const config = {
    GOOSE_API_HOST: location.hostname,
    GOOSE_PORT: '${PORT}',
    GOOSE_SECRET_KEY: '${SECRET}',
    GOOSE_VERSION: '1.26.1',
    WS_PORT: '${PORT}',
  };
  window.appConfig = { get: (k) => config[k], getAll: () => config };
  window.electron = {
    platform: 'linux',
    getConfig: () => config,
    getSecretKey: () => Promise.resolve('${SECRET}'),
    getGoosedHostPort: () => Promise.resolve(location.origin),
    reactReady: () => {},
    hideWindow: () => {},
    directoryChooser: noopAsync,
    createChatWindow: () => {},
    logInfo: (msg) => console.log('[goose]', msg),
    showNotification: (msg) => { if (Notification.permission === 'granted') new Notification(msg.title || 'Goose', { body: msg.body }); },
    showMessageBox: noopAsync,
    showSaveDialog: noopAsync,
    openInChrome: (url) => window.open(url, '_blank'),
    fetchMetadata: noopAsync,
    reloadApp: () => location.reload(),
    checkForOllama: () => Promise.resolve(false),
    selectFileOrDirectory: noopAsync,
    getBinaryPath: noopAsync,
    readFile: noopAsync,
    writeFile: noopAsync,
    ensureDirectory: noopAsync,
    listFiles: noopAsync,
    getPathForFile: (f) => f?.name || '',
    getAllowedExtensions: () => Promise.resolve([]),
    setMenuBarIcon: noopAsync,
    getMenuBarIconState: () => Promise.resolve(true),
    setDockIcon: noopAsync,
    getDockIconState: () => Promise.resolve(true),
    getSetting: (k) => {
      const defaults = { theme: 'dark', useSystemTheme: false, responseStyle: 'detailed', showPricing: true, sessionSharing: { enabled: false, baseUrl: '' }, seenAnnouncementIds: [] };
      return Promise.resolve(defaults[k] ?? null);
    },
    setSetting: noopAsync,
    setWakelock: noopAsync,
    getWakelockState: () => Promise.resolve(false),
    setSpellcheck: noopAsync,
    getSpellcheckState: () => Promise.resolve(true),
    openNotificationsSettings: noopAsync,
    onMouseBackButtonClicked: () => () => {},
    offMouseBackButtonClicked: () => {},
    on: () => {},
    off: () => {},
    emit: () => {},
    broadcastThemeChange: () => {},
    openExternal: (url) => Promise.resolve(window.open(url, '_blank')),
    getVersion: () => '1.26.1',
    checkForUpdates: noopAsync,
    downloadUpdate: noopAsync,
    installUpdate: () => {},
    restartApp: () => location.reload(),
    onUpdaterEvent: () => {},
    getUpdateState: noopAsync,
    isUsingGitHubFallback: () => Promise.resolve(false),
    closeWindow: () => {},
    hasAcceptedRecipeBefore: () => Promise.resolve(false),
    recordRecipeHash: noopAsync,
    openDirectoryInExplorer: noopAsync,
    launchApp: noopAsync,
    refreshApp: noopAsync,
    closeApp: noopAsync,
    addRecentDir: noopAsync,
  };
</script>`;

function isStaticFile(urlPath) {
  const ext = path.extname(urlPath);
  if (STATIC_EXT.has(ext)) return true;
  const filePath = path.join(STATIC_DIR, urlPath);
  return fs.existsSync(filePath);
}

function proxyToGoosed(req, res) {
  const options = {
    hostname: GOOSED_HOST,
    port: GOOSED_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, 'x-secret-key': SECRET, host: GOOSED_HOST + ':' + GOOSED_PORT },
  };
  const proxyReq = http.request(options, (proxyRes) => {
    const headers = { ...proxyRes.headers };
    if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
      headers['cache-control'] = 'no-cache';
      headers['connection'] = 'keep-alive';
    }
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => {
    res.writeHead(502);
    res.end('Bad Gateway - goosed not reachable');
  });
  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '/index.html') {
    const filePath = path.join(STATIC_DIR, 'index.html');
    fs.readFile(filePath, 'utf8', (err, html) => {
      if (err) { res.writeHead(500); res.end('Error loading UI'); return; }
      html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*\/>/, '');
      html = html.replace('</head>', SHIM + '</head>');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    });
    return;
  }
  if (isStaticFile(urlPath)) {
    const filePath = path.join(STATIC_DIR, urlPath);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const contentType = MIME[ext] || 'application/octet-stream';
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
      });
      return;
    }
  }
  proxyToGoosed(req, res);
});

server.on('upgrade', (req, socket, head) => {
  const options = {
    hostname: GOOSED_HOST,
    port: GOOSED_PORT,
    path: req.url,
    method: 'GET',
    headers: { ...req.headers, 'x-secret-key': SECRET },
  };
  const proxyReq = http.request(options);
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
      Object.entries(proxyRes.headers).map(([k,v]) => `${k}: ${v}`).join('\r\n') +
      '\r\n\r\n');
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });
  proxyReq.on('error', () => socket.destroy());
  proxyReq.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Goose Web UI:   http://localhost:${PORT}`);
  console.log(`Proxying API -> http://${GOOSED_HOST}:${GOOSED_PORT}`);
});
SERVEJS

echo "  serve.js created"

# ── Create start.sh ─────────────────────────────
cat > "$INSTALL_DIR/start.sh" << STARTSH
#!/bin/bash
# Goose Web — Startup Script
export PATH=$NODE_BIN_DIR:\$HOME/.local/bin:\$PATH
cd $INSTALL_DIR

# Kill existing
kill \\\$(netstat -tlnp 2>/dev/null | grep ':3010 ' | sed 's|.*LISTEN *||' | cut -d/ -f1) 2>/dev/null
kill \\\$(netstat -tlnp 2>/dev/null | grep ':3001 ' | sed 's|.*LISTEN *||' | cut -d/ -f1) 2>/dev/null
sleep 1

# Start goosed backend (port 3010)
nohup ./goose web --host 0.0.0.0 --port 3010 --no-auth > goosed.log 2>&1 &
echo "[1/3] goosed started (port 3010)"
sleep 4

# Start serve.js frontend (port 3001)
GOOSED_HOST=127.0.0.1 GOOSED_PORT=3010 nohup node serve.js > serve.log 2>&1 &
echo "[2/3] serve.js started (port 3001)"
sleep 1

# Tailscale Funnel
tailscale funnel --bg 3001 2>/dev/null
echo "[3/3] Tailscale Funnel active"

echo ""
echo "=== Goose Web Running ==="
echo "  Local:  http://localhost:3001"
HOSTNAME=\$(tailscale status --self --json 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin).get('Self',{}).get('DNSName','').rstrip('.'))" 2>/dev/null || echo "unknown")
echo "  Remote: https://\$HOSTNAME"
STARTSH
chmod +x "$INSTALL_DIR/start.sh"

# ── Create config template ──────────────────────
echo "[8/8] Creating config template..."
cat > "$CONFIG_DIR/config.yaml" << CONFIGYAML
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
    cmd: \$HOME/.local/bin/uvx
    args:
    - --from
    - git+https://github.com/block/mcp-council-of-mine
    - mcp_council_of_mine
    envs: {}
    env_keys: []
    timeout: 300
    bundled: null
    available_tools: []
GOOSE_TELEMETRY_ENABLED: true
GOOSE_PROVIDER: claude-code
GOOSE_MODEL: opus[1m]
CLAUDE_CODE_COMMAND: $CLAUDE_PATH
GOOSE_MAX_TURNS: 5000
SECURITY_PROMPT_ENABLED: true
CONFIGYAML

echo "  Config template created at $CONFIG_DIR/config.yaml"

# ── Tailscale operator setup ────────────────────
echo ""
echo "============================================"
echo "  Installation Complete!"
echo "============================================"
echo ""
echo "Installed to: $INSTALL_DIR"
echo ""
echo "Next steps:"
echo "  1. Ensure Tailscale is logged in: tailscale status"
echo "  2. Allow non-root funnel (one-time):"
echo "     sudo tailscale set --operator=\$USER"
echo "  3. Log into Claude CLI:"
echo "     claude login"
echo "  4. If needed, copy frontend assets:"
echo "     scp -r /path/to/frontend/* $INSTALL_DIR/frontend/"
echo "  5. Start Goose Web:"
echo "     ~/goose-web/start.sh"
echo ""
