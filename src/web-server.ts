import express from 'express';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import http from 'node:http';
import path from 'node:path';
import type { SSHManager } from './ssh-manager.js';

export function createApp(sshManager: SSHManager, baseDir: string): express.Express {
  const app = express();
  app.use(express.json());

  // Serve xterm.js from node_modules
  const xtermPath = path.join(baseDir, 'node_modules', '@xterm', 'xterm');
  const fitAddonPath = path.join(baseDir, 'node_modules', '@xterm', 'addon-fit');
  app.use('/xterm', express.static(xtermPath));
  app.use('/xterm-addon-fit', express.static(fitAddonPath));

  // Serve static files (app.js, styles.css)
  app.use('/static', express.static(path.join(baseDir, 'static')));

  // Dashboard page
  app.get('/', (_req, res) => {
    res.type('html').send(generateDashboardPage());
  });

  // API status endpoint (old root response)
  app.get('/api/status', (_req, res) => {
    const sessions = sshManager.listSessions();
    res.json({
      status: 'ok',
      server: 'ssh-mcp',
      version: '3.0.0',
      sessions: sessions.length,
    });
  });

  // API sessions endpoint
  app.get('/api/sessions', (_req, res) => {
    res.json(sshManager.listSessions());
  });

  // Session terminal page
  app.get('/session/:name', (req, res) => {
    const sessionName = req.params.name;
    res.type('html').send(generateSessionPage(sessionName));
  });

  return app;
}

function generateSessionPage(sessionName: string): string {
  const escapedName = sessionName.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const jsName = JSON.stringify(sessionName);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SSH Session: ${escapedName}</title>
  <link rel="stylesheet" href="/xterm/css/xterm.css">
  <link rel="stylesheet" href="/static/styles.css">
</head>
<body>
  <div id="session-header">
    <span id="session-title">Session: ${escapedName}</span>
    <span id="connection-status">Connecting...</span>
  </div>
  <div id="terminal-container">
    <div id="terminal"></div>
  </div>
  <script src="/xterm/lib/xterm.js"></script>
  <script src="/xterm-addon-fit/lib/addon-fit.js"></script>
  <script>window.SESSION_NAME = ${jsName};</script>
  <script src="/static/app.js"></script>
</body>
</html>`;
}

function generateDashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SSH MCP Dashboard</title>
  <link rel="stylesheet" href="/xterm/css/xterm.css">
  <link rel="stylesheet" href="/static/dashboard.css">
</head>
<body>
  <div id="app">
    <aside id="sidebar">
      <div id="sidebar-header">SSH Sessions</div>
      <div id="session-list"></div>
    </aside>
    <main id="main-content">
      <div id="terminal-header">
        <div class="header-left">
          <span class="session-title" id="active-session-name">No session selected</span>
          <span class="connection-status" id="session-status"></span>
        </div>
        <div class="header-right">
          <div class="control-group">
            <label><input type="checkbox" id="autoscroll" checked> Autoscroll</label>
          </div>
          <div class="control-group">
            <select id="buffer-size">
              <option value="100">100 lines</option>
              <option value="250">250 lines</option>
              <option value="500" selected>500 lines</option>
              <option value="1000">1000 lines</option>
              <option value="2000">2000 lines</option>
              <option value="5000">5000 lines</option>
            </select>
          </div>
        </div>
      </div>
      <div id="terminal-container">
        <div id="dashboard-terminal"></div>
      </div>
      <div id="placeholder">Select a session to view terminal output</div>
    </main>
  </div>
  <script src="/xterm/lib/xterm.js"></script>
  <script src="/xterm-addon-fit/lib/addon-fit.js"></script>
  <script src="/static/dashboard.js"></script>
</body>
</html>`;
}

export function setupWebSocket(server: http.Server, sshManager: SSHManager): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    // Dashboard WebSocket
    if (url.pathname === '/ws/dashboard') {
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        sshManager.addDashboardClient(ws);

        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(String(raw));
            if (msg.type === 'set_buffer_size' && msg.sessionName && msg.lines) {
              sshManager.setBufferSize(msg.sessionName, msg.lines);
            } else if (msg.type === 'remove_session' && msg.sessionName) {
              sshManager.removeSession(msg.sessionName);
            }
          } catch {
            // ignore invalid messages
          }
        });

        ws.on('close', () => sshManager.removeDashboardClient(ws));
        ws.on('error', () => sshManager.removeDashboardClient(ws));
      });
      return;
    }

    // Session terminal WebSocket
    const match = url.pathname.match(/^\/ws\/session\/(.+)$/);
    if (!match) {
      socket.destroy();
      return;
    }

    const sessionName = decodeURIComponent(match[1]);
    if (!sshManager.hasSession(sessionName)) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      sshManager.addWsClient(sessionName, ws);
      ws.on('close', () => sshManager.removeWsClient(sessionName, ws));
      ws.on('error', () => sshManager.removeWsClient(sessionName, ws));
    });
  });

  return wss;
}
