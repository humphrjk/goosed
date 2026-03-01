const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const STATIC_DIR = process.env.STATIC_DIR || '/home/humphrjk/goose-web/frontend';
const PORT = parseInt(process.env.PORT || "3001");
const GOOSED_HOST = process.env.GOOSED_HOST || '127.0.0.1';
const GOOSED_PORT = parseInt(process.env.GOOSED_PORT || '3000');
const SECRET = process.env.SECRET || 'goose-web-access';

// Known static file extensions
const STATIC_EXT = new Set(['.html', '.js', '.css', '.json', '.png', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.mp3', '.wav', '.map']);

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

// Shim to mock Electron preload APIs
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
    platform: 'win32',
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

// ===========================================================================
// Mock config endpoints (normally served by Electron backend, not goosed)
// ===========================================================================

const GOOSE_CONFIG = {
  GOOSE_PROVIDER: 'claude-code',
  GOOSE_MODEL: 'opus[1m]',
  GOOSE_TELEMETRY_ENABLED: 'true',
  GOOSE_MAX_TURNS: '5000',
  SECURITY_PROMPT_ENABLED: 'true',
  voice_dictation_provider: 'local',
  LOCAL_WHISPER_MODEL: 'base',
};

// Load extensions from goose config.yaml
function loadExtensionsFromConfig() {
  var configPath = process.env.GOOSE_CONFIG || (process.env.HOME || '/home/humphrjk') + '/.config/goose/config.yaml';
  try {
    var yaml = fs.readFileSync(configPath, 'utf8');
    var extensions = [];
    // Simple YAML parser for the extensions block
    var lines = yaml.split('\n');
    var inExtensions = false;
    var currentExt = null;
    var currentKey = null;
    var inArgs = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line === 'extensions:') { inExtensions = true; continue; }
      if (inExtensions && /^[A-Z]/.test(line)) break; // End of extensions block
      if (!inExtensions) continue;

      // Top-level extension key (2-space indent)
      if (/^  [a-z]/.test(line) && line.indexOf(':') > 0 && !line.match(/^    /)) {
        if (currentExt) extensions.push(currentExt);
        currentExt = { enabled: true, type: 'builtin', name: '', description: '', display_name: '' };
        currentKey = line.trim().replace(':', '');
        inArgs = false;
        continue;
      }
      if (!currentExt) continue;

      var trimmed = line.trim();
      if (trimmed.startsWith('- ') && inArgs) {
        if (!currentExt.args) currentExt.args = [];
        currentExt.args.push(trimmed.substring(2).replace(/^'|'$/g, '').replace(/^"|"$/g, ''));
        continue;
      }
      inArgs = false;

      var kv = trimmed.match(/^([a-z_]+):\s*(.*)$/);
      if (kv) {
        var k = kv[1], v = kv[2].replace(/^'|'$/g, '').replace(/^"|"$/g, '');
        if (k === 'enabled') currentExt.enabled = v === 'true';
        else if (k === 'type') currentExt.type = v;
        else if (k === 'name') currentExt.name = v;
        else if (k === 'description') currentExt.description = v;
        else if (k === 'display_name') currentExt.display_name = v;
        else if (k === 'cmd') currentExt.cmd = v;
        else if (k === 'uri') currentExt.uri = v;
        else if (k === 'timeout') currentExt.timeout = parseInt(v) || 300;
        else if (k === 'bundled') currentExt.bundled = v === 'true' ? true : v === 'null' ? null : false;
        else if (k === 'args') { inArgs = true; currentExt.args = []; }
      }
    }
    if (currentExt) extensions.push(currentExt);
    console.log('[Config] Loaded ' + extensions.length + ' extensions from ' + configPath);
    return extensions;
  } catch(e) {
    console.error('[Config] Failed to load extensions from ' + configPath + ':', e.message);
    return [];
  }
}

var EXTENSIONS = loadExtensionsFromConfig();

const MOCK_PROVIDERS = [
  {
    name: 'claude-code',
    is_configured: true,
    provider_type: 'BuiltIn',
    metadata: {
      display_name: 'Claude Code',
      description: 'Use Claude CLI as the AI provider',
    },
  },
];

function jsonResponse(res, data, status) {
  status = status || 200;
  var body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req, callback) {
  var body = '';
  req.on('data', function(chunk) { body += chunk; });
  req.on('end', function() { callback(body); });
}

