(function() {
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
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
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
      const res = await fetch('/api/ports');
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
      const res = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const result = await res.json();

      if (!result.ok) {
        term.writeln('\r\n[Error] ' + result.message);
        return;
      }

      // Open WebSocket
      const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(wsProtocol + '//' + location.host + '/ws');
      ws.binaryType = 'arraybuffer';

      ws.onopen = function() {
        connected = true;
        updateUI();
        term.writeln('\r\n[Connected] ' + port + ' @ ' + config.baud_rate);

        // Attach WebSocket to terminal
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
      await fetch('/api/disconnect', { method: 'POST' });
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
      // Disable config selects while connected
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
})();
