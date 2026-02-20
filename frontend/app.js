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

  const settingsBtn = document.getElementById('settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const settingsCloseBtn = document.getElementById('settings-close-btn');
  const filterCuCheckbox = document.getElementById('setting-filter-cu');

  const alwaysReconnectCheckbox = document.getElementById('setting-always-reconnect');
  const confirmModal = document.getElementById('confirm-modal');
  const confirmReconnectBtn = document.getElementById('confirm-reconnect');
  const confirmAlwaysBtn = document.getElementById('confirm-always');
  const confirmCancelBtn = document.getElementById('confirm-cancel');

  const serverEnabledCheckbox = document.getElementById('setting-server-enabled');
  const serverDetails = document.getElementById('server-details');
  const authTokenInput = document.getElementById('setting-auth-token');
  const copyTokenBtn = document.getElementById('copy-token-btn');
  const regenerateTokenBtn = document.getElementById('regenerate-token-btn');
  const serverClientsSpan = document.getElementById('server-clients');

  // State
  let term = null;
  let serverRefreshInterval = null;
  let ws = null;
  let attachAddon = null;
  let fitAddon = null;
  let connected = false;
  let settings = loadSettings();

  // Settings management
  function loadSettings() {
    try {
      var saved = JSON.parse(localStorage.getItem('serial-rs-settings'));
      return Object.assign({ filterCuOnly: true, alwaysReconnect: false }, saved);
    } catch (e) {
      return { filterCuOnly: true, alwaysReconnect: false };
    }
  }

  function saveSettings() {
    localStorage.setItem('serial-rs-settings', JSON.stringify(settings));
  }

  function applySettingsToUI() {
    filterCuCheckbox.checked = settings.filterCuOnly;
    alwaysReconnectCheckbox.checked = settings.alwaysReconnect;
  }

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

      var filtered = ports;
      if (settings.filterCuOnly) {
        filtered = ports.filter(function(p) {
          return !p.name.startsWith('/dev/tty.');
        });
      }

      filtered.forEach(function(p) {
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

  // Show reconnect confirm dialog; resolves to 'reconnect', 'always', or 'cancel'
  function showReconnectConfirm() {
    return new Promise(function(resolve) {
      confirmModal.classList.remove('hidden');

      function cleanup() {
        confirmModal.classList.add('hidden');
        confirmReconnectBtn.removeEventListener('click', onReconnect);
        confirmAlwaysBtn.removeEventListener('click', onAlways);
        confirmCancelBtn.removeEventListener('click', onCancel);
      }
      function onReconnect() { cleanup(); resolve('reconnect'); }
      function onAlways() { cleanup(); resolve('always'); }
      function onCancel() { cleanup(); resolve('cancel'); }

      confirmReconnectBtn.addEventListener('click', onReconnect);
      confirmAlwaysBtn.addEventListener('click', onAlways);
      confirmCancelBtn.addEventListener('click', onCancel);
    });
  }

  // Disconnect backend only (no WebSocket/UI cleanup, for silent reconnect)
  async function disconnectBackend() {
    try {
      await fetch(API_BASE + '/api/disconnect', { method: 'POST' });
    } catch (e) {
      console.error('Disconnect error:', e);
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
      var res = await fetch(API_BASE + '/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      var result = await res.json();

      if (res.status === 409) {
        if (settings.alwaysReconnect) {
          await disconnectBackend();
        } else {
          var choice = await showReconnectConfirm();
          if (choice === 'cancel') return;
          if (choice === 'always') {
            settings.alwaysReconnect = true;
            saveSettings();
          }
          await disconnectBackend();
        }
        // Retry connect after disconnect
        res = await fetch(API_BASE + '/api/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        });
        result = await res.json();
      }

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
    connected = false;

    if (attachAddon) {
      attachAddon.dispose();
      attachAddon = null;
    }
    if (ws) {
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      ws = null;
    }

    try {
      await fetch(API_BASE + '/api/disconnect', { method: 'POST' });
    } catch (e) {
      console.error('Disconnect error:', e);
    }

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
      statusbarPort.textContent = '— ' + portSelect.value + ' @ ' + baudSelect.value;
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
      statusbarPort.textContent = '';
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

  function openSettingsModal() {
    settingsModal.classList.remove('hidden');
    refreshServerStatus();
    serverRefreshInterval = setInterval(refreshServerStatus, 5000);
  }

  function closeSettingsModal() {
    settingsModal.classList.add('hidden');
    if (serverRefreshInterval) {
      clearInterval(serverRefreshInterval);
      serverRefreshInterval = null;
    }
  }

  settingsBtn.addEventListener('click', openSettingsModal);

  settingsCloseBtn.addEventListener('click', closeSettingsModal);

  settingsModal.addEventListener('click', function(e) {
    if (e.target === settingsModal) closeSettingsModal();
  });

  filterCuCheckbox.addEventListener('change', function() {
    settings.filterCuOnly = filterCuCheckbox.checked;
    saveSettings();
    refreshPorts();
  });

  alwaysReconnectCheckbox.addEventListener('change', function() {
    settings.alwaysReconnect = alwaysReconnectCheckbox.checked;
    saveSettings();
  });

  // Server management
  async function refreshServerStatus() {
    try {
      var res = await fetch(API_BASE + '/api/server/status');
      var data = await res.json();
      serverEnabledCheckbox.checked = data.enabled;
      authTokenInput.value = data.token;
      serverClientsSpan.textContent = 'Clients: ' + data.clients;
      serverDetails.classList.toggle('hidden', !data.enabled);
    } catch (e) {
      console.error('Failed to fetch server status:', e);
    }
  }

  serverEnabledCheckbox.addEventListener('change', async function() {
    try {
      await fetch(API_BASE + '/api/server/toggle', { method: 'POST' });
      await refreshServerStatus();
    } catch (e) {
      console.error('Failed to toggle server:', e);
    }
  });

  copyTokenBtn.addEventListener('click', function() {
    navigator.clipboard.writeText(authTokenInput.value).catch(function(e) {
      console.error('Failed to copy token:', e);
    });
  });

  regenerateTokenBtn.addEventListener('click', async function() {
    try {
      await fetch(API_BASE + '/api/server/regenerate-token', { method: 'POST' });
      await refreshServerStatus();
    } catch (e) {
      console.error('Failed to regenerate token:', e);
    }
  });

  // Handle window resize
  window.addEventListener('resize', function() {
    if (fitAddon) fitAddon.fit();
  });

  // Cmd+R to reload (Tauri WebView doesn't enable browser shortcuts by default)
  window.addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
      e.preventDefault();
      location.reload();
    }
  });

  // Initialize
  applySettingsToUI();
  initTerminal();
  refreshPorts();
  checkAndReconnect();
})();