function handleConfigEndpoint(req, res, urlPath) {
  if (req.method === 'GET' && urlPath === '/config') {
    jsonResponse(res, { config: GOOSE_CONFIG });
    return true;
  }
  if (req.method === 'POST' && urlPath === '/config/read') {
    readBody(req, function(body) {
      try {
        var parsed = JSON.parse(body);
        var value = GOOSE_CONFIG[parsed.key];
        jsonResponse(res, value !== undefined ? value : null);
      } catch(e) { jsonResponse(res, null); }
    });
    return true;
  }
  if (req.method === 'POST' && urlPath === '/config/upsert') {
    readBody(req, function(body) {
      try {
        var parsed = JSON.parse(body);
        if (parsed.key) GOOSE_CONFIG[parsed.key] = parsed.value;
      } catch(e) {}
      jsonResponse(res, { success: true });
    });
    return true;
  }
  if (req.method === 'POST' && urlPath === '/config/remove') {
    readBody(req, function(body) {
      try { var parsed = JSON.parse(body); delete GOOSE_CONFIG[parsed.key]; } catch(e) {}
      jsonResponse(res, { success: true });
    });
    return true;
  }
  if (req.method === 'GET' && urlPath === '/config/providers') {
    jsonResponse(res, MOCK_PROVIDERS);
    return true;
  }
  if (req.method === 'GET' && (urlPath === '/config/provider-catalog' || urlPath.startsWith('/config/provider-catalog/'))) {
    jsonResponse(res, MOCK_PROVIDERS);
    return true;
  }
  if (req.method === 'GET' && /^\/config\/providers\/[^/]+\/models$/.test(urlPath)) {
    jsonResponse(res, ['opus[1m]', 'sonnet', 'haiku']);
    return true;
  }
  if (req.method === 'POST' && urlPath === '/config/set_provider') {
    readBody(req, function(body) {
      try {
        var parsed = JSON.parse(body);
        if (parsed.provider) GOOSE_CONFIG.GOOSE_PROVIDER = parsed.provider;
        if (parsed.model) GOOSE_CONFIG.GOOSE_MODEL = parsed.model;
      } catch(e) {}
      jsonResponse(res, { success: true });
    });
    return true;
  }
  if (req.method === 'POST' && urlPath === '/config/check_provider') {
    jsonResponse(res, { valid: true });
    return true;
  }
  if (req.method === 'POST' && urlPath === '/config/detect') {
    jsonResponse(res, { provider_name: 'claude-code', models: ['opus[1m]'] });
    return true;
  }
  if (req.method === 'GET' && urlPath === '/config/extensions') {
    jsonResponse(res, { extensions: EXTENSIONS, warnings: [] });
    return true;
  }
  if (req.method === 'GET' && urlPath === '/config/permissions') {
    jsonResponse(res, {}); return true;
  }
  if (req.method === 'GET' && urlPath === '/config/slash_commands') {
    jsonResponse(res, []); return true;
  }
  if (req.method === 'GET' && urlPath === '/config/prompts') {
    jsonResponse(res, []); return true;
  }
  if (req.method === 'POST' && urlPath === '/config/canonical-model-info') {
    jsonResponse(res, { name: 'opus[1m]', display_name: 'Claude Opus', provider: 'claude-code' });
    return true;
  }
  if (req.method === 'POST' && urlPath === '/config/custom-providers') {
    jsonResponse(res, []); return true;
  }
  if (urlPath === '/config/backup' || urlPath === '/config/recover') {
    jsonResponse(res, { success: true }); return true;
  }
  if (req.method === 'OPTIONS' && urlPath.startsWith('/config')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Secret-Key, x-secret-key',
    });
    res.end();
    return true;
  }
  // Catch-all for unhandled /config/*
  if (urlPath.startsWith('/config/')) {
    if (req.method === 'GET') { jsonResponse(res, {}); return true; }
    if (req.method === 'POST') { readBody(req, function() { jsonResponse(res, { success: true }); }); return true; }
  }
  return false;
}

// ===========================================================================
// Agent API bridge: Electron frontend API -> goose web WebSocket
// ===========================================================================
// The Electron frontend uses REST+SSE: POST /agent/start, POST /agent/reply
// goose web uses WebSocket at /ws with JSON messages
// We bridge between them here.

var sessionCounter = 0;
var activeSessions = {};  // sessionId -> { ws, messages }

function generateSessionId() {
  var now = new Date();
  var y = now.getFullYear();
  var mo = String(now.getMonth() + 1).padStart(2, '0');
  var d = String(now.getDate()).padStart(2, '0');
  var h = String(now.getHours()).padStart(2, '0');
  var mi = String(now.getMinutes()).padStart(2, '0');
  var s = String(now.getSeconds()).padStart(2, '0');
  return y + mo + d + '_' + h + mi + s + '_' + (++sessionCounter);
}

function makeSession(id) {
  var now = new Date().toISOString();
  return {
    id: id,
    working_dir: '/home/humphrjk/goose-web',
    name: id,
    created_at: now,
    updated_at: now,
    extension_data: {},
    message_count: 0,
    accumulated_input_tokens: 0,
    accumulated_output_tokens: 0,
    provider: 'claude-code',
    model: 'opus[1m]',
  };
}

