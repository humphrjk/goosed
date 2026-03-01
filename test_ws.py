#!/usr/bin/env python3
"""Test WebSocket communication with goosed directly."""
import json
import re
import sys
import time
import urllib.request

# 1. Get session and token
resp = urllib.request.urlopen("http://localhost:3010/")
session = resp.url.split("/session/")[-1] if "/session/" in resp.url else ""
page = resp.read().decode()
match = re.search(r"GOOSE_WS_TOKEN = '([^']+)'", page)
token = match.group(1) if match else ""
print(f"Session: {session}")
print(f"Token: {token[:12]}...")

# 2. Connect via WebSocket using Node.js (has ws module)
import subprocess
node_script = f"""
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:3010/ws?token={token}');
ws.on('open', () => {{
  console.log('WS_CONNECTED');
  ws.send(JSON.stringify({{type:'message',content:'say hello in exactly one word',session_id:'{session}',timestamp:Date.now()}}));
  console.log('WS_SENT');
}});
ws.on('message', (data) => {{
  const msg = JSON.parse(data.toString());
  const preview = JSON.stringify(msg).substring(0, 300);
  console.log('WS_MSG: ' + preview);
  if (msg.type === 'complete') ws.close();
}});
ws.on('close', () => {{ console.log('WS_CLOSED'); process.exit(0); }});
ws.on('error', (e) => {{ console.log('WS_ERROR: ' + e.message); process.exit(1); }});
setTimeout(() => {{ console.log('WS_TIMEOUT'); process.exit(1); }}, 45000);
"""
proc = subprocess.run(
    ["/home/humphrjk/.nvm/versions/node/v22.22.0/bin/node", "-e", node_script],
    cwd="/home/humphrjk/goose-web",
    capture_output=True, text=True, timeout=60
)
print(proc.stdout)
if proc.stderr:
    print("STDERR:", proc.stderr[:500])
