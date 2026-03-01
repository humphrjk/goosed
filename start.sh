#!/bin/bash
# Goose Web — Startup Script
export PATH=$HOME/.nvm/versions/node/v22.22.0/bin:$HOME/.local/bin:$PATH
cd ~/goose-web

# Kill existing
kill $(netstat -tlnp 2>/dev/null | grep ':3010 ' | sed 's|.*LISTEN *||' | cut -d/ -f1) 2>/dev/null
kill $(netstat -tlnp 2>/dev/null | grep ':3001 ' | sed 's|.*LISTEN *||' | cut -d/ -f1) 2>/dev/null
kill $(netstat -tlnp 2>/dev/null | grep ':3012 ' | sed 's|.*LISTEN *||' | cut -d/ -f1) 2>/dev/null
sleep 1

# Start goosed backend (port 3010)
GOOSE_PROVIDER=claude-code GOOSE_MODEL='opus[1m]' CLAUDE_CODE_COMMAND=$HOME/.nvm/versions/node/v22.22.0/bin/claude GOOSE_MAX_TURNS=5000 nohup ./goose web --host 0.0.0.0 --port 3010 --no-auth > goosed.log 2>&1 &
echo '[1/4] goosed started (port 3010)'
sleep 4

# Start whisper transcription server (port 3012, model stays in memory)
WHISPER_PYTHON=$HOME/.local/share/uv/tools/openai-whisper/bin/python3
if [ -x "$WHISPER_PYTHON" ]; then
  nohup "$WHISPER_PYTHON" whisper_server.py --model base --port 3012 > whisper.log 2>&1 &
  echo '[2/4] whisper server started (port 3012)'
else
  echo '[2/4] whisper server SKIPPED (openai-whisper not installed)'
fi
sleep 2

# Start serve.js frontend (port 3001)
GOOSED_HOST=127.0.0.1 GOOSED_PORT=3010 WHISPER_PORT=3012 nohup node serve.js > serve.log 2>&1 &
echo '[3/4] serve.js started (port 3001)'
sleep 1

# Tailscale Funnel
tailscale funnel --bg 3001 2>/dev/null
echo '[4/4] Tailscale Funnel active'

echo ''
echo '=== Goose Web Running ==='
echo '  Local:  http://localhost:3001'
echo '  Remote: https://aitop2.tailfb8701.ts.net'
echo '  Voice:  Whisper base model on port 3012'