function makeMessage(role, text) {
  return {
    role: role,
    created: Math.floor(Date.now() / 1000),
    content: [{ type: 'text', text: text }],
    metadata: { userVisible: true, agentVisible: true },
  };
}

// Cache goosed WS token and session ID (fetched once from goosed's session page)
var goosedWSToken = null;
var goosedSessionId = null;

function fetchGoosedInfo(callback) {
  if (goosedWSToken && goosedSessionId) {
    callback(goosedWSToken, goosedSessionId);
    return;
  }

  // Fetch root to get redirect (session ID is in the redirect path)
  var options = {
    hostname: GOOSED_HOST,
    port: GOOSED_PORT,
    path: '/',
    method: 'GET',
    headers: { 'x-secret-key': SECRET },
  };
  var req = http.request(options, function(res2) {
    if (res2.statusCode === 303 && res2.headers.location) {
      // Extract session ID from redirect path like /session/20260301_16
      var sessionMatch = res2.headers.location.match(/\/session\/([^/]+)/);
      if (sessionMatch) goosedSessionId = sessionMatch[1];

      // Follow redirect to get WS token
      var redirectOpts = Object.assign({}, options, { path: res2.headers.location });
      var req2 = http.request(redirectOpts, function(res3) {
        var body = '';
        res3.on('data', function(chunk) { body += chunk; });
        res3.on('end', function() {
          var match = body.match(/GOOSE_WS_TOKEN\s*=\s*'([^']+)'/);
          if (match) goosedWSToken = match[1];
          console.log('[WS] goosed session: ' + goosedSessionId + ', token: ' + (goosedWSToken || '').substring(0, 8) + '...');
          callback(goosedWSToken || '', goosedSessionId || '');
        });
      });
      req2.on('error', function() { callback('', ''); });
      req2.end();
    } else {
      var body = '';
      res2.on('data', function(chunk) { body += chunk; });
      res2.on('end', function() {
        var match = body.match(/GOOSE_WS_TOKEN\s*=\s*'([^']+)'/);
        if (match) goosedWSToken = match[1];
        callback(goosedWSToken || '', goosedSessionId || '');
      });
    }
    // Consume any remaining data
    res2.resume();
  });
  req.on('error', function() { callback('', ''); });
  req.end();
}

function connectGooseWS(sessionId, callback) {
  var session = {
    ws: null,
    messages: [],
    listeners: [],
    connected: false,
    buffer: [],
    goosedSessionId: null,
  };
  activeSessions[sessionId] = session;

  fetchGoosedInfo(function(token, gooseSessionId) {
    session.goosedSessionId = gooseSessionId;
    var wsUrl = 'ws://' + GOOSED_HOST + ':' + GOOSED_PORT + '/ws?token=' + encodeURIComponent(token);
    var ws = new WebSocket(wsUrl);
    session.ws = ws;

    ws.on('open', function() {
      session.connected = true;
      console.log('[WS] Connected to goosed for session ' + sessionId);
      // Send any buffered messages
      session.buffer.forEach(function(msg) { ws.send(msg); });
      session.buffer = [];
    });

    ws.on('message', function(data) {
      try {
        var msg = JSON.parse(data.toString());
        if (msg.type !== 'response') console.log('[WS] Received: type=' + msg.type);
        // Notify all listeners (SSE connections waiting for responses)
        session.listeners.forEach(function(listener) { listener(msg); });
      } catch(e) {
        console.error('[WS] Failed to parse message:', e);
      }
    });

    ws.on('close', function() {
      session.connected = false;
      console.log('[WS] Disconnected from goosed for session ' + sessionId);
      session.listeners.forEach(function(listener) {
        listener({ type: 'error', message: 'WebSocket disconnected' });
      });
    });

    ws.on('error', function(err) {
      console.error('[WS] Error for session ' + sessionId + ':', err.message);
    });

    if (callback) callback(session);
  });

  return session;
}

function sendToGooseWS(session, sessionId, message) {
  // Use goosed's internal session ID, not the frontend's
  var payload = JSON.stringify({
    type: 'message',
    content: message,
    session_id: session.goosedSessionId || sessionId,
    timestamp: Date.now(),
  });
  if (session.connected) {
    session.ws.send(payload);
  } else {
    session.buffer.push(payload);
  }
}

