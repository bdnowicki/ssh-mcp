// Browser-side xterm.js terminal viewer (read-only)
// Expects window.SESSION_NAME to be set by the server template
const term = new Terminal({
  theme: { background: '#1a1a1a', foreground: '#f0f0f0', cursor: '#f0f0f0' },
  fontSize: 14,
  fontFamily: 'Monaco, Menlo, "Ubuntu Mono", Consolas, monospace',
  cursorBlink: false,
  disableStdin: true,
  convertEol: true,
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal'));
fitAddon.fit();

const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(
  `${wsProtocol}//${location.host}/ws/session/${encodeURIComponent(window.SESSION_NAME)}`
);
const statusEl = document.getElementById('connection-status');

ws.onopen = () => {
  statusEl.textContent = 'Connected';
  statusEl.style.color = '#4caf50';
};
ws.onclose = () => {
  statusEl.textContent = 'Disconnected';
  statusEl.style.color = '#f44336';
};
ws.onerror = () => {
  statusEl.textContent = 'Error';
  statusEl.style.color = '#f44336';
};
ws.onmessage = (event) => {
  try {
    const msg = JSON.parse(event.data);
    if (msg.type === 'terminal_output' || msg.type === 'terminal_history') {
      term.write(msg.data);
    }
  } catch {
    // ignore parse errors
  }
};

window.addEventListener('resize', () => fitAddon.fit());
