// Dashboard browser client — multi-session terminal viewer
// Uses xterm.js (read-only) with a sidebar for session switching
// and a WebSocket connection to /ws/dashboard for live session updates.

let sessions = [];
let activeSession = null;
let sessionWs = null;
let dashboardWs = null;
let term = null;
let fitAddon = null;
let autoScroll = true;

const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

// ---------------------------------------------------------------------------
// Dashboard WebSocket
// ---------------------------------------------------------------------------

function connectDashboardWs() {
  dashboardWs = new WebSocket(`${wsProtocol}//${location.host}/ws/dashboard`);

  dashboardWs.onopen = () => {
    // REST fallback: fetch current sessions in case we missed WS messages
    fetch('/api/sessions')
      .then((res) => res.json())
      .then((data) => {
        sessions = data;
        renderSidebar();
      })
      .catch(() => {});
  };

  dashboardWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case 'session_list':
          sessions = msg.sessions;
          renderSidebar();
          break;
        case 'session_added':
          sessions.push(msg.session);
          renderSidebar();
          break;
        case 'session_updated': {
          const idx = sessions.findIndex((s) => s.name === msg.session.name);
          if (idx !== -1) sessions[idx] = msg.session;
          renderSidebar();
          // Update header status if this is the active session
          if (activeSession === msg.session.name) {
            const headerStatus = document.getElementById('session-status');
            const isConn = msg.session.status === 'connected';
            headerStatus.textContent = isConn ? 'Connected' : 'Disconnected';
            headerStatus.style.color = isConn ? '#4caf50' : '#f44336';
          }
          break;
        }
        case 'session_removed':
          sessions = sessions.filter((s) => s.name !== msg.sessionName);
          renderSidebar();
          if (activeSession === msg.sessionName) {
            deactivateSession();
          }
          break;
      }
    } catch {
      // ignore parse errors
    }
  };

  dashboardWs.onclose = () => {
    setTimeout(connectDashboardWs, 3000);
  };

  dashboardWs.onerror = () => {
    // close handler will trigger reconnect
  };
}

// ---------------------------------------------------------------------------
// Sidebar rendering
// ---------------------------------------------------------------------------

function renderSidebar() {
  const list = document.getElementById('session-list');
  list.innerHTML = '';

  if (sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'no-sessions';
    empty.textContent = 'No active sessions';
    list.appendChild(empty);
    return;
  }

  for (const session of sessions) {
    const item = document.createElement('div');
    item.className = 'session-item';
    if (session.name === activeSession) {
      item.classList.add('active');
    }

    const nameRow = document.createElement('div');
    nameRow.className = 'session-name-row';

    const name = document.createElement('div');
    name.className = 'session-name';
    name.textContent = session.name;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'session-remove';
    removeBtn.textContent = '\u00d7';
    removeBtn.title = 'Remove session';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (dashboardWs && dashboardWs.readyState === WebSocket.OPEN) {
        dashboardWs.send(JSON.stringify({ type: 'remove_session', sessionName: session.name }));
      }
    });

    nameRow.appendChild(name);
    nameRow.appendChild(removeBtn);

    const detail = document.createElement('div');
    detail.className = 'session-host';
    detail.textContent = `${session.username}@${session.host}:${session.port}`;

    const status = document.createElement('div');
    const isConnected = session.status === 'connected';
    status.className = `session-status ${isConnected ? 'connected' : 'disconnected'}`;
    status.textContent = isConnected ? 'connected' : 'disconnected';

    item.appendChild(nameRow);
    item.appendChild(detail);
    item.appendChild(status);

    item.addEventListener('click', () => selectSession(session.name));

    list.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Session selection / deactivation
// ---------------------------------------------------------------------------

function selectSession(name) {
  if (name === activeSession) return;

  // Tear down previous session WS
  if (sessionWs) {
    sessionWs.onclose = null; // prevent status flicker
    sessionWs.close();
    sessionWs = null;
  }

  activeSession = name;

  const session = sessions.find((s) => s.name === name);
  const headerName = document.getElementById('active-session-name');
  const headerStatus = document.getElementById('session-status');

  headerName.textContent = name;
  headerStatus.textContent = 'Connecting...';
  headerStatus.style.color = '#ff9800';

  // Show terminal, hide placeholder
  document.getElementById('terminal-container').classList.add('visible');

  term.reset();
  fitAddon.fit();

  // Open per-session WS
  sessionWs = new WebSocket(
    `${wsProtocol}//${location.host}/ws/session/${encodeURIComponent(name)}`
  );

  sessionWs.onopen = () => {
    headerStatus.textContent = 'Connected';
    headerStatus.style.color = '#4caf50';
  };

  sessionWs.onclose = () => {
    headerStatus.textContent = 'Disconnected';
    headerStatus.style.color = '#f44336';
  };

  sessionWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'terminal_output' || msg.type === 'terminal_history') {
        term.write(msg.data);
      }
    } catch {
      // ignore parse errors
    }
  };

  renderSidebar();
}

function deactivateSession() {
  if (sessionWs) {
    sessionWs.onclose = null;
    sessionWs.close();
    sessionWs = null;
  }

  activeSession = null;

  // Hide terminal, show placeholder
  document.getElementById('terminal-container').classList.remove('visible');

  const headerName = document.getElementById('active-session-name');
  const headerStatus = document.getElementById('session-status');
  headerName.textContent = 'No session selected';
  headerStatus.textContent = '';
  headerStatus.style.color = '';

  renderSidebar();
}

// ---------------------------------------------------------------------------
// Autoscroll
// ---------------------------------------------------------------------------

function initAutoScroll() {
  const checkbox = document.getElementById('autoscroll');
  if (!checkbox) return;
  checkbox.checked = true;
  checkbox.addEventListener('change', () => {
    autoScroll = checkbox.checked;
  });
  term.onWriteParsed(() => {
    if (autoScroll) {
      term.scrollToBottom();
    }
  });
}

// ---------------------------------------------------------------------------
// Buffer size
// ---------------------------------------------------------------------------

function initBufferSize() {
  const select = document.getElementById('buffer-size');
  if (!select) return;
  select.addEventListener('change', () => {
    if (activeSession && dashboardWs && dashboardWs.readyState === WebSocket.OPEN) {
      dashboardWs.send(
        JSON.stringify({
          type: 'set_buffer_size',
          sessionName: activeSession,
          lines: parseInt(select.value, 10),
        })
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
  term = new Terminal({
    theme: { background: '#1a1a1a', foreground: '#f0f0f0', cursor: '#f0f0f0' },
    fontSize: 14,
    fontFamily: 'Monaco, Menlo, "Ubuntu Mono", Consolas, monospace',
    cursorBlink: false,
    disableStdin: true,
    convertEol: true,
    scrollback: 5000,
  });

  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('dashboard-terminal'));
  fitAddon.fit();

  initAutoScroll();
  initBufferSize();
  connectDashboardWs();

  window.addEventListener('resize', () => fitAddon.fit());
}

document.addEventListener('DOMContentLoaded', init);