function handleAgentEndpoint(req, res, urlPath) {
  // CORS preflight
  if (req.method === 'OPTIONS' && urlPath.startsWith('/agent')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Secret-Key, x-secret-key',
    });
    res.end();
    return true;
  }

  // POST /agent/start - create a new session
  if (req.method === 'POST' && urlPath === '/agent/start') {
    readBody(req, function(body) {
      var sessionId = generateSessionId();
      connectGooseWS(sessionId, function() {
        var sessionObj = makeSession(sessionId);
        jsonResponse(res, sessionObj);
      });
    });
    return true;
  }

  // POST /reply or /agent/reply - send message, return SSE stream
  if (req.method === 'POST' && (urlPath === '/agent/reply' || urlPath === '/reply')) {
    readBody(req, function(body) {
      var parsed;
      try { parsed = JSON.parse(body); } catch(e) {
        jsonResponse(res, { error: 'Invalid JSON' }, 400);
        return;
      }

      var sessionId = parsed.session_id;
      var userMessage = parsed.user_message;

      // user_message is a Message object: {role, content: [{type:"text", text:"..."}]}
      // Extract the text content for the WS bridge
      var messageText = '';
      if (userMessage && typeof userMessage === 'object') {
        if (userMessage.content && Array.isArray(userMessage.content)) {
          var texts = [];
          for (var i = 0; i < userMessage.content.length; i++) {
            if (userMessage.content[i].type === 'text' && userMessage.content[i].text) {
              texts.push(userMessage.content[i].text);
            }
          }
          messageText = texts.join('\n');
        }
      } else if (typeof userMessage === 'string') {
        messageText = userMessage;
      }

      if (!messageText) {
        jsonResponse(res, { error: 'No message provided' }, 400);
        return;
      }

      console.log('[Reply] session=' + sessionId + ' msg=' + messageText.substring(0, 80));

      // Get or create session, then start SSE
      var session = activeSessions[sessionId];
      if (!session) {
        connectGooseWS(sessionId, function(newSession) {
          startSSEStream(newSession, sessionId, messageText, req, res);
        });
        return;
      }

      startSSEStream(session, sessionId, messageText, req, res);
    });
    return true;
  }

  // SSE stream helper (extracted for async session creation)
  function startSSEStream(session, sessionId, userMessage, req, res) {
      // Set up SSE response
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      var accumulatedText = '';
      var finished = false;

      function sendSSE(eventType, data) {
        if (finished && eventType !== 'close') return;
        res.write('event: ' + eventType + '\n');
        res.write('data: ' + JSON.stringify(data) + '\n\n');
      }

      // Listen for WebSocket messages
      function onWSMessage(msg) {
        if (finished) return;

        switch (msg.type) {
          case 'response':
            accumulatedText += (msg.content || '');
            sendSSE('message', {
              type: 'Message',
              message: makeMessage('assistant', accumulatedText),
              token_state: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            });
            break;

          case 'thinking':
            // Send as a message event with thinking content
            sendSSE('message', {
              type: 'Message',
              message: makeMessage('assistant', msg.content || '(thinking...)'),
              token_state: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            });
            break;

          case 'tool_request':
            // Forward tool requests as message events
            var toolText = accumulatedText;
            if (msg.tool) {
              toolText += '\n[Using tool: ' + (msg.tool.name || msg.tool) + ']';
            }
            sendSSE('message', {
              type: 'Message',
              message: makeMessage('assistant', toolText || '(using tools...)'),
              token_state: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            });
            break;

          case 'tool_response':
            // Tool completed, send update
            break;

          case 'tool_confirmation':
            // Auto-confirm tool use (no interactive prompts in web mode)
            if (session.ws && session.connected && msg.id) {
              session.ws.send(JSON.stringify({
                type: 'tool_confirmation_response',
                id: msg.id,
                confirmed: true,
              }));
            }
            break;

          case 'complete':
            sendSSE('message', {
              type: 'Finish',
              reason: 'complete',
              token_state: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            });
            finished = true;
            // Remove listener
            var idx = session.listeners.indexOf(onWSMessage);
            if (idx >= 0) session.listeners.splice(idx, 1);
            res.end();
            break;

          case 'error':
            sendSSE('message', {
              type: 'Error',
              error: msg.message || 'Unknown error',
            });
            finished = true;
            var idx2 = session.listeners.indexOf(onWSMessage);
            if (idx2 >= 0) session.listeners.splice(idx2, 1);
            res.end();
            break;

          default:
            // Forward unknown events
            break;
        }
      }

      session.listeners.push(onWSMessage);

      // Send the user message to goose
      sendToGooseWS(session, sessionId, userMessage);

      // Handle client disconnect (use res, not req — req closes after POST body is consumed)
      res.on('close', function() {
        finished = true;
        var idx = session.listeners.indexOf(onWSMessage);
        if (idx >= 0) session.listeners.splice(idx, 1);
      });
  }

  // POST /agent/stop - stop current session
  if (req.method === 'POST' && urlPath === '/agent/stop') {
    readBody(req, function(body) {
      try {
        var parsed = JSON.parse(body);
        var session = activeSessions[parsed.session_id];
        if (session && session.ws) {
          session.ws.close();
          delete activeSessions[parsed.session_id];
        }
      } catch(e) {}
      jsonResponse(res, { success: true });
    });
    return true;
  }

  // POST /agent/restart - restart agent
  if (req.method === 'POST' && urlPath === '/agent/restart') {
    readBody(req, function(body) {
      jsonResponse(res, { extension_results: [] });
    });
    return true;
  }

  // POST /agent/resume - resume session (returns ResumeAgentResponse)
  if (req.method === 'POST' && urlPath === '/agent/resume') {
    readBody(req, function(body) {
      try {
        var parsed = JSON.parse(body);
        var sessionId = parsed.session_id || generateSessionId();
        console.log('[Resume] session=' + sessionId);
        if (!activeSessions[sessionId]) {
          connectGooseWS(sessionId);
        }
        jsonResponse(res, {
          session: makeSession(sessionId),
          extension_results: [],
        });
      } catch(e) {
        var fallbackId = generateSessionId();
        jsonResponse(res, {
          session: makeSession(fallbackId),
          extension_results: [],
        });
      }
    });
    return true;
  }

  // GET /agent/tools - list available tools
  if (req.method === 'GET' && urlPath === '/agent/tools') {
    jsonResponse(res, []);
    return true;
  }

  // GET /agent/list_apps
  if (req.method === 'GET' && urlPath === '/agent/list_apps') {
    jsonResponse(res, []);
    return true;
  }

  // POST /agent/update_provider
  if (req.method === 'POST' && urlPath === '/agent/update_provider') {
    readBody(req, function() { jsonResponse(res, { success: true }); });
    return true;
  }

  // POST /agent/update_working_dir
  if (req.method === 'POST' && urlPath === '/agent/update_working_dir') {
    readBody(req, function() { jsonResponse(res, { success: true }); });
    return true;
  }

  // POST /agent/add_extension, /agent/remove_extension
  if (req.method === 'POST' && (urlPath === '/agent/add_extension' || urlPath === '/agent/remove_extension')) {
    readBody(req, function() { jsonResponse(res, { success: true }); });
    return true;
  }

  // POST /agent/update_from_session
  if (req.method === 'POST' && urlPath === '/agent/update_from_session') {
    readBody(req, function() { jsonResponse(res, { success: true }); });
    return true;
  }

  // POST /action-required/tool-confirmation
  if (req.method === 'POST' && urlPath === '/action-required/tool-confirmation') {
    readBody(req, function(body) {
      // Auto-confirm tool use
      jsonResponse(res, { confirmed: true });
    });
    return true;
  }

  // Catch-all for other /agent/* endpoints
  if (urlPath.startsWith('/agent/')) {
    if (req.method === 'GET') { jsonResponse(res, {}); return true; }
    if (req.method === 'POST') { readBody(req, function() { jsonResponse(res, { success: true }); }); return true; }
  }

  return false;
}

