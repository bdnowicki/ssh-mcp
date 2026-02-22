# ssh-mcp

An MCP (Model Context Protocol) server that provides SSH connectivity as tools. Exposes 7 SSH tools over the Streamable HTTP MCP transport, with a built-in web dashboard for real-time terminal monitoring via xterm.js.

## Quick Start

```bash
npm install
npm run build      # TypeScript compilation → dist/
npm start          # Starts server on port 8022
```

Override the port with the `PORT` environment variable.

## MCP Tools

| Tool | Description |
|------|-------------|
| `ssh_connect` | Connect to an SSH host and establish a named session |
| `ssh_exec` | Execute a command on a session (supports background tasks on timeout) |
| `ssh_disconnect` | Disconnect an SSH session |
| `ssh_list_sessions` | List all active SSH sessions |
| `ssh_get_monitoring_url` | Get the browser terminal monitoring URL for a session |
| `ssh_cancel_command` | Cancel a running command or background task |
| `ssh_poll_task` | Poll the status of a background task |

## Dashboard

The server includes a browser-based dashboard at the root URL (`/`) for monitoring SSH sessions in real time.

- **Sidebar** lists all sessions with connection status and host details
- **Terminal viewer** displays live output from the selected session using xterm.js (read-only)
- **Controls** for autoscroll toggle and server-side buffer size adjustment
- **Remove button** on each session to clean up stale/disconnected entries
- Sessions appear automatically when created via MCP tools and update in real time over WebSocket

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Dashboard UI |
| `GET /session/{name}` | Single-session terminal page |
| `GET /api/status` | Server status JSON |
| `GET /api/sessions` | List sessions JSON |
| `POST /mcp` | MCP Streamable HTTP transport |
| `GET /mcp` | MCP SSE stream |
| `DELETE /mcp` | Close MCP session |
| `WS /ws/dashboard` | Dashboard WebSocket (session list updates) |
| `WS /ws/session/{name}` | Per-session terminal WebSocket (live output) |

## Architecture

```
src/
  index.ts         – HTTP server, MCP session/transport management
  ssh-manager.ts   – SSHManager: connection lifecycle, command queuing, background tasks, output buffering
  mcp-tools.ts     – MCP tool registration (7 tools) and request handlers
  web-server.ts    – Express app (static files, dashboard, session pages) + WebSocket upgrade handler
  types.ts         – TypeScript interfaces
static/
  app.js           – Browser xterm.js client for single-session view
  styles.css       – Single-session terminal styling
  dashboard.js     – Dashboard browser client (multi-session viewer, sidebar, controls)
  dashboard.css    – Dashboard styling
```

**Request flow:** MCP client → `POST /mcp` → StreamableHTTPServerTransport → Server → tool handler → SSHManager → ssh2 → remote host.

**Key patterns:**

- **Command queuing** — FIFO queue per session; commands execute sequentially, never concurrently on the same session.
- **Background tasks** — Commands exceeding their timeout transition to background tasks (returned as `ASYNC_TIMEOUT:{taskId}`), pollable via `ssh_poll_task`.
- **Output broadcasting** — Terminal output is pushed to all connected WebSocket clients and buffered (500 lines default, configurable) for late-joining browsers.
- **Session isolation** — Each MCP client gets a unique session ID with its own transport instance.

## Tech Stack

- TypeScript (ES2022, Node16 modules, strict mode)
- ES Modules (`"type": "module"`)
- Express 5, ws (WebSocket), ssh2
- xterm.js + fit addon (browser terminal)
- Node 22

## Container Build

```bash
# Multi-stage build via Containerfile
podman build -f Containerfile -t ssh-mcp .
podman run -p 8022:8022 ssh-mcp
```
