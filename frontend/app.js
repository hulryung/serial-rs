(function() {
  // Backend server URL (Axum serves API and WebSocket)
  const API_BASE = 'http://localhost:3000';
  const WS_BASE = 'ws://localhost:3000';

  // DOM elements - Serial
  const portSelect = document.getElementById('port-select');
  const baudSelect = document.getElementById('baud-select');
  const databitsSelect = document.getElementById('databits-select');
  const stopbitsSelect = document.getElementById('stopbits-select');
  const paritySelect = document.getElementById('parity-select');
  const refreshBtn = document.getElementById('refresh-btn');

  // DOM elements - SSH
  const sshHostInput = document.getElementById('ssh-host');
  const sshPortInput = document.getElementById('ssh-port');
  const sshUsernameInput = document.getElementById('ssh-username');
  const sshPasswordInput = document.getElementById('ssh-password');

  // DOM elements - Config wrappers
  const serialConfig = document.getElementById('serial-config');
  const sshConfig = document.getElementById('ssh-config');

  // DOM elements - Mode tabs
  const modeTabs = document.querySelectorAll('.mode-tab');

  // DOM elements - Shared
  const connectBtn = document.getElementById('connect-btn');
  const statusIndicator = document.getElementById('status-indicator');
  const terminalContainer = document.getElementById('terminal-container');
  const statusbarPort = document.getElementById('statusbar-port');

  const settingsBtn = document.getElementById('settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const settingsCloseBtn = document.getElementById('settings-close-btn');
  const filterCuCheckbox = document.getElementById('setting-filter-cu');
  const rememberSshCheckbox = document.getElementById('setting-remember-ssh');

  const alwaysReconnectCheckbox = document.getElementById('setting-always-reconnect');
  const confirmModal = document.getElementById('confirm-modal');
  const confirmReconnectBtn = document.getElementById('confirm-reconnect');
  const confirmAlwaysBtn = document.getElementById('confirm-always');
  const confirmCancelBtn = document.getElementById('confirm-cancel');


  // State
  var term = null;
  var ws = null;
  var fitAddon = null;
  var onDataDisposable = null;
  var connected = false;
  var currentMode = 'serial'; // 'serial' or 'ssh'
  var settings = loadSettings();

  // Settings management
  function loadSettings() {
    try {
      var saved = JSON.parse(localStorage.getItem('serial-rs-settings'));
      return Object.assign({ filterCuOnly: true, alwaysReconnect: false, rememberSsh: true }, saved);
    } catch (e) {
      return { filterCuOnly: true, alwaysReconnect: false, rememberSsh: true };
    }
  }

  function saveSettings() {
    localStorage.setItem('serial-rs-settings', JSON.stringify(settings));
  }

  function applySettingsToUI() {
    filterCuCheckbox.checked = settings.filterCuOnly;
    alwaysReconnectCheckbox.checked = settings.alwaysReconnect;
    rememberSshCheckbox.checked = settings.rememberSsh;
  }

  // SSH connection info persistence (password excluded)
  function loadSshInfo() {
    try {
      return JSON.parse(localStorage.getItem('serial-rs-ssh-info')) || {};
    } catch (e) {
      return {};
    }
  }

  function saveSshInfo() {
    if (!settings.rememberSsh) return;
    var info = {
      host: sshHostInput.value,
      port: parseInt(sshPortInput.value) || 22,
      username: sshUsernameInput.value
    };
    localStorage.setItem('serial-rs-ssh-info', JSON.stringify(info));
  }

  function applySshInfo() {
    var info = loadSshInfo();
    if (info.host) sshHostInput.value = info.host;
    if (info.port) sshPortInput.value = info.port;
    if (info.username) sshUsernameInput.value = info.username;
  }

  // Mode tab switching
  function switchMode(mode) {
    currentMode = mode;
    modeTabs.forEach(function(tab) {
      if (tab.getAttribute('data-mode') === mode) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    });

    if (mode === 'serial') {
      serialConfig.classList.remove('hidden');
      sshConfig.classList.add('hidden');
    } else {
      serialConfig.classList.add('hidden');
      sshConfig.classList.remove('hidden');
    }
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

    // Send resize events over WebSocket
    term.onResize(function(size) {
      if (ws && ws.readyState === WebSocket.OPEN && currentMode === 'ssh') {
        ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
      }
    });
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

  // ZMODEM inline progress in terminal
  var zmodemFileStart = 0;
  var zmodemFileCount = 0;

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  function handleZmodemNotification(str) {
    var match = str.match(/\x1b\]zmodem;(.*?)\x07/);
    if (!match) return;

    try {
      var msg = JSON.parse(match[1]);
      if (msg.state === 'started') {
        zmodemFileCount = 0;
        zmodemFileStart = Date.now();
        term.write('\r\n');
      } else if (msg.state === 'progress') {
        var filename = msg.filename || '';
        var received = msg.received || 0;
        var total = msg.total || 0;
        var elapsed = (Date.now() - zmodemFileStart) / 1000;
        var speed = elapsed > 0 ? received / elapsed : 0;
        var pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;

        var line = '\r\x1b[K' + filename + '  ' +
          pct + '%  ' +
          formatBytes(received) + '/' + formatBytes(total) +
          '  ' + formatBytes(speed) + '/s';
        term.write(line);
      } else if (msg.state === 'file_complete') {
        var fname = msg.filename || '';
        var size = msg.size || 0;
        var ms = msg.elapsedMs || 0;
        var sec = ms / 1000;
        var fspeed = sec > 0 ? size / sec : 0;

        term.write('\r\x1b[K');
        term.writeln(fname + '  ' + formatBytes(size) + '  ' + sec.toFixed(1) + 's  ' + formatBytes(fspeed) + '/s');
        zmodemFileCount++;
        zmodemFileStart = Date.now();
      } else if (msg.state === 'completed') {
        var totalBytes = msg.totalBytes || 0;
        var elapsedMs = msg.elapsedMs || 0;
        var elapsedSec = elapsedMs / 1000;
        var cspeed = elapsedSec > 0 ? totalBytes / elapsedSec : 0;

        // Show total summary when multiple files
        if (zmodemFileCount > 1) {
          term.writeln('Total: ' + zmodemFileCount + ' files  ' +
            formatBytes(totalBytes) + '  ' +
            elapsedSec.toFixed(1) + 's  ' +
            formatBytes(cspeed) + '/s');
        }
      } else if (msg.state === 'error') {
        term.writeln('\r\n[ZMODEM Error] ' + (msg.message || 'Unknown error'));
      }
    } catch (e) {
      console.error('Failed to parse ZMODEM notification:', e);
    }
  }

  // Open WebSocket and manually handle messages (replaces AttachAddon for ZMODEM support)
  function openWebSocket(label) {
    ws = new WebSocket(WS_BASE + '/ws');
    ws.binaryType = 'arraybuffer';

    ws.onopen = function() {
      connected = true;
      updateUI();
      term.writeln('\r\n[Connected] ' + label);

      // Manual message handler instead of AttachAddon (intercepts ZMODEM notifications)
      ws.onmessage = function(event) {
        if (typeof event.data === 'string') {
          // Text frame — check for ZMODEM notification
          if (event.data.indexOf('\x1b]zmodem;') !== -1) {
            handleZmodemNotification(event.data);
            return;
          }
          // Other text frames — write to terminal
          term.write(event.data);
        } else if (event.data instanceof ArrayBuffer) {
          var bytes = new Uint8Array(event.data);
          // Normal terminal data
          term.write(bytes);
        }
      };

      // Send terminal input to WebSocket
      onDataDisposable = term.onData(function(data) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(new TextEncoder().encode(data));
        }
      });

      // Send initial size for SSH
      if (currentMode === 'ssh') {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
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
        if (status.connection_type === 'ssh') {
          currentMode = 'ssh';
          switchMode('ssh');
          var sshLabel = 'SSH ' + (status.ssh_config ? status.ssh_config.username + '@' + status.ssh_config.host + ':' + status.ssh_config.port : '');
          term.writeln('\r\n[Reconnecting] ' + sshLabel + '...');
          if (status.ssh_config) {
            sshHostInput.value = status.ssh_config.host;
            sshPortInput.value = status.ssh_config.port;
            sshUsernameInput.value = status.ssh_config.username;
          }
          openWebSocket(sshLabel);
        } else {
          currentMode = 'serial';
          switchMode('serial');
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

  // Handle 409 conflict (already connected)
  async function handleConflict() {
    if (settings.alwaysReconnect) {
      await disconnectBackend();
    } else {
      var choice = await showReconnectConfirm();
      if (choice === 'cancel') return false;
      if (choice === 'always') {
        settings.alwaysReconnect = true;
        saveSettings();
      }
      await disconnectBackend();
    }
    return true;
  }

  // Connect to serial port
  async function connectSerial() {
    var port = portSelect.value;
    if (!port) {
      term.writeln('\r\n[Error] Please select a port');
      return;
    }

    var config = {
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
        var ok = await handleConflict();
        if (!ok) return;
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

  // Connect via SSH
  async function connectSsh() {
    var host = sshHostInput.value.trim();
    var port = parseInt(sshPortInput.value) || 22;
    var username = sshUsernameInput.value.trim();
    var password = sshPasswordInput.value;

    if (!host) {
      term.writeln('\r\n[Error] Please enter a host');
      return;
    }
    if (!username) {
      term.writeln('\r\n[Error] Please enter a username');
      return;
    }

    var sshConfig = {
      host: host,
      port: port,
      username: username,
      password: password
    };

    try {
      var res = await fetch(API_BASE + '/api/ssh/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sshConfig),
      });
      var result = await res.json();

      if (res.status === 409) {
        var ok = await handleConflict();
        if (!ok) return;
        // Retry connect after disconnect
        res = await fetch(API_BASE + '/api/ssh/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sshConfig),
        });
        result = await res.json();
      }

      if (!result.ok) {
        term.writeln('\r\n[Error] ' + result.message);
        return;
      }

      // Save SSH info (password excluded)
      saveSshInfo();

      var label = 'SSH ' + username + '@' + host + ':' + port;
      openWebSocket(label);
    } catch (e) {
      console.error('SSH connect failed:', e);
      term.writeln('\r\n[Error] SSH connection failed: ' + e.message);
    }
  }

  // Connect dispatcher
  function connect() {
    if (currentMode === 'serial') {
      connectSerial();
    } else {
      connectSsh();
    }
  }

  // Disconnect
  async function disconnect() {
    connected = false;

    if (onDataDisposable) {
      onDataDisposable.dispose();
      onDataDisposable = null;
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

      if (currentMode === 'serial') {
        statusbarPort.textContent = '— ' + portSelect.value + ' @ ' + baudSelect.value;
        portSelect.disabled = true;
        baudSelect.disabled = true;
        databitsSelect.disabled = true;
        stopbitsSelect.disabled = true;
        paritySelect.disabled = true;
      } else {
        statusbarPort.textContent = '— SSH ' + sshUsernameInput.value + '@' + sshHostInput.value + ':' + sshPortInput.value;
        sshHostInput.disabled = true;
        sshPortInput.disabled = true;
        sshUsernameInput.disabled = true;
        sshPasswordInput.disabled = true;
      }

      // Disable mode tabs while connected
      modeTabs.forEach(function(tab) { tab.disabled = true; });
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
      sshHostInput.disabled = false;
      sshPortInput.disabled = false;
      sshUsernameInput.disabled = false;
      sshPasswordInput.disabled = false;

      // Re-enable mode tabs
      modeTabs.forEach(function(tab) { tab.disabled = false; });
    }
  }

  // Event listeners - Mode tabs
  modeTabs.forEach(function(tab) {
    tab.addEventListener('click', function() {
      if (connected) return;
      switchMode(tab.getAttribute('data-mode'));
    });
  });

  // Event listeners
  connectBtn.addEventListener('click', function() {
    if (connected) {
      disconnect();
    } else {
      connect();
    }
  });

  refreshBtn.addEventListener('click', refreshPorts);

  // Enter key on SSH inputs triggers connect
  [sshHostInput, sshPortInput, sshUsernameInput, sshPasswordInput].forEach(function(el) {
    el.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !connected) connect();
    });
  });

  settingsBtn.addEventListener('click', function() {
    settingsModal.classList.remove('hidden');
  });

  settingsCloseBtn.addEventListener('click', function() {
    settingsModal.classList.add('hidden');
  });

  settingsModal.addEventListener('click', function(e) {
    if (e.target === settingsModal) settingsModal.classList.add('hidden');
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

  rememberSshCheckbox.addEventListener('change', function() {
    settings.rememberSsh = rememberSshCheckbox.checked;
    saveSettings();
    if (!settings.rememberSsh) {
      localStorage.removeItem('serial-rs-ssh-info');
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
  applySshInfo();
  initTerminal();
  refreshPorts();
  checkAndReconnect();
})();