// ===========================================================================
// Session/search endpoints
// ===========================================================================

function handleSessionEndpoint(req, res, urlPath) {
  // GET /sessions/list or /sessions — return SessionListResponse format
  if (req.method === 'GET' && (urlPath === '/sessions' || urlPath === '/sessions/list')) {
    // Return active sessions as proper SessionListResponse
    var sessionList = [];
    Object.keys(activeSessions).forEach(function(sid) {
      sessionList.push(makeSession(sid));
    });
    jsonResponse(res, { sessions: sessionList });
    return true;
  }
  // GET /sessions/insights
  if (req.method === 'GET' && urlPath === '/sessions/insights') {
    jsonResponse(res, { totalSessions: Object.keys(activeSessions).length, totalTokens: 0 });
    return true;
  }
  // POST /sessions/search
  if (req.method === 'POST' && urlPath === '/sessions/search') {
    readBody(req, function() { jsonResponse(res, { sessions: [] }); });
    return true;
  }
  // GET /sessions/:id
  if (req.method === 'GET' && urlPath.match(/^\/sessions\/[^/]+$/)) {
    var sid = urlPath.split('/')[2];
    jsonResponse(res, makeSession(sid));
    return true;
  }
  // PUT /sessions/:id/name — rename session
  if (req.method === 'PUT' && urlPath.match(/^\/sessions\/[^/]+\/name$/)) {
    readBody(req, function() { jsonResponse(res, { success: true }); });
    return true;
  }
  // DELETE /sessions/:id
  if (req.method === 'DELETE' && urlPath.match(/^\/sessions\/[^/]+$/)) {
    var delSid = urlPath.split('/')[2];
    if (activeSessions[delSid]) {
      if (activeSessions[delSid].ws) activeSessions[delSid].ws.close();
      delete activeSessions[delSid];
    }
    jsonResponse(res, { success: true });
    return true;
  }
  if (urlPath.startsWith('/sessions/')) {
    if (req.method === 'GET') { jsonResponse(res, {}); return true; }
    if (req.method === 'POST') { readBody(req, function() { jsonResponse(res, { success: true }); }); return true; }
  }
  return false;
}

