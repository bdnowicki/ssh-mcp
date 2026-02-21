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

  // Root status page
  app.get('/', (_req, res) => {
    const sessions = sshManager.listSessions();
    res.json({
      status: 'ok',
      server: 'ssh-mcp',
      version: '3.0.0',
      sessions: sessions.length,
    });
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

export function setupWebSocket(server: http.Server, sshManager: SSHManager): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
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
