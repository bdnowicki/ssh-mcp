import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { SSHManager } from './ssh-manager.js';
import { registerTools } from './mcp-tools.js';
import { createApp, setupWebSocket } from './web-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.resolve(__dirname, '../..');
const PORT = parseInt(process.env.PORT || '8022', 10);

const sshManager = new SSHManager();
const app = createApp(sshManager, BASE_DIR);

// MCP session transport map
const transports = new Map<string, StreamableHTTPServerTransport>();

function createMCPServer(): Server {
  const server = new Server(
    { name: 'ssh-mcp-server', version: '3.0.0' },
    { capabilities: { tools: {} } }
  );
  registerTools(server, sshManager, () => `http://localhost:${PORT}`);
  return server;
}

// POST /mcp - client requests
app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res, req.body);
  } else if (!sessionId && isInitializeRequest(req.body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };
    const mcpServer = createMCPServer();
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } else {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: missing or invalid mcp-session-id' },
      id: null,
    });
  }
});

// GET /mcp - SSE stream for server notifications
app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res);
  } else {
    res.status(400).send('Invalid session');
  }
});

// DELETE /mcp - session cleanup
app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res);
  } else {
    res.status(400).send('Invalid session');
  }
});

const server = http.createServer(app);
setupWebSocket(server, sshManager);

server.listen(PORT, () => {
  process.stderr.write(`ssh-mcp server listening on http://localhost:${PORT}\n`);
});

const shutdown = () => {
  sshManager.cleanup();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