// ===========================================================================
// Dictation (voice-to-text) endpoints
// ===========================================================================

var childProcess = require('child_process');
var os = require('os');

var WHISPER_PORT = parseInt(process.env.WHISPER_PORT || '3012');

// Fallback: spawn a one-off whisper process if the persistent server is down
function fallbackTranscribe(parsed, res) {
  var mimeType = parsed.mime_type || 'audio/webm';
  var ext = '.webm';
  if (mimeType.indexOf('wav') !== -1) ext = '.wav';
  else if (mimeType.indexOf('mp3') !== -1) ext = '.mp3';
  else if (mimeType.indexOf('ogg') !== -1) ext = '.ogg';
  else if (mimeType.indexOf('mp4') !== -1) ext = '.mp4';

  var tmpFile = path.join(os.tmpdir(), 'whisper_' + Date.now() + ext);
  fs.writeFileSync(tmpFile, Buffer.from(parsed.audio, 'base64'));

  var modelName = GOOSE_CONFIG.LOCAL_WHISPER_MODEL || 'base';
  var homeDir = process.env.HOME || '/home/humphrjk';
  var whisperPython = homeDir + '/.local/share/uv/tools/openai-whisper/bin/python3';
  var script = 'import whisper,json;m=whisper.load_model("' + modelName + '");r=m.transcribe("' + tmpFile + '",language="en");print(json.dumps({"text":r["text"].strip()}))';

  console.log('[Dictation] Fallback: spawning one-off whisper process');
  var proc = childProcess.spawn(whisperPython, ['-c', script], { timeout: 120000 });
  var stdout = '';
  var stderr = '';
  proc.stdout.on('data', function(d) { stdout += d; });
  proc.stderr.on('data', function(d) { stderr += d; });
  proc.on('close', function(code) {
    try { fs.unlinkSync(tmpFile); } catch(e) {}
    if (code !== 0) {
      console.error('[Dictation] Fallback error:', stderr.substring(0, 300));
      jsonResponse(res, { error: 'Transcription failed' }, 500);
      return;
    }
    try {
      var result = JSON.parse(stdout.trim());
      console.log('[Dictation] Fallback transcribed: "' + (result.text || '').substring(0, 80) + '"');
      jsonResponse(res, { text: result.text || '' });
    } catch(e) {
      jsonResponse(res, { text: stdout.trim() });
    }
  });
}

var WHISPER_MODELS = [
  { id: 'tiny', size_mb: 75, url: 'https://huggingface.co/openai/whisper-tiny', description: 'Tiny - fastest, least accurate', downloaded: false, recommended: false },
  { id: 'base', size_mb: 142, url: 'https://huggingface.co/openai/whisper-base', description: 'Base - good balance of speed and accuracy', downloaded: false, recommended: true },
  { id: 'small', size_mb: 466, url: 'https://huggingface.co/openai/whisper-small', description: 'Small - better accuracy, slower', downloaded: false, recommended: false },
  { id: 'medium', size_mb: 1500, url: 'https://huggingface.co/openai/whisper-medium', description: 'Medium - high accuracy', downloaded: false, recommended: false },
  { id: 'large', size_mb: 3100, url: 'https://huggingface.co/openai/whisper-large-v3', description: 'Large - best accuracy, slowest', downloaded: false, recommended: false },
];

// Check which models are downloaded
function checkWhisperModels() {
  var homeDir = process.env.HOME || '/home/humphrjk';
  var modelDir = path.join(homeDir, '.cache', 'whisper');
  try {
    var files = fs.readdirSync(modelDir);
    WHISPER_MODELS.forEach(function(m) {
      m.downloaded = files.some(function(f) { return f.indexOf(m.id) !== -1; });
    });
  } catch(e) {
    // Model dir doesn't exist yet, all show as not downloaded
  }
}
checkWhisperModels();

