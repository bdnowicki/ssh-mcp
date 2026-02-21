# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ssh-mcp is an MCP (Model Context Protocol) server that provides SSH connectivity as tools. It exposes 7 SSH tools (connect, exec, disconnect, list sessions, get monitoring URL, cancel command, poll task) over the Streamable HTTP MCP transport. A built-in Express web server with WebSocket support provides real-time browser-based terminal monitoring via xterm.js.

## Build & Run

```bash
npm run build      # TypeScript compilation → dist/
npm start          # Run server (requires build first)
npm run clean      # Remove dist/
```

Server listens on port 8022 by default (override with `PORT` env var).

No test framework is configured.

## Architecture

```
src/
  index.ts         – HTTP server, MCP session/transport management (POST/GET/DELETE /mcp)
  ssh-manager.ts   – SSHManager class: connection lifecycle, command queuing, background tasks, output buffering
  mcp-tools.ts     – MCP tool registration (7 tools) and request handlers
  web-server.ts    – Express app (static files, session pages) + WebSocket upgrade handler
  types.ts         – All TypeScript interfaces
static/
  app.js           – Browser xterm.js client (read-only terminal, WebSocket at /ws/session/{name})
  styles.css       – Terminal styling
```

**Request flow:** MCP client → POST /mcp → StreamableHTTPServerTransport → Server → tool handler in mcp-tools.ts → SSHManager method → ssh2 library → remote host.

**Key patterns:**
- **Command queuing:** SSHManager uses a FIFO queue per session — commands execute sequentially, never concurrently on the same session.
- **Background tasks:** Commands exceeding their timeout transition to background tasks (returned as `ASYNC_TIMEOUT:{taskId}`), pollable via `ssh_poll_task`.
- **Output broadcasting:** Terminal output is pushed to all connected WebSocket clients and buffered (500 lines max) for late-joining browsers.
- **Session isolation:** Each MCP client gets a unique session ID with its own transport instance.

## Tech Stack

- TypeScript (ES2022, Node16 modules, strict mode)
- ES Modules (`"type": "module"` — use `.js` extensions in imports)
- Express 5, ws (WebSocket), ssh2
- Node 22 (Alpine in container)

## Container Build

```bash
# Multi-stage build via Containerfile (not Dockerfile)
podman build -f Containerfile -t ssh-mcp .
```
