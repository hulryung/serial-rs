(function() {
  // Backend server URL (Axum serves API and WebSocket)
  const API_BASE = 'http://localhost:3000';
  const WS_BASE = 'ws://localhost:3000';

  // DOM elements
  const portSelect = document.getElementById('port-select');
  const baudSelect = document.getElementById('baud-select');
  const databitsSelect = document.getElementById('databits-select');
  const stopbitsSelect = document.getElementById('stopbits-select');
  const paritySelect = document.getElementById('parity-select');
  const connectBtn = document.getElementById('connect-btn');
  const refreshBtn = document.getElementById('refresh-btn');
  const statusIndicator = document.getElementById('status-indicator');
  const terminalContainer = document.getElementById('terminal-container');
  const statusbarPort = document.getElementById('statusbar-port');

  // State
  let term = null;
  let ws = null;
  let attachAddon = null;
  let fitAddon = null;
  let connected = false;

  // Initialize xterm.js terminal
  function initTerminal() {
    term = new Terminal({
      cursorBlink: true,
      theme: {
        background: '#1a1a2e',
        foreground: '#d4d4d4',
        cursor: '#e94560',
        selectionBackground: '#0f3460',
      },
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    });

    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalContainer);
    fitAddon.fit();

    term.writeln('Serial Terminal Ready.');
    term.writeln('Select a port and click Connect.');
  }

  // Fetch available ports
  async function refreshPorts() {
    try {
      const res = await fetch(API_BASE + '/api/ports');
      const ports = await res.json();

      // Clear existing options
      portSelect.innerHTML = '<option value="">Select Port...</option>';

      ports.forEach(function(p) {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name + ' (' + p.port_type + ')';
        portSelect.appendChild(opt);
      });
    } catch (e) {
      console.error('Failed to fetch ports:', e);
      term.writeln('\r\n[Error] Failed to fetch port list');
    }
  }

  // Open WebSocket and attach to terminal
  function openWebSocket(label) {
    ws = new WebSocket(WS_BASE + '/ws');
    ws.binaryType = 'arraybuffer';

    ws.onopen = function() {
      connected = true;
      updateUI();
      term.writeln('\r\n[Connected] ' + label);

      attachAddon = new AttachAddon.AttachAddon(ws);
      term.loadAddon(attachAddon);
    };

    ws.onclose = function() {
      if (connected) {
        connected = false;
        updateUI();
        term.writeln('\r\n[Disconnected]');
      }
    };

    ws.onerror = function(e) {
      console.error('WebSocket error:', e);
      term.writeln('\r\n[Error] WebSocket error');
    };
  }

  // Check backend status and reconnect if port is already open
  async function checkAndReconnect() {
    try {
      var res = await fetch(API_BASE + '/api/status');
      var status = await res.json();
      if (status.connected) {
        term.writeln('\r\n[Reconnecting] ' + status.port + '...');
        // Restore UI selections to match backend state
        if (status.config) {
          portSelect.value = status.config.port;
          baudSelect.value = status.config.baud_rate;
          databitsSelect.value = status.config.data_bits;
          stopbitsSelect.value = status.config.stop_bits;
          paritySelect.value = status.config.parity;
        }
        openWebSocket(status.port + ' @ ' + status.config.baud_rate);
      }
    } catch (e) {
      // Ignore - status check is best-effort
    }
  }

  // Connect to serial port
  async function connect() {
    const port = portSelect.value;
    if (!port) {
      term.writeln('\r\n[Error] Please select a port');
      return;
    }

    const config = {
      port: port,
      baud_rate: parseInt(baudSelect.value),
      data_bits: parseInt(databitsSelect.value),
      stop_bits: parseInt(stopbitsSelect.value),
      parity: paritySelect.value,
    };

    try {
      const res = await fetch(API_BASE + '/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const result = await res.json();

      if (!result.ok) {
        term.writeln('\r\n[Error] ' + result.message);
        return;
      }

      openWebSocket(port + ' @ ' + config.baud_rate);
    } catch (e) {
      console.error('Connect failed:', e);
      term.writeln('\r\n[Error] Connection failed: ' + e.message);
    }
  }

  // Disconnect
  async function disconnect() {
    if (ws) {
      ws.close();
      ws = null;
    }
    if (attachAddon) {
      attachAddon.dispose();
      attachAddon = null;
    }

    try {
      await fetch(API_BASE + '/api/disconnect', { method: 'POST' });
    } catch (e) {
      console.error('Disconnect error:', e);
    }

    connected = false;
    updateUI();
    term.writeln('\r\n[Disconnected]');
  }

  // Update UI state
  function updateUI() {
    if (connected) {
      connectBtn.textContent = 'Disconnect';
      connectBtn.classList.add('connected');
      statusIndicator.textContent = 'Connected';
      statusIndicator.className = 'connected';
      statusbarPort.textContent = portSelect.value + ' @ ' + baudSelect.value;
      portSelect.disabled = true;
      baudSelect.disabled = true;
      databitsSelect.disabled = true;
      stopbitsSelect.disabled = true;
      paritySelect.disabled = true;
    } else {
      connectBtn.textContent = 'Connect';
      connectBtn.classList.remove('connected');
      statusIndicator.textContent = 'Disconnected';
      statusIndicator.className = 'disconnected';
      statusbarPort.textContent = 'No connection';
      portSelect.disabled = false;
      baudSelect.disabled = false;
      databitsSelect.disabled = false;
      stopbitsSelect.disabled = false;
      paritySelect.disabled = false;
    }
  }

  // Event listeners
  connectBtn.addEventListener('click', function() {
    if (connected) {
      disconnect();
    } else {
      connect();
    }
  });

  refreshBtn.addEventListener('click', refreshPorts);

  // Handle window resize
  window.addEventListener('resize', function() {
    if (fitAddon) fitAddon.fit();
  });

  // Initialize
  initTerminal();
  refreshPorts();
  checkAndReconnect();
})();
