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

  const sessionsBtn = document.getElementById('sessions-btn');
  const sessionSidebar = document.getElementById('session-sidebar');
  const sessionList = document.getElementById('session-list');
  const sessionAddBtn = document.getElementById('session-add-btn');

  const settingsBtn = document.getElementById('settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const settingsTitle = document.getElementById('settings-title');
  const settingsCloseBtn = document.getElementById('settings-close-btn');
  const settingsSaveBtn = document.getElementById('settings-save-btn');
  const settingsTabs = document.querySelectorAll('.settings-tab');
  const filterCuCheckbox = document.getElementById('setting-filter-cu');
  const rememberSshCheckbox = document.getElementById('setting-remember-ssh');
  const alwaysReconnectCheckbox = document.getElementById('setting-always-reconnect');

  const confirmModal = document.getElementById('confirm-modal');
  const confirmReconnectBtn = document.getElementById('confirm-reconnect');
  const confirmAlwaysBtn = document.getElementById('confirm-always');
  const confirmCancelBtn = document.getElementById('confirm-cancel');

  const newSessionModal = document.getElementById('new-session-modal');
  const newSessionCloseBtn = document.getElementById('new-session-close-btn');
  const newSessionCreateBtn = document.getElementById('new-session-create-btn');
  const newSessionTypeTabs = document.querySelectorAll('.new-session-type-tab');
  const newSessionSerialFields = document.getElementById('new-session-serial-fields');
  const newSessionSshFields = document.getElementById('new-session-ssh-fields');
  var newSessionTypeValue = 'serial';

  // DOM elements - Search bar
  var searchBar = document.getElementById('search-bar');
  var searchInput = document.getElementById('search-input');
  var searchCount = document.getElementById('search-count');
  var searchPrevBtn = document.getElementById('search-prev');
  var searchNextBtn = document.getElementById('search-next');
  var searchCloseBtn = document.getElementById('search-close');

  // State
  var term = null;
  var ws = null;
  var fitAddon = null;
  var searchAddon = null;
  var onDataDisposable = null;
  var connected = false;
  var currentMode = 'serial';
  var activeSessionId = null;
  var settingsContext = null; // { mode: 'defaults' } or { mode: 'session', sessionId: '...' }

  // -----------------------------------------------------------------------
  // Defaults & Sessions data layer
  // -----------------------------------------------------------------------

  var DEFAULT_SETTINGS = {
    fontSize: 14,
    fontFamily: '"SF Mono", Menlo, Monaco, "Cascadia Code", monospace',
    themeBackground: '#0c0e14',
    themeForeground: '#e2e4ea',
    themeCursor: '#6382ff',
    themeSelection: 'rgba(99, 130, 255, 0.2)',
    filterCuOnly: true,
    alwaysReconnect: false,
    rememberSsh: true,
    sidebarOpen: false
  };

  var defaults = loadDefaults();
  var sessions = loadSessions();

  function loadDefaults() {
    try {
      var saved = JSON.parse(localStorage.getItem('serial-rs-defaults'));
      if (saved) return Object.assign({}, DEFAULT_SETTINGS, saved);
    } catch (e) {}
    // Migrate from old settings format
    try {
      var old = JSON.parse(localStorage.getItem('serial-rs-settings'));
      if (old) {
        var d = Object.assign({}, DEFAULT_SETTINGS);
        if (old.filterCuOnly !== undefined) d.filterCuOnly = old.filterCuOnly;
        if (old.alwaysReconnect !== undefined) d.alwaysReconnect = old.alwaysReconnect;
        if (old.rememberSsh !== undefined) d.rememberSsh = old.rememberSsh;
        localStorage.setItem('serial-rs-defaults', JSON.stringify(d));
        return d;
      }
    } catch (e) {}
    return Object.assign({}, DEFAULT_SETTINGS);
  }

  function saveDefaults() {
    localStorage.setItem('serial-rs-defaults', JSON.stringify(defaults));
  }

  function loadSessions() {
    try {
      var saved = JSON.parse(localStorage.getItem('serial-rs-sessions'));
      if (Array.isArray(saved)) return saved;
    } catch (e) {}
    return [];
  }

  function saveSessions() {
    localStorage.setItem('serial-rs-sessions', JSON.stringify(sessions));
  }

  // Resolve a session's effective settings (null visual fields → defaults)
  function resolveSession(session) {
    var r = {};
    // Visual fields: inherit from defaults if null
    var visualFields = ['fontSize', 'fontFamily', 'themeBackground', 'themeForeground',
                        'themeCursor', 'themeSelection'];
    visualFields.forEach(function(f) {
      r[f] = (session[f] !== null && session[f] !== undefined) ? session[f] : defaults[f];
    });
    // Connection fields: per-session only, no inheritance
    r.host = session.host || '';
    r.port = session.port || '';
    r.username = session.username || '';
    r.baudRate = session.baudRate || 115200;
    r.dataBits = session.dataBits || 8;
    r.stopBits = session.stopBits || 1;
    r.parity = session.parity || 'none';
    r.sshPort = session.sshPort || 22;
    return r;
  }

  function findSession(id) {
    return sessions.find(function(s) { return s.id === id; });
  }

  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  }

  // -----------------------------------------------------------------------
  // SSH connection info persistence (for non-session quick connect)
  // -----------------------------------------------------------------------

  function loadSshInfo() {
    try { return JSON.parse(localStorage.getItem('serial-rs-ssh-info')) || {}; } catch (e) { return {}; }
  }

  function saveSshInfo(includePassword) {
    if (!defaults.rememberSsh) return;
    var data = {
      host: sshHostInput.value,
      port: parseInt(sshPortInput.value) || 22,
      username: sshUsernameInput.value
    };
    if (includePassword) data.password = sshPasswordInput.value;
    localStorage.setItem('serial-rs-ssh-info', JSON.stringify(data));
  }

  function applySshInfo() {
    var info = loadSshInfo();
    if (info.host) sshHostInput.value = info.host;
    if (info.port) sshPortInput.value = info.port;
    if (info.username) sshUsernameInput.value = info.username;
    if (info.password) sshPasswordInput.value = info.password;
  }

  function showSavePasswordPrompt() {
    return new Promise(function(resolve) {
      var modal = document.getElementById('save-password-modal');
      var yesBtn = document.getElementById('save-password-yes');
      var noBtn = document.getElementById('save-password-no');
      modal.classList.remove('hidden');
      function cleanup() {
        modal.classList.add('hidden');
        yesBtn.removeEventListener('click', onYes);
        noBtn.removeEventListener('click', onNo);
      }
      function onYes() { cleanup(); resolve(true); }
      function onNo() { cleanup(); resolve(false); }
      yesBtn.addEventListener('click', onYes);
      noBtn.addEventListener('click', onNo);
    });
  }

  // -----------------------------------------------------------------------
  // Mode tab switching
  // -----------------------------------------------------------------------

  function switchMode(mode) {
    currentMode = mode;
    modeTabs.forEach(function(tab) {
      tab.classList.toggle('active', tab.getAttribute('data-mode') === mode);
    });
    serialConfig.classList.toggle('hidden', mode !== 'serial');
    sshConfig.classList.toggle('hidden', mode !== 'ssh');
  }

  // -----------------------------------------------------------------------
  // Terminal
  // -----------------------------------------------------------------------

  function initTerminal(ts) {
    ts = ts || defaults;
    term = new Terminal({
      cursorBlink: true,
      theme: {
        background: ts.themeBackground,
        foreground: ts.themeForeground,
        cursor: ts.themeCursor,
        selectionBackground: ts.themeSelection,
      },
      fontSize: ts.fontSize,
      fontFamily: ts.fontFamily,
    });

    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    searchAddon = new SearchAddon.SearchAddon();
    term.loadAddon(searchAddon);

    term.open(terminalContainer);
    fitAddon.fit();

    term.writeln('Serial Terminal Ready.');
    term.writeln('Select a port and click Connect.');

    term.onResize(function(size) {
      if (ws && ws.readyState === WebSocket.OPEN && currentMode === 'ssh') {
        ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
      }
    });
  }

  function applyTerminalSettings(ts) {
    if (!term) return;
    term.options.fontSize = ts.fontSize;
    term.options.fontFamily = ts.fontFamily;
    term.options.theme = {
      background: ts.themeBackground,
      foreground: ts.themeForeground,
      cursor: ts.themeCursor,
      selectionBackground: ts.themeSelection,
    };
    if (fitAddon) fitAddon.fit();
  }

  // -----------------------------------------------------------------------
  // Port list
  // -----------------------------------------------------------------------

  async function refreshPorts() {
    try {
      const res = await fetch(API_BASE + '/api/ports');
      const ports = await res.json();
      portSelect.innerHTML = '<option value="">Select Port...</option>';
      var filtered = ports;
      if (defaults.filterCuOnly) {
        filtered = ports.filter(function(p) { return !p.name.startsWith('/dev/tty.'); });
      }
      filtered.forEach(function(p) {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name + ' (' + p.port_type + ')';
        portSelect.appendChild(opt);
      });
    } catch (e) {
      console.error('Failed to fetch ports:', e);
      if (term) term.writeln('\r\n[Error] Failed to fetch port list');
    }
  }

  // -----------------------------------------------------------------------
  // ZMODEM inline progress
  // -----------------------------------------------------------------------

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
        var elapsed = (Date.now() - zmodemFileStart) / 1000;
        var speed = elapsed > 0 ? (msg.received || 0) / elapsed : 0;
        var pct = msg.total > 0 ? Math.min(100, Math.round(((msg.received || 0) / msg.total) * 100)) : 0;
        term.write('\r\x1b[K' + (msg.filename || '') + '  ' + pct + '%  ' +
          formatBytes(msg.received || 0) + '/' + formatBytes(msg.total || 0) +
          '  ' + formatBytes(speed) + '/s');
      } else if (msg.state === 'file_complete') {
        var sec = (msg.elapsedMs || 0) / 1000;
        var fspeed = sec > 0 ? (msg.size || 0) / sec : 0;
        term.write('\r\x1b[K');
        term.writeln((msg.filename || '') + '  ' + formatBytes(msg.size || 0) + '  ' + sec.toFixed(1) + 's  ' + formatBytes(fspeed) + '/s');
        zmodemFileCount++;
        zmodemFileStart = Date.now();
      } else if (msg.state === 'completed') {
        var elapsedSec = (msg.elapsedMs || 0) / 1000;
        var cspeed = elapsedSec > 0 ? (msg.totalBytes || 0) / elapsedSec : 0;
        if (zmodemFileCount > 1) {
          term.writeln('Total: ' + zmodemFileCount + ' files  ' +
            formatBytes(msg.totalBytes || 0) + '  ' + elapsedSec.toFixed(1) + 's  ' + formatBytes(cspeed) + '/s');
        }
      } else if (msg.state === 'error') {
        term.writeln('\r\n[ZMODEM Error] ' + (msg.message || 'Unknown error'));
      }
    } catch (e) {
      console.error('Failed to parse ZMODEM notification:', e);
    }
  }

  // -----------------------------------------------------------------------
  // WebSocket
  // -----------------------------------------------------------------------

  function openWebSocket(label) {
    ws = new WebSocket(WS_BASE + '/ws');
    ws.binaryType = 'arraybuffer';

    ws.onopen = function() {
      connected = true;
      updateUI();
      term.writeln('\r\n[Connected] ' + label);

      ws.onmessage = function(event) {
        if (typeof event.data === 'string') {
          if (event.data.indexOf('\x1b]zmodem;') !== -1) {
            handleZmodemNotification(event.data);
            return;
          }
          term.write(event.data);
        } else if (event.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(event.data));
        }
      };

      onDataDisposable = term.onData(function(data) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(new TextEncoder().encode(data));
        }
      });

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

  // -----------------------------------------------------------------------
  // Connection
  // -----------------------------------------------------------------------

  async function checkAndReconnect() {
    try {
      var res = await fetch(API_BASE + '/api/status');
      var status = await res.json();
      if (status.connected) {
        if (status.connection_type === 'ssh') {
          currentMode = 'ssh';
          switchMode('ssh');
          var sc = status.ssh_config;
          var sshLabel = 'SSH ' + (sc ? sc.username + '@' + sc.host + ':' + sc.port : '');
          term.writeln('\r\n[Reconnecting] ' + sshLabel + '...');
          if (sc) {
            sshHostInput.value = sc.host;
            sshPortInput.value = sc.port;
            sshUsernameInput.value = sc.username;
          }
          openWebSocket(sshLabel);
        } else {
          currentMode = 'serial';
          switchMode('serial');
          term.writeln('\r\n[Reconnecting] ' + status.port + '...');
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
    } catch (e) {}
  }

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

  async function disconnectBackend() {
    try { await fetch(API_BASE + '/api/disconnect', { method: 'POST' }); } catch (e) {}
  }

  async function handleConflict() {
    if (defaults.alwaysReconnect) {
      await disconnectBackend();
    } else {
      var choice = await showReconnectConfirm();
      if (choice === 'cancel') return false;
      if (choice === 'always') {
        defaults.alwaysReconnect = true;
        saveDefaults();
      }
      await disconnectBackend();
    }
    return true;
  }

  async function connectSerial() {
    var port = portSelect.value;
    if (!port) { term.writeln('\r\n[Error] Please select a port'); return; }

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
        if (!(await handleConflict())) return;
        res = await fetch(API_BASE + '/api/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        });
        result = await res.json();
      }

      if (!result.ok) { term.writeln('\r\n[Error] ' + result.message); return; }
      openWebSocket(port + ' @ ' + config.baud_rate);
    } catch (e) {
      term.writeln('\r\n[Error] Connection failed: ' + e.message);
    }
  }

  async function connectSsh() {
    var host = sshHostInput.value.trim();
    var port = parseInt(sshPortInput.value) || 22;
    var username = sshUsernameInput.value.trim();
    var password = sshPasswordInput.value;

    if (!host) { term.writeln('\r\n[Error] Please enter a host'); return; }
    if (!username) { term.writeln('\r\n[Error] Please enter a username'); return; }

    var sshConfig = { host: host, port: port, username: username, password: password };

    try {
      var res = await fetch(API_BASE + '/api/ssh/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sshConfig),
      });
      var result = await res.json();

      if (res.status === 409) {
        if (!(await handleConflict())) return;
        res = await fetch(API_BASE + '/api/ssh/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sshConfig),
        });
        result = await res.json();
      }

      if (!result.ok) { term.writeln('\r\n[Error] ' + result.message); return; }
      openWebSocket('SSH ' + username + '@' + host + ':' + port);

      // Ask to save password if not already saved
      if (password) {
        var alreadySaved = false;
        if (activeSessionId) {
          var sess = findSession(activeSessionId);
          if (sess && sess.password) alreadySaved = true;
        } else {
          var info = loadSshInfo();
          if (info.password) alreadySaved = true;
        }
        if (!alreadySaved) {
          var save = await showSavePasswordPrompt();
          if (save) {
            if (activeSessionId) {
              var sess = findSession(activeSessionId);
              if (sess) {
                sess.password = password;
                sess.updatedAt = Date.now();
                saveSessions();
              }
            } else {
              saveSshInfo(true);
            }
          } else {
            saveSshInfo(false);
          }
        } else {
          saveSshInfo(activeSessionId ? false : true);
        }
      } else {
        saveSshInfo(false);
      }
    } catch (e) {
      term.writeln('\r\n[Error] SSH connection failed: ' + e.message);
    }
  }

  function connect() {
    if (currentMode === 'serial') connectSerial();
    else connectSsh();
  }

  async function disconnect() {
    connected = false;
    if (onDataDisposable) { onDataDisposable.dispose(); onDataDisposable = null; }
    if (ws) { ws.onopen = null; ws.onclose = null; ws.onerror = null; ws.close(); ws = null; }
    try { await fetch(API_BASE + '/api/disconnect', { method: 'POST' }); } catch (e) {}
    updateUI();
    term.writeln('\r\n[Disconnected]');
  }

  // -----------------------------------------------------------------------
  // Connect from session
  // -----------------------------------------------------------------------

  function connectFromSession(sessionId) {
    var session = findSession(sessionId);
    if (!session) return;

    closeSidebar();
    activeSessionId = sessionId;
    var r = resolveSession(session);

    // Apply terminal theme
    applyTerminalSettings(r);

    // Switch mode and populate toolbar
    switchMode(session.type);
    if (session.type === 'serial') {
      portSelect.value = session.port || '';
      baudSelect.value = r.baudRate;
      databitsSelect.value = r.dataBits;
      stopbitsSelect.value = r.stopBits;
      paritySelect.value = r.parity;
    } else {
      sshHostInput.value = r.host;
      sshPortInput.value = r.sshPort;
      sshUsernameInput.value = r.username;
      sshPasswordInput.value = session.password || '';
    }

    renderSessionList();

    // If already connected, disconnect first
    if (connected) {
      disconnect().then(function() { connect(); });
    } else {
      connect();
    }
  }

  // -----------------------------------------------------------------------
  // Session sidebar
  // -----------------------------------------------------------------------

  function toggleSidebar() {
    var open = sessionSidebar.classList.toggle('open');
    defaults.sidebarOpen = open;
    saveDefaults();
  }

  function closeSidebar() {
    if (sessionSidebar.classList.contains('open')) {
      sessionSidebar.classList.remove('open');
      defaults.sidebarOpen = false;
      saveDefaults();
    }
  }

  function renderSessionList() {
    sessionList.innerHTML = '';
    if (sessions.length === 0) {
      sessionList.innerHTML = '<div class="session-empty">No saved sessions.<br>Click + to create one.</div>';
      return;
    }
    sessions.forEach(function(s) {
      var div = document.createElement('div');
      div.className = 'session-item' + (s.id === activeSessionId ? ' active' : '');

      var icon = document.createElement('span');
      icon.className = 'session-icon';
      icon.textContent = s.type === 'ssh' ? 'SSH' : 'COM';

      var info = document.createElement('div');
      info.className = 'session-info';
      var name = document.createElement('div');
      name.className = 'session-name';
      name.textContent = s.name;
      var detail = document.createElement('div');
      detail.className = 'session-detail';
      detail.textContent = s.type === 'ssh'
        ? (s.username ? s.username + '@' : '') + (s.host || '')
        : (s.port || 'No port');
      info.appendChild(name);
      info.appendChild(detail);

      var actions = document.createElement('div');
      actions.className = 'session-actions';

      var editBtn = document.createElement('button');
      editBtn.textContent = '\u270E';
      editBtn.title = 'Edit';
      editBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        openSessionSettings(s.id);
      });

      var delBtn = document.createElement('button');
      delBtn.textContent = '\u2715';
      delBtn.title = 'Delete';
      delBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        sessions = sessions.filter(function(x) { return x.id !== s.id; });
        saveSessions();
        if (activeSessionId === s.id) activeSessionId = null;
        renderSessionList();
      });

      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      div.appendChild(icon);
      div.appendChild(info);
      div.appendChild(actions);

      div.addEventListener('dblclick', function() {
        connectFromSession(s.id);
      });

      div.addEventListener('click', function() {
        activeSessionId = s.id;
        renderSessionList();
      });

      sessionList.appendChild(div);
    });
  }

  // -----------------------------------------------------------------------
  // Settings modal
  // -----------------------------------------------------------------------

  // Field mapping for UI/visual defaults only (not connection params)
  var FIELD_MAP = {
    'setting-font-size': { key: 'fontSize', type: 'number' },
    'setting-font-family': { key: 'fontFamily', type: 'text' },
    'setting-bg-color': { key: 'themeBackground', type: 'color' },
    'setting-fg-color': { key: 'themeForeground', type: 'color' },
    'setting-cursor-color': { key: 'themeCursor', type: 'color' },
    'setting-sel-color': { key: 'themeSelection', type: 'color' },
  };

  function switchSettingsTab(tabName) {
    settingsTabs.forEach(function(t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === tabName);
    });
    document.querySelectorAll('.settings-tab-content').forEach(function(c) {
      c.classList.toggle('hidden', c.id !== 'settings-tab-' + tabName);
    });
  }

  function openDefaultSettings() {
    settingsContext = { mode: 'defaults' };
    settingsTitle.textContent = 'Default Settings';

    // Hide "Use default" checkboxes
    document.querySelectorAll('.session-only').forEach(function(el) {
      el.classList.add('hidden');
    });

    // Populate fields from defaults
    Object.keys(FIELD_MAP).forEach(function(elId) {
      var fm = FIELD_MAP[elId];
      var el = document.getElementById(elId);
      if (!el) return;
      el.value = defaults[fm.key];
      el.disabled = false;
    });

    filterCuCheckbox.checked = defaults.filterCuOnly;
    alwaysReconnectCheckbox.checked = defaults.alwaysReconnect;
    rememberSshCheckbox.checked = defaults.rememberSsh;

    switchSettingsTab('general');
    settingsModal.classList.remove('hidden');
  }

  async function refreshSettingPorts(selectedPort) {
    var sel = document.getElementById('setting-port');
    try {
      var res = await fetch(API_BASE + '/api/ports');
      var ports = await res.json();
      sel.innerHTML = '<option value="">Select Port...</option>';
      var filtered = ports;
      if (defaults.filterCuOnly) {
        filtered = ports.filter(function(p) { return !p.name.startsWith('/dev/tty.'); });
      }
      filtered.forEach(function(p) {
        var opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name + ' (' + p.port_type + ')';
        sel.appendChild(opt);
      });
      if (selectedPort) sel.value = selectedPort;
    } catch (e) {}
  }

  function openSessionSettings(sessionId) {
    var session = findSession(sessionId);
    if (!session) return;

    settingsContext = { mode: 'session', sessionId: sessionId };
    settingsTitle.textContent = 'Session: ' + session.name;

    // Show "Use default" checkboxes and Connection tab
    document.querySelectorAll('.session-only').forEach(function(el) {
      el.classList.remove('hidden');
    });

    // Populate visual/UI fields with "use default" support
    Object.keys(FIELD_MAP).forEach(function(elId) {
      var fm = FIELD_MAP[elId];
      var el = document.getElementById(elId);
      if (!el) return;
      var isDefault = (session[fm.key] === null || session[fm.key] === undefined);
      var cb = document.querySelector('.use-default-cb[data-field="' + fm.key + '"]');
      if (cb) {
        cb.checked = isDefault;
      }
      el.value = isDefault ? defaults[fm.key] : session[fm.key];
      el.disabled = isDefault;
    });

    // Populate connection fields based on session type
    var connSerial = document.getElementById('settings-conn-serial');
    var connSsh = document.getElementById('settings-conn-ssh');
    if (session.type === 'serial') {
      connSerial.classList.remove('hidden');
      connSsh.classList.add('hidden');
      refreshSettingPorts(session.port || '');
      document.getElementById('setting-baud').value = session.baudRate || 115200;
      document.getElementById('setting-databits').value = session.dataBits || 8;
      document.getElementById('setting-stopbits').value = session.stopBits || 1;
      document.getElementById('setting-parity').value = session.parity || 'none';
    } else {
      connSerial.classList.add('hidden');
      connSsh.classList.remove('hidden');
      document.getElementById('setting-ssh-host').value = session.host || '';
      document.getElementById('setting-ssh-port').value = session.sshPort || 22;
      document.getElementById('setting-ssh-username').value = session.username || '';
    }

    // General tab behavior checkboxes
    filterCuCheckbox.checked = defaults.filterCuOnly;
    alwaysReconnectCheckbox.checked = defaults.alwaysReconnect;
    rememberSshCheckbox.checked = defaults.rememberSsh;

    switchSettingsTab('connection');
    settingsModal.classList.remove('hidden');
  }

  function saveSettingsModal() {
    if (!settingsContext) return;

    // Read general tab
    defaults.filterCuOnly = filterCuCheckbox.checked;
    defaults.alwaysReconnect = alwaysReconnectCheckbox.checked;
    defaults.rememberSsh = rememberSshCheckbox.checked;

    if (settingsContext.mode === 'defaults') {
      // Save all fields to defaults
      Object.keys(FIELD_MAP).forEach(function(elId) {
        var fm = FIELD_MAP[elId];
        var el = document.getElementById(elId);
        if (!el) return;
        if (fm.type === 'number') {
          defaults[fm.key] = parseInt(el.value) || defaults[fm.key];
        } else {
          defaults[fm.key] = el.value;
        }
      });
      saveDefaults();
      // Apply terminal settings live
      applyTerminalSettings(defaults);
    } else if (settingsContext.mode === 'session') {
      var session = findSession(settingsContext.sessionId);
      if (!session) return;

      // Save visual/UI fields (with "use default" support)
      Object.keys(FIELD_MAP).forEach(function(elId) {
        var fm = FIELD_MAP[elId];
        var el = document.getElementById(elId);
        var cb = document.querySelector('.use-default-cb[data-field="' + fm.key + '"]');
        if (!el) return;
        if (cb && cb.checked) {
          session[fm.key] = null; // use default
        } else {
          if (fm.type === 'number') {
            session[fm.key] = parseInt(el.value) || defaults[fm.key];
          } else {
            session[fm.key] = el.value;
          }
        }
      });

      // Save connection fields directly (per-session, no defaults)
      if (session.type === 'serial') {
        session.port = document.getElementById('setting-port').value;
        session.baudRate = parseInt(document.getElementById('setting-baud').value) || 115200;
        session.dataBits = parseInt(document.getElementById('setting-databits').value) || 8;
        session.stopBits = parseInt(document.getElementById('setting-stopbits').value) || 1;
        session.parity = document.getElementById('setting-parity').value || 'none';
      } else {
        session.host = document.getElementById('setting-ssh-host').value.trim();
        session.sshPort = parseInt(document.getElementById('setting-ssh-port').value) || 22;
        session.username = document.getElementById('setting-ssh-username').value.trim();
      }

      session.updatedAt = Date.now();
      saveSessions();
      saveDefaults();
      renderSessionList();

      // If this is the active session, apply changes live
      if (activeSessionId === session.id) {
        var r = resolveSession(session);
        applyTerminalSettings(r);
        // Update toolbar to reflect new connection params
        if (session.type === 'serial') {
          portSelect.value = session.port || '';
          baudSelect.value = r.baudRate;
          databitsSelect.value = r.dataBits;
          stopbitsSelect.value = r.stopBits;
          paritySelect.value = r.parity;
        } else {
          sshHostInput.value = r.host;
          sshPortInput.value = r.sshPort;
          sshUsernameInput.value = r.username;
        }
      }
    }

    settingsModal.classList.add('hidden');
    refreshPorts();
  }

  // "Use default" checkbox handler
  document.querySelectorAll('.use-default-cb').forEach(function(cb) {
    cb.addEventListener('change', function() {
      var field = cb.getAttribute('data-field');
      // Find the input in the same .setting-row
      var row = cb.closest('.setting-row');
      if (!row) return;
      var input = row.querySelector('input:not(.use-default-cb), select');
      if (!input) return;
      input.disabled = cb.checked;
      if (cb.checked) {
        input.value = defaults[field];
      }
    });
  });

  // -----------------------------------------------------------------------
  // New session modal
  // -----------------------------------------------------------------------

  function switchNewSessionType(type) {
    newSessionTypeValue = type;
    newSessionTypeTabs.forEach(function(t) {
      t.classList.toggle('active', t.getAttribute('data-type') === type);
    });
    newSessionSerialFields.classList.toggle('hidden', type !== 'serial');
    newSessionSshFields.classList.toggle('hidden', type !== 'ssh');
  }

  async function refreshNewSessionPorts() {
    var sel = document.getElementById('new-session-port');
    try {
      var res = await fetch(API_BASE + '/api/ports');
      var ports = await res.json();
      sel.innerHTML = '<option value="">Select Port...</option>';
      var filtered = ports;
      if (defaults.filterCuOnly) {
        filtered = ports.filter(function(p) { return !p.name.startsWith('/dev/tty.'); });
      }
      filtered.forEach(function(p) {
        var opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name + ' (' + p.port_type + ')';
        sel.appendChild(opt);
      });
    } catch (e) {
      console.error('Failed to fetch ports for new session:', e);
    }
  }

  function openNewSessionModal() {
    document.getElementById('new-session-name').value = '';
    switchNewSessionType('serial');
    document.getElementById('new-session-port').value = '';
    document.getElementById('new-session-baud').value = defaults.baudRate;
    document.getElementById('new-session-databits').value = defaults.dataBits;
    document.getElementById('new-session-stopbits').value = defaults.stopBits;
    document.getElementById('new-session-parity').value = defaults.parity;
    document.getElementById('new-session-host').value = '';
    document.getElementById('new-session-ssh-port').value = defaults.sshPort;
    document.getElementById('new-session-username').value = '';
    refreshNewSessionPorts();
    newSessionModal.classList.remove('hidden');
  }

  function createNewSession() {
    var name = document.getElementById('new-session-name').value.trim();
    if (!name) name = 'Untitled';
    var type = newSessionTypeValue;

    var session = {
      id: genId(),
      name: name,
      type: type,
      // Connection-specific
      host: type === 'ssh' ? document.getElementById('new-session-host').value.trim() : null,
      port: type === 'serial' ? document.getElementById('new-session-port').value : null,
      username: type === 'ssh' ? document.getElementById('new-session-username').value.trim() : null,
      // Serial params from modal (store non-default values, null for defaults)
      baudRate: type === 'serial' ? parseInt(document.getElementById('new-session-baud').value) : null,
      dataBits: type === 'serial' ? parseInt(document.getElementById('new-session-databits').value) : null,
      stopBits: type === 'serial' ? parseInt(document.getElementById('new-session-stopbits').value) : null,
      parity: type === 'serial' ? document.getElementById('new-session-parity').value : null,
      sshPort: type === 'ssh' ? parseInt(document.getElementById('new-session-ssh-port').value) : null,
      // Visual settings inherit from defaults
      fontSize: null,
      fontFamily: null,
      themeBackground: null,
      themeForeground: null,
      themeCursor: null,
      themeSelection: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    sessions.push(session);
    saveSessions();
    renderSessionList();
    newSessionModal.classList.add('hidden');
  }

  // -----------------------------------------------------------------------
  // UI update
  // -----------------------------------------------------------------------

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
      modeTabs.forEach(function(tab) { tab.disabled = false; });
    }
  }

  // -----------------------------------------------------------------------
  // Event listeners
  // -----------------------------------------------------------------------

  modeTabs.forEach(function(tab) {
    tab.addEventListener('click', function() {
      if (connected) return;
      switchMode(tab.getAttribute('data-mode'));
    });
  });

  connectBtn.addEventListener('click', function() {
    if (connected) disconnect();
    else connect();
  });

  refreshBtn.addEventListener('click', refreshPorts);

  [sshHostInput, sshPortInput, sshUsernameInput, sshPasswordInput].forEach(function(el) {
    el.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !connected) connect();
    });
  });

  // Sidebar
  sessionsBtn.addEventListener('click', toggleSidebar);
  sessionAddBtn.addEventListener('click', openNewSessionModal);

  // Settings
  settingsBtn.addEventListener('click', openDefaultSettings);
  settingsCloseBtn.addEventListener('click', function() { settingsModal.classList.add('hidden'); });
  settingsSaveBtn.addEventListener('click', saveSettingsModal);
  document.getElementById('setting-refresh-port-btn').addEventListener('click', function() {
    refreshSettingPorts();
  });
  settingsModal.addEventListener('click', function(e) {
    if (e.target === settingsModal) settingsModal.classList.add('hidden');
  });

  settingsTabs.forEach(function(tab) {
    tab.addEventListener('click', function() {
      switchSettingsTab(tab.getAttribute('data-tab'));
    });
  });

  // New session modal
  newSessionCloseBtn.addEventListener('click', function() { newSessionModal.classList.add('hidden'); });
  newSessionCreateBtn.addEventListener('click', createNewSession);
  newSessionModal.addEventListener('click', function(e) {
    if (e.target === newSessionModal) newSessionModal.classList.add('hidden');
  });
  newSessionTypeTabs.forEach(function(tab) {
    tab.addEventListener('click', function() {
      switchNewSessionType(tab.getAttribute('data-type'));
    });
  });
  document.getElementById('new-session-refresh-btn').addEventListener('click', refreshNewSessionPorts);

  // Click terminal to close sidebar
  terminalContainer.addEventListener('click', closeSidebar);

  // Handle window resize
  window.addEventListener('resize', function() {
    if (fitAddon) fitAddon.fit();
  });

  // Cmd+R to reload
  window.addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
      e.preventDefault();
      location.reload();
    }
  });

  // -----------------------------------------------------------------------
  // Terminal search (Cmd+F / Ctrl+F)
  // -----------------------------------------------------------------------

  function openSearchBar() {
    searchBar.classList.remove('hidden');
    searchInput.focus();
    searchInput.select();
  }

  function closeSearchBar() {
    searchBar.classList.add('hidden');
    searchCount.textContent = '';
    searchInput.value = '';
    if (searchAddon) searchAddon.clearDecorations();
    if (term) term.focus();
  }

  function updateSearchCount(result) {
    if (!result || result.resultCount === undefined) {
      searchCount.textContent = '';
      return;
    }
    if (result.resultCount === 0) {
      searchCount.textContent = 'No results';
    } else {
      searchCount.textContent = result.resultIndex + 1 + ' of ' + result.resultCount;
    }
  }

  function doSearchNext() {
    if (!searchAddon || !searchInput.value) return;
    var result = searchAddon.findNext(searchInput.value);
    updateSearchCount(result);
  }

  function doSearchPrev() {
    if (!searchAddon || !searchInput.value) return;
    var result = searchAddon.findPrevious(searchInput.value);
    updateSearchCount(result);
  }

  searchInput.addEventListener('input', function() {
    if (!searchInput.value) {
      searchCount.textContent = '';
      if (searchAddon) searchAddon.clearDecorations();
      return;
    }
    doSearchNext();
  });

  searchInput.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSearchBar();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) doSearchPrev();
      else doSearchNext();
    }
  });

  searchNextBtn.addEventListener('click', doSearchNext);
  searchPrevBtn.addEventListener('click', doSearchPrev);
  searchCloseBtn.addEventListener('click', closeSearchBar);

  // Cmd+F / Ctrl+F to open search
  window.addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault();
      openSearchBar();
    }
  });

  // -----------------------------------------------------------------------
  // Initialize
  // -----------------------------------------------------------------------

  initTerminal(defaults);
  refreshPorts();
  applySshInfo();
  renderSessionList();
  if (defaults.sidebarOpen) sessionSidebar.classList.add('open');
  checkAndReconnect();
})();