function handleDictationEndpoint(req, res, urlPath) {
  // CORS preflight
  if (req.method === 'OPTIONS' && urlPath.startsWith('/dictation')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Secret-Key, x-secret-key',
    });
    res.end();
    return true;
  }

  // GET /dictation/config - return provider status
  if (req.method === 'GET' && urlPath === '/dictation/config') {
    checkWhisperModels();
    var baseModel = WHISPER_MODELS.find(function(m) { return m.id === (GOOSE_CONFIG.LOCAL_WHISPER_MODEL || 'base'); });
    var isConfigured = baseModel ? baseModel.downloaded : false;
    jsonResponse(res, {
      local: {
        configured: isConfigured,
        description: 'Local Whisper model running on GPU (offline, private)',
        uses_provider_config: false,
        config_key: 'LOCAL_WHISPER_MODEL',
      },
    });
    return true;
  }

  // GET /dictation/models - list available whisper models
  if (req.method === 'GET' && urlPath === '/dictation/models') {
    checkWhisperModels();
    jsonResponse(res, WHISPER_MODELS);
    return true;
  }

  // POST /dictation/models/:model_id/download - download a model
  var downloadMatch = urlPath.match(/^\/dictation\/models\/([^/]+)\/download$/);
  if (downloadMatch && req.method === 'POST') {
    var modelId = downloadMatch[1];
    console.log('[Dictation] Downloading whisper model: ' + modelId);
    // Spawn whisper to trigger model download (it downloads on first use)
    var tmpFile = path.join(os.tmpdir(), 'whisper_download_' + Date.now() + '.wav');
    // Create a tiny silent wav file for the download trigger
    var wavHeader = Buffer.alloc(44);
    wavHeader.write('RIFF', 0); wavHeader.writeUInt32LE(36, 4); wavHeader.write('WAVE', 8);
    wavHeader.write('fmt ', 12); wavHeader.writeUInt32LE(16, 16); wavHeader.writeUInt16LE(1, 20);
    wavHeader.writeUInt16LE(1, 22); wavHeader.writeUInt32LE(16000, 24); wavHeader.writeUInt32LE(32000, 28);
    wavHeader.writeUInt16LE(2, 32); wavHeader.writeUInt16LE(16, 34); wavHeader.write('data', 36);
    wavHeader.writeUInt32LE(0, 40);
    fs.writeFileSync(tmpFile, wavHeader);
    var whisperPath = (process.env.HOME || '/home/humphrjk') + '/.local/bin/whisper';
    var dlProc = childProcess.spawn(whisperPath, [tmpFile, '--model', modelId, '--language', 'en', '--output_dir', os.tmpdir()], {
      env: Object.assign({}, process.env, { PATH: (process.env.HOME || '/home/humphrjk') + '/.local/bin:' + process.env.PATH }),
    });
    dlProc.on('close', function() {
      try { fs.unlinkSync(tmpFile); } catch(e) {}
      checkWhisperModels();
      console.log('[Dictation] Model download complete: ' + modelId);
    });
    jsonResponse(res, { status: 'downloading' }, 202);
    return true;
  }

  // GET /dictation/models/:model_id/download - download progress
  if (downloadMatch && req.method === 'GET') {
    jsonResponse(res, { status: 'complete', progress: 100 });
    return true;
  }

  // DELETE /dictation/models/:model_id/download - cancel download
  if (downloadMatch && req.method === 'DELETE') {
    jsonResponse(res, { status: 'cancelled' });
    return true;
  }

  // DELETE /dictation/models/:model_id - delete a model
  var deleteMatch = urlPath.match(/^\/dictation\/models\/([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    jsonResponse(res, { status: 'deleted' });
    return true;
  }

  // POST /dictation/transcribe - proxy to persistent whisper server
  if (req.method === 'POST' && urlPath === '/dictation/transcribe') {
    readBody(req, function(body) {
      try {
        var parsed = JSON.parse(body);
        if (!parsed.audio) {
          jsonResponse(res, { error: 'No audio data' }, 400);
          return;
        }

        var audioSize = (Buffer.from(parsed.audio, 'base64').length / 1024).toFixed(1);
        console.log('[Dictation] Transcribing ' + audioSize + 'KB of ' + (parsed.mime_type || 'audio/webm'));

        // Forward to persistent whisper server on port 3012
        var postData = JSON.stringify({ audio: parsed.audio, mime_type: parsed.mime_type || 'audio/webm' });
        var whisperReq = http.request({
          hostname: '127.0.0.1',
          port: WHISPER_PORT,
          path: '/transcribe',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
          timeout: 60000,
        }, function(whisperRes) {
          var respBody = '';
          whisperRes.on('data', function(chunk) { respBody += chunk; });
          whisperRes.on('end', function() {
            try {
              var result = JSON.parse(respBody);
              console.log('[Dictation] Transcribed: "' + (result.text || '').substring(0, 80) + '"');
              jsonResponse(res, result, whisperRes.statusCode);
            } catch(e) {
              jsonResponse(res, { text: respBody.trim() });
            }
          });
        });

        whisperReq.on('error', function(err) {
          console.error('[Dictation] Whisper server not reachable:', err.message);
          // Fallback: spawn one-off whisper process
          fallbackTranscribe(parsed, res);
        });

        whisperReq.write(postData);
        whisperReq.end();
      } catch(e) {
        console.error('[Dictation] Error:', e);
        jsonResponse(res, { error: 'Invalid request' }, 400);
      }
    });
    return true;
  }

  return false;
}

// ===========================================================================
// Static files + proxy
// ===========================================================================

function isStaticFile(urlPath) {
  var ext = path.extname(urlPath);
  if (STATIC_EXT.has(ext)) return true;
  var filePath = path.join(STATIC_DIR, urlPath);
  return fs.existsSync(filePath);
}

function proxyToGoosed(req, res) {
  var options = {
    hostname: GOOSED_HOST,
    port: GOOSED_PORT,
    path: req.url,
    method: req.method,
    headers: Object.assign({}, req.headers, { 'x-secret-key': SECRET, host: GOOSED_HOST + ':' + GOOSED_PORT }),
  };
  var proxyReq = http.request(options, function(proxyRes) {
    var headers = Object.assign({}, proxyRes.headers);
    if (proxyRes.headers['content-type'] && proxyRes.headers['content-type'].indexOf('text/event-stream') !== -1) {
      headers['cache-control'] = 'no-cache';
      headers['connection'] = 'keep-alive';
    }
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', function() {
    res.writeHead(502);
    res.end('Bad Gateway - goosed not reachable at ' + GOOSED_HOST + ':' + GOOSED_PORT);
  });
  req.pipe(proxyReq);
}

// ===========================================================================
// Main server
// ===========================================================================

var server = http.createServer(function(req, res) {
  var urlPath = req.url.split('?')[0];

  // Log non-static requests for debugging
  if (!STATIC_EXT.has(path.extname(urlPath)) && urlPath !== '/' && urlPath !== '/sessions') {
    console.log('[REQ] ' + req.method + ' ' + urlPath);
  }

  // Serve index.html with injected shim
  if (urlPath === '/' || urlPath === '/index.html') {
    var filePath = path.join(STATIC_DIR, 'index.html');
    fs.readFile(filePath, 'utf8', function(err, html) {
      if (err) { res.writeHead(500); res.end('Error loading UI'); return; }
      html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*\/>/, '');
      html = html.replace('</head>', SHIM + '</head>');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    });
    return;
  }

  // Intercept config endpoints
  if (urlPath.startsWith('/config')) {
    if (handleConfigEndpoint(req, res, urlPath)) return;
  }

  // Intercept dictation endpoints
  if (urlPath.startsWith('/dictation')) {
    if (handleDictationEndpoint(req, res, urlPath)) return;
  }

  // CORS preflight for /reply
  if (req.method === 'OPTIONS' && (urlPath === '/reply' || urlPath.startsWith('/sessions'))) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Secret-Key, x-secret-key',
    });
    res.end();
    return;
  }

  // Intercept agent endpoints (bridge to goose web WS)
  if (urlPath.startsWith('/agent') || urlPath === '/reply' || urlPath === '/action-required/tool-confirmation') {
    if (handleAgentEndpoint(req, res, urlPath)) return;
  }

  // Intercept session endpoints
  if (urlPath.startsWith('/sessions')) {
    if (handleSessionEndpoint(req, res, urlPath)) return;
  }

  // Mock endpoints for status, telemetry, etc.
  if (urlPath === '/status') {
    jsonResponse(res, { status: 'ok' });
    return;
  }
  if (urlPath === '/system_info') {
    jsonResponse(res, { os: 'linux', arch: 'aarch64' });
    return;
  }
  if (urlPath === '/telemetry/event') {
    readBody(req, function() { jsonResponse(res, { success: true }); });
    return;
  }

  // CORS preflight for anything
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Secret-Key, x-secret-key',
    });
    res.end();
    return;
  }

  // Serve static assets
  if (isStaticFile(urlPath)) {
    var staticPath = path.join(STATIC_DIR, urlPath);
    if (fs.existsSync(staticPath)) {
      var ext = path.extname(staticPath);
      var contentType = MIME[ext] || 'application/octet-stream';
      fs.readFile(staticPath, function(err, data) {
        if (err) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
      });
      return;
    }
  }

  // Everything else goes to goosed
  proxyToGoosed(req, res);
});

// WebSocket proxy (for frontend WS connections)
server.on('upgrade', function(req, socket, head) {
  var options = {
    hostname: GOOSED_HOST,
    port: GOOSED_PORT,
    path: req.url,
    method: 'GET',
    headers: Object.assign({}, req.headers, { 'x-secret-key': SECRET }),
  };
  var proxyReq = http.request(options);
  proxyReq.on('upgrade', function(proxyRes, proxySocket, proxyHead) {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
      Object.entries(proxyRes.headers).map(function(kv) { return kv[0] + ': ' + kv[1]; }).join('\r\n') +
      '\r\n\r\n');
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });
  proxyReq.on('error', function() { socket.destroy(); });
  proxyReq.end();
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('Goose Web UI:   http://localhost:' + PORT);
  console.log('Tailscale:      https://aitop2.tailfb8701.ts.net/');
  console.log('Proxying API -> http://' + GOOSED_HOST + ':' + GOOSED_PORT);
  console.log('Config + Agent endpoints intercepted');
  console.log('Agent bridge: REST+SSE <-> goose web WebSocket');
});
