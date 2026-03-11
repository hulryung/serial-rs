(function() {
  // Backend server URL (Axum serves API and WebSocket)
  const API_BASE = 'http://localhost:3000';
  const WS_BASE = 'ws://localhost:3000';
  const MAX_TABS = 10;

  // DOM elements - Serial
  const portSelect = document.getElementById('port-select');
  const baudSelect = document.getElementById('baud-select');
  const databitsSelect = document.getElementById('databits-select');
  const stopbitsSelect = document.getElementById('stopbits-select');
  const paritySelect = document.getElementById('parity-select');
  const flowcontrolSelect = document.getElementById('flowcontrol-select');
  const refreshBtn = document.getElementById('refresh-btn');

  // DOM elements - SSH
  const sshHostInput = document.getElementById('ssh-host');
  const sshPortInput = document.getElementById('ssh-port');
  const sshUsernameInput = document.getElementById('ssh-username');
  const sshPasswordInput = document.getElementById('ssh-password');
  const sshKeyfileInput = document.getElementById('ssh-keyfile');

  // DOM elements - Config wrappers
  const serialConfig = document.getElementById('serial-config');
  const sshConfig = document.getElementById('ssh-config');

  // DOM elements - Mode tabs
  const modeTabs = document.querySelectorAll('.mode-tab');

  // DOM elements - Shared
  const connectBtn = document.getElementById('connect-btn');
  const statusIndicator = document.getElementById('status-indicator');
  const terminalWrapper = document.getElementById('terminal-wrapper');
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

  // DOM elements - Logging
  var logBtn = document.getElementById('log-btn');
  var logModal = document.getElementById('log-modal');
  var logModalCloseBtn = document.getElementById('log-modal-close-btn');
  var logPathInput = document.getElementById('log-path-input');
  var logStartBtn = document.getElementById('log-start-btn');
  var statusbarLogPath = document.getElementById('statusbar-log-path');

  // DOM elements - Tab bar
  var tabList = document.getElementById('tab-list');
  var tabAddBtn = document.getElementById('tab-add-btn');

  // State
  var currentMode = 'serial';
  var activeSessionId = null;
  var settingsContext = null;
  var collapsedFolders = {};

  // -----------------------------------------------------------------------
  // Multi-tab state
  // -----------------------------------------------------------------------

  // Each tab: { id, label, term, ws, fitAddon, searchAddon, onDataDisposable,
  //             connected, mode, containerEl, loggingActive, loggingPath,
  //             zmodemFileStart, zmodemFileCount }
  var tabs = [];
  var activeTabId = null;

  function genTabId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  }

  function findTab(tabId) {
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].id === tabId) return tabs[i];
    }
    return null;
  }

  function getActiveTab() {
    return findTab(activeTabId);
  }

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
    sidebarOpen: false,
    folders: []
  };

  var defaults = loadDefaults();
  var sessions = loadSessions();

  function loadDefaults() {
    try {
      var saved = JSON.parse(localStorage.getItem('serial-rs-defaults'));
      if (saved) return Object.assign({}, DEFAULT_SETTINGS, saved);
    } catch (e) {}
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

  function resolveSession(session) {
    var r = {};
    var visualFields = ['fontSize', 'fontFamily', 'themeBackground', 'themeForeground',
                        'themeCursor', 'themeSelection'];
    visualFields.forEach(function(f) {
      r[f] = (session[f] !== null && session[f] !== undefined) ? session[f] : defaults[f];
    });
    r.host = session.host || '';
    r.port = session.port || '';
    r.username = session.username || '';
    r.baudRate = session.baudRate || 115200;
    r.dataBits = session.dataBits || 8;
    r.stopBits = session.stopBits || 1;
    r.parity = session.parity || 'none';
    r.flowControl = session.flowControl || 'none';
    r.sshPort = session.sshPort || 22;
    r.keyFile = session.keyFile || '';
    return r;
  }

  function findSession(id) {
    return sessions.find(function(s) { return s.id === id; });
  }

  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  }

  // -----------------------------------------------------------------------
  // Folder helpers
  // -----------------------------------------------------------------------

  function ensureFolder(name) {
    if (!name) return;
    if (!defaults.folders) defaults.folders = [];
    if (defaults.folders.indexOf(name) === -1) {
      defaults.folders.push(name);
      saveDefaults();
    }
  }

  function cleanupFolders() {
    if (!defaults.folders) return;
    var usedFolders = {};
    sessions.forEach(function(s) {
      if (s.folder) usedFolders[s.folder] = true;
    });
    defaults.folders = defaults.folders.filter(function(f) { return usedFolders[f]; });
    saveDefaults();
  }

  function populateFolderSelect(selectEl, selectedFolder) {
    selectEl.innerHTML = '<option value="">(None)</option>';
    var folders = (defaults.folders || []).slice().sort();
    folders.forEach(function(f) {
      var opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f;
      selectEl.appendChild(opt);
    });
    var newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.textContent = 'New folder\u2026';
    selectEl.appendChild(newOpt);
    if (selectedFolder) selectEl.value = selectedFolder;
  }

  function setupFolderSelect(selectEl, newFolderRowId) {
    var row = document.getElementById(newFolderRowId);
    selectEl.addEventListener('change', function() {
      if (selectEl.value === '__new__') {
        row.classList.remove('hidden');
        var input = row.querySelector('input');
        if (input) input.focus();
      } else {
        row.classList.add('hidden');
      }
    });
  }

  function readFolderValue(selectEl, newFolderInputId) {
    if (selectEl.value === '__new__') {
      var name = document.getElementById(newFolderInputId).value.trim();
      if (name) {
        ensureFolder(name);
        return name;
      }
      return null;
    }
    return selectEl.value || null;
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
      username: sshUsernameInput.value,
      keyFile: sshKeyfileInput.value
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
    if (info.keyFile) sshKeyfileInput.value = info.keyFile;
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
  // Tab management
  // -----------------------------------------------------------------------

  function createTab(label, settings) {
    if (tabs.length >= MAX_TABS) {
      var active = getActiveTab();
      if (active && active.term) {
        active.term.writeln('\r\n[Error] Maximum of ' + MAX_TABS + ' tabs reached');
      }
      return null;
    }

    var ts = settings || defaults;
    var id = genTabId();

    // Create terminal container div
    var containerEl = document.createElement('div');
    containerEl.className = 'terminal-pane';
    containerEl.setAttribute('data-tab-id', id);
    terminalWrapper.appendChild(containerEl);

    // Create Terminal instance
    var term = new Terminal({
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

    var fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    var searchAddon = new SearchAddon.SearchAddon();
    term.loadAddon(searchAddon);

    term.open(containerEl);

    var tab = {
      id: id,
      label: label || 'New Tab',
      term: term,
      ws: null,
      fitAddon: fitAddon,
      searchAddon: searchAddon,
      onDataDisposable: null,
      connected: false,
      mode: currentMode,
      containerEl: containerEl,
      loggingActive: false,
      loggingPath: null,
      zmodemFileStart: 0,
      zmodemFileCount: 0
    };

    // SSH resize handler per-tab
    term.onResize(function(size) {
      if (tab.ws && tab.ws.readyState === WebSocket.OPEN && tab.mode === 'ssh') {
        tab.ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
      }
    });

    tabs.push(tab);
    switchToTab(id);

    term.writeln('Serial Terminal Ready.');
    term.writeln('Select a port and click Connect.');

    renderTabBar();
    return tab;
  }

  function switchToTab(tabId) {
    var tab = findTab(tabId);
    if (!tab) return;

    activeTabId = tabId;

    // Hide all terminal panes, show active
    tabs.forEach(function(t) {
      t.containerEl.classList.toggle('active', t.id === tabId);
    });

    // Fit the active terminal
    setTimeout(function() {
      if (tab.fitAddon) {
        try { tab.fitAddon.fit(); } catch (e) {}
      }
    }, 10);

    // Update mode for toolbar
    currentMode = tab.mode;
    switchMode(currentMode);

    // Update toolbar state based on this tab's connection
    updateUI();
    renderTabBar();
    updateLogUI();

    // Focus the terminal
    if (tab.term) tab.term.focus();
  }

  function closeTab(tabId) {
    var tab = findTab(tabId);
    if (!tab) return;

    // Disconnect if connected
    if (tab.connected) {
      disconnectTab(tab);
    }

    // Dispose terminal
    if (tab.onDataDisposable) { tab.onDataDisposable.dispose(); tab.onDataDisposable = null; }
    if (tab.ws) { tab.ws.onopen = null; tab.ws.onclose = null; tab.ws.onerror = null; tab.ws.close(); tab.ws = null; }
    if (tab.term) { tab.term.dispose(); tab.term = null; }
    if (tab.containerEl && tab.containerEl.parentNode) {
      tab.containerEl.parentNode.removeChild(tab.containerEl);
    }

    // Remove from array
    tabs = tabs.filter(function(t) { return t.id !== tabId; });

    // If we closed the active tab, switch to another
    if (activeTabId === tabId) {
      if (tabs.length > 0) {
        switchToTab(tabs[tabs.length - 1].id);
      } else {
        activeTabId = null;
        // Create a new default tab
        createTab('New Tab');
      }
    }

    renderTabBar();
  }

  function renderTabBar() {
    tabList.innerHTML = '';
    tabs.forEach(function(tab) {
      var el = document.createElement('div');
      el.className = 'tab-item' + (tab.id === activeTabId ? ' active' : '') + (tab.connected ? ' connected' : '');

      var status = document.createElement('span');
      status.className = 'tab-status';

      var label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = tab.label;

      var close = document.createElement('button');
      close.className = 'tab-close';
      close.textContent = '\u00D7';
      close.title = 'Close tab';
      close.addEventListener('click', function(e) {
        e.stopPropagation();
        closeTab(tab.id);
      });

      el.appendChild(status);
      el.appendChild(label);
      el.appendChild(close);

      el.addEventListener('click', function() {
        switchToTab(tab.id);
      });

      tabList.appendChild(el);
    });
  }

  // -----------------------------------------------------------------------
  // Terminal settings
  // -----------------------------------------------------------------------

  function applyTerminalSettings(ts) {
    var tab = getActiveTab();
    if (!tab || !tab.term) return;
    tab.term.options.fontSize = ts.fontSize;
    tab.term.options.fontFamily = ts.fontFamily;
    tab.term.options.theme = {
      background: ts.themeBackground,
      foreground: ts.themeForeground,
      cursor: ts.themeCursor,
      selectionBackground: ts.themeSelection,
    };
    if (tab.fitAddon) tab.fitAddon.fit();
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
      var tab = getActiveTab();
      if (tab && tab.term) tab.term.writeln('\r\n[Error] Failed to fetch port list');
    }
  }

  // -----------------------------------------------------------------------
  // ZMODEM inline progress
  // -----------------------------------------------------------------------

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  function handleZmodemNotification(tab, str) {
    var match = str.match(/\x1b\]zmodem;(.*?)\x07/);
    if (!match) return;
    try {
      var msg = JSON.parse(match[1]);
      if (msg.state === 'started') {
        tab.zmodemFileCount = 0;
        tab.zmodemFileStart = Date.now();
        tab.term.write('\r\n');
      } else if (msg.state === 'progress') {
        var elapsed = (Date.now() - tab.zmodemFileStart) / 1000;
        var speed = elapsed > 0 ? (msg.received || 0) / elapsed : 0;
        var pct = msg.total > 0 ? Math.min(100, Math.round(((msg.received || 0) / msg.total) * 100)) : 0;
        tab.term.write('\r\x1b[K' + (msg.filename || '') + '  ' + pct + '%  ' +
          formatBytes(msg.received || 0) + '/' + formatBytes(msg.total || 0) +
          '  ' + formatBytes(speed) + '/s');
      } else if (msg.state === 'file_complete') {
        var sec = (msg.elapsedMs || 0) / 1000;
        var fspeed = sec > 0 ? (msg.size || 0) / sec : 0;
        tab.term.write('\r\x1b[K');
        tab.term.writeln((msg.filename || '') + '  ' + formatBytes(msg.size || 0) + '  ' + sec.toFixed(1) + 's  ' + formatBytes(fspeed) + '/s');
        tab.zmodemFileCount++;
        tab.zmodemFileStart = Date.now();
      } else if (msg.state === 'completed') {
        var elapsedSec = (msg.elapsedMs || 0) / 1000;
        var cspeed = elapsedSec > 0 ? (msg.totalBytes || 0) / elapsedSec : 0;
        if (tab.zmodemFileCount > 1) {
          tab.term.writeln('Total: ' + tab.zmodemFileCount + ' files  ' +
            formatBytes(msg.totalBytes || 0) + '  ' + elapsedSec.toFixed(1) + 's  ' + formatBytes(cspeed) + '/s');
        }
      } else if (msg.state === 'error') {
        tab.term.writeln('\r\n[ZMODEM Error] ' + (msg.message || 'Unknown error'));
      }
    } catch (e) {
      console.error('Failed to parse ZMODEM notification:', e);
    }
  }

  // -----------------------------------------------------------------------
  // WebSocket (per-tab)
  // -----------------------------------------------------------------------

  function openWebSocket(tab, label) {
    tab.ws = new WebSocket(WS_BASE + '/ws?tab_id=' + encodeURIComponent(tab.id));
    tab.ws.binaryType = 'arraybuffer';

    tab.ws.onopen = function() {
      tab.connected = true;
      tab.label = label;
      if (tab.id === activeTabId) updateUI();
      renderTabBar();
      tab.term.writeln('\r\n[Connected] ' + label);

      tab.ws.onmessage = function(event) {
        if (typeof event.data === 'string') {
          if (event.data.indexOf('\x1b]zmodem;') !== -1) {
            handleZmodemNotification(tab, event.data);
            return;
          }
          tab.term.write(event.data);
        } else if (event.data instanceof ArrayBuffer) {
          tab.term.write(new Uint8Array(event.data));
        }
      };

      tab.onDataDisposable = tab.term.onData(function(data) {
        if (tab.ws && tab.ws.readyState === WebSocket.OPEN) {
          tab.ws.send(new TextEncoder().encode(data));
        }
      });

      if (tab.mode === 'ssh') {
        tab.ws.send(JSON.stringify({ type: 'resize', cols: tab.term.cols, rows: tab.term.rows }));
      }
    };

    tab.ws.onclose = function() {
      if (tab.connected) {
        tab.connected = false;
        if (tab.id === activeTabId) updateUI();
        renderTabBar();
        tab.term.writeln('\r\n[Disconnected]');
      }
    };

    tab.ws.onerror = function(e) {
      console.error('WebSocket error:', e);
      tab.term.writeln('\r\n[Error] WebSocket error');
    };
  }

  // -----------------------------------------------------------------------
  // Connection
  // -----------------------------------------------------------------------

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

  async function disconnectTabBackend(tab) {
    try { await fetch(API_BASE + '/api/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tab_id: tab.id }) }); } catch (e) {}
  }

  async function handleConflict(tab) {
    if (defaults.alwaysReconnect) {
      await disconnectTabBackend(tab);
    } else {
      var choice = await showReconnectConfirm();
      if (choice === 'cancel') return false;
      if (choice === 'always') {
        defaults.alwaysReconnect = true;
        saveDefaults();
      }
      await disconnectTabBackend(tab);
    }
    return true;
  }

  async function connectSerial() {
    var tab = getActiveTab();
    if (!tab) return;

    var port = portSelect.value;
    if (!port) { tab.term.writeln('\r\n[Error] Please select a port'); return; }

    tab.mode = 'serial';

    var config = {
      tab_id: tab.id,
      port: port,
      baud_rate: parseInt(baudSelect.value),
      data_bits: parseInt(databitsSelect.value),
      stop_bits: parseInt(stopbitsSelect.value),
      parity: paritySelect.value,
      flow_control: flowcontrolSelect.value,
    };

    try {
      var res = await fetch(API_BASE + '/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      var result = await res.json();

      if (res.status === 409) {
        if (!(await handleConflict(tab))) return;
        res = await fetch(API_BASE + '/api/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        });
        result = await res.json();
      }

      if (!result.ok) { tab.term.writeln('\r\n[Error] ' + result.message); return; }
      openWebSocket(tab, port + ' @ ' + config.baud_rate);
    } catch (e) {
      tab.term.writeln('\r\n[Error] Connection failed: ' + e.message);
    }
  }

  async function connectSsh() {
    var tab = getActiveTab();
    if (!tab) return;

    var host = sshHostInput.value.trim();
    var port = parseInt(sshPortInput.value) || 22;
    var username = sshUsernameInput.value.trim();
    var password = sshPasswordInput.value;
    var keyFile = sshKeyfileInput.value.trim();

    if (!host) { tab.term.writeln('\r\n[Error] Please enter a host'); return; }
    if (!username) { tab.term.writeln('\r\n[Error] Please enter a username'); return; }

    tab.mode = 'ssh';

    var sshConfig = { tab_id: tab.id, host: host, port: port, username: username, password: password, key_file: keyFile || null };

    try {
      var res = await fetch(API_BASE + '/api/ssh/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sshConfig),
      });
      var result = await res.json();

      if (res.status === 409) {
        if (!(await handleConflict(tab))) return;
        res = await fetch(API_BASE + '/api/ssh/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sshConfig),
        });
        result = await res.json();
      }

      if (!result.ok) { tab.term.writeln('\r\n[Error] ' + result.message); return; }
      openWebSocket(tab, 'SSH ' + username + '@' + host + ':' + port);

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
      tab.term.writeln('\r\n[Error] SSH connection failed: ' + e.message);
    }
  }

  function connect() {
    if (currentMode === 'serial') connectSerial();
    else connectSsh();
  }

  function disconnectTab(tab) {
    tab.connected = false;
    if (tab.onDataDisposable) { tab.onDataDisposable.dispose(); tab.onDataDisposable = null; }
    if (tab.ws) { tab.ws.onopen = null; tab.ws.onclose = null; tab.ws.onerror = null; tab.ws.close(); tab.ws = null; }
    fetch(API_BASE + '/api/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tab_id: tab.id }) }).catch(function() {});
    if (tab.id === activeTabId) updateUI();
    renderTabBar();
    if (tab.term) tab.term.writeln('\r\n[Disconnected]');
  }

  async function disconnect() {
    var tab = getActiveTab();
    if (!tab) return;
    disconnectTab(tab);
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

    // If active tab is not connected, reuse it; otherwise create a new tab
    var tab = getActiveTab();
    if (!tab || tab.connected) {
      tab = createTab(session.name, r);
      if (!tab) return;
    } else {
      // Apply terminal theme to existing tab
      applyTerminalSettings(r);
      tab.label = session.name;
    }

    // Switch mode and populate toolbar
    tab.mode = session.type;
    switchMode(session.type);
    if (session.type === 'serial') {
      portSelect.value = session.port || '';
      baudSelect.value = r.baudRate;
      databitsSelect.value = r.dataBits;
      stopbitsSelect.value = r.stopBits;
      paritySelect.value = r.parity;
      flowcontrolSelect.value = r.flowControl;
    } else {
      sshHostInput.value = r.host;
      sshPortInput.value = r.sshPort;
      sshUsernameInput.value = r.username;
      sshPasswordInput.value = session.password || '';
      sshKeyfileInput.value = r.keyFile;
    }

    renderSessionList();
    connect();
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

  function buildSessionItem(s) {
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
      cleanupFolders();
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

    return div;
  }

  function renderSessionList() {
    sessionList.innerHTML = '';
    if (sessions.length === 0) {
      sessionList.innerHTML = '<div class="session-empty">No saved sessions.<br>Click + to create one.</div>';
      return;
    }

    var rootSessions = [];
    var folderMap = {};
    sessions.forEach(function(s) {
      var folder = s.folder || '';
      if (!folder) {
        rootSessions.push(s);
      } else {
        if (!folderMap[folder]) folderMap[folder] = [];
        folderMap[folder].push(s);
      }
    });

    rootSessions.forEach(function(s) {
      sessionList.appendChild(buildSessionItem(s));
    });

    var folderNames = Object.keys(folderMap).sort();
    folderNames.forEach(function(folderName) {
      var isCollapsed = !!collapsedFolders[folderName];
      var folderSessions = folderMap[folderName];

      var header = document.createElement('div');
      header.className = 'session-folder-header';

      var chevron = document.createElement('span');
      chevron.className = 'session-folder-chevron';
      chevron.textContent = isCollapsed ? '\u25B6' : '\u25BC';

      var folderIcon = document.createElement('span');
      folderIcon.className = 'session-folder-icon';
      folderIcon.textContent = '\uD83D\uDCC1';

      var nameSpan = document.createElement('span');
      nameSpan.className = 'session-folder-name';
      nameSpan.textContent = folderName;

      var countSpan = document.createElement('span');
      countSpan.className = 'session-folder-count';
      countSpan.textContent = folderSessions.length;

      header.appendChild(chevron);
      header.appendChild(folderIcon);
      header.appendChild(nameSpan);
      header.appendChild(countSpan);

      var body = document.createElement('div');
      body.className = 'session-folder-body' + (isCollapsed ? ' collapsed' : '');

      folderSessions.forEach(function(s) {
        body.appendChild(buildSessionItem(s));
      });

      header.addEventListener('click', function() {
        collapsedFolders[folderName] = !collapsedFolders[folderName];
        renderSessionList();
      });

      sessionList.appendChild(header);
      sessionList.appendChild(body);
    });
  }

  // -----------------------------------------------------------------------
  // Settings modal
  // -----------------------------------------------------------------------

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

    document.querySelectorAll('.session-only').forEach(function(el) {
      el.classList.add('hidden');
    });

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

    document.querySelectorAll('.session-only').forEach(function(el) {
      el.classList.remove('hidden');
    });

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
      document.getElementById('setting-flowcontrol').value = session.flowControl || 'none';
    } else {
      connSerial.classList.add('hidden');
      connSsh.classList.remove('hidden');
      document.getElementById('setting-ssh-host').value = session.host || '';
      document.getElementById('setting-ssh-port').value = session.sshPort || 22;
      document.getElementById('setting-ssh-username').value = session.username || '';
      document.getElementById('setting-ssh-keyfile').value = session.keyFile || '';
    }

    populateFolderSelect(document.getElementById('setting-folder'), session.folder || '');
    document.getElementById('setting-new-folder-row').classList.add('hidden');
    document.getElementById('setting-new-folder').value = '';

    filterCuCheckbox.checked = defaults.filterCuOnly;
    alwaysReconnectCheckbox.checked = defaults.alwaysReconnect;
    rememberSshCheckbox.checked = defaults.rememberSsh;

    switchSettingsTab('connection');
    settingsModal.classList.remove('hidden');
  }

  function saveSettingsModal() {
    if (!settingsContext) return;

    defaults.filterCuOnly = filterCuCheckbox.checked;
    defaults.alwaysReconnect = alwaysReconnectCheckbox.checked;
    defaults.rememberSsh = rememberSshCheckbox.checked;

    if (settingsContext.mode === 'defaults') {
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
      applyTerminalSettings(defaults);
    } else if (settingsContext.mode === 'session') {
      var session = findSession(settingsContext.sessionId);
      if (!session) return;

      Object.keys(FIELD_MAP).forEach(function(elId) {
        var fm = FIELD_MAP[elId];
        var el = document.getElementById(elId);
        var cb = document.querySelector('.use-default-cb[data-field="' + fm.key + '"]');
        if (!el) return;
        if (cb && cb.checked) {
          session[fm.key] = null;
        } else {
          if (fm.type === 'number') {
            session[fm.key] = parseInt(el.value) || defaults[fm.key];
          } else {
            session[fm.key] = el.value;
          }
        }
      });

      session.folder = readFolderValue(document.getElementById('setting-folder'), 'setting-new-folder');

      if (session.type === 'serial') {
        session.port = document.getElementById('setting-port').value;
        session.baudRate = parseInt(document.getElementById('setting-baud').value) || 115200;
        session.dataBits = parseInt(document.getElementById('setting-databits').value) || 8;
        session.stopBits = parseInt(document.getElementById('setting-stopbits').value) || 1;
        session.parity = document.getElementById('setting-parity').value || 'none';
        session.flowControl = document.getElementById('setting-flowcontrol').value || 'none';
      } else {
        session.host = document.getElementById('setting-ssh-host').value.trim();
        session.sshPort = parseInt(document.getElementById('setting-ssh-port').value) || 22;
        session.username = document.getElementById('setting-ssh-username').value.trim();
        session.keyFile = document.getElementById('setting-ssh-keyfile').value.trim() || null;
      }

      session.updatedAt = Date.now();
      saveSessions();
      cleanupFolders();
      saveDefaults();
      renderSessionList();

      if (activeSessionId === session.id) {
        var r = resolveSession(session);
        applyTerminalSettings(r);
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
          sshKeyfileInput.value = r.keyFile;
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
    document.getElementById('new-session-keyfile').value = '';
    populateFolderSelect(document.getElementById('new-session-folder'), '');
    document.getElementById('new-session-new-folder-row').classList.add('hidden');
    document.getElementById('new-session-new-folder').value = '';
    refreshNewSessionPorts();
    newSessionModal.classList.remove('hidden');
  }

  function createNewSession() {
    var name = document.getElementById('new-session-name').value.trim();
    if (!name) name = 'Untitled';
    var type = newSessionTypeValue;
    var folder = readFolderValue(document.getElementById('new-session-folder'), 'new-session-new-folder');

    var session = {
      id: genId(),
      name: name,
      type: type,
      folder: folder,
      host: type === 'ssh' ? document.getElementById('new-session-host').value.trim() : null,
      port: type === 'serial' ? document.getElementById('new-session-port').value : null,
      username: type === 'ssh' ? document.getElementById('new-session-username').value.trim() : null,
      baudRate: type === 'serial' ? parseInt(document.getElementById('new-session-baud').value) : null,
      dataBits: type === 'serial' ? parseInt(document.getElementById('new-session-databits').value) : null,
      stopBits: type === 'serial' ? parseInt(document.getElementById('new-session-stopbits').value) : null,
      parity: type === 'serial' ? document.getElementById('new-session-parity').value : null,
      flowControl: type === 'serial' ? document.getElementById('new-session-flowcontrol').value : null,
      sshPort: type === 'ssh' ? parseInt(document.getElementById('new-session-ssh-port').value) : null,
      keyFile: type === 'ssh' ? (document.getElementById('new-session-keyfile').value.trim() || null) : null,
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
    var tab = getActiveTab();
    var connected = tab ? tab.connected : false;

    if (connected) {
      connectBtn.textContent = 'Disconnect';
      connectBtn.classList.add('connected');
      statusIndicator.textContent = 'Connected';
      statusIndicator.className = 'connected';

      if (tab.mode === 'serial') {
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
        sshKeyfileInput.disabled = true;
      }
      modeTabs.forEach(function(t) { t.disabled = true; });
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
      sshKeyfileInput.disabled = false;
      modeTabs.forEach(function(t) { t.disabled = false; });
    }
  }

  // -----------------------------------------------------------------------
  // Event listeners
  // -----------------------------------------------------------------------

  modeTabs.forEach(function(tab) {
    tab.addEventListener('click', function() {
      var active = getActiveTab();
      if (active && active.connected) return;
      switchMode(tab.getAttribute('data-mode'));
    });
  });

  connectBtn.addEventListener('click', function() {
    var tab = getActiveTab();
    if (tab && tab.connected) disconnect();
    else connect();
  });

  refreshBtn.addEventListener('click', refreshPorts);

  [sshHostInput, sshPortInput, sshUsernameInput, sshPasswordInput, sshKeyfileInput].forEach(function(el) {
    el.addEventListener('keydown', function(e) {
      var tab = getActiveTab();
      if (e.key === 'Enter' && tab && !tab.connected) connect();
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

  // Folder select change handlers
  setupFolderSelect(document.getElementById('new-session-folder'), 'new-session-new-folder-row');
  setupFolderSelect(document.getElementById('setting-folder'), 'setting-new-folder-row');

  // Click terminal to close sidebar
  terminalWrapper.addEventListener('click', closeSidebar);

  // Tab bar
  tabAddBtn.addEventListener('click', function() {
    createTab('New Tab');
  });

  // Handle window resize
  window.addEventListener('resize', function() {
    var tab = getActiveTab();
    if (tab && tab.fitAddon) {
      try { tab.fitAddon.fit(); } catch (e) {}
    }
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
    var tab = getActiveTab();
    if (tab && tab.searchAddon) tab.searchAddon.clearDecorations();
    if (tab && tab.term) tab.term.focus();
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
    var tab = getActiveTab();
    if (!tab || !tab.searchAddon || !searchInput.value) return;
    var result = tab.searchAddon.findNext(searchInput.value);
    updateSearchCount(result);
  }

  function doSearchPrev() {
    var tab = getActiveTab();
    if (!tab || !tab.searchAddon || !searchInput.value) return;
    var result = tab.searchAddon.findPrevious(searchInput.value);
    updateSearchCount(result);
  }

  searchInput.addEventListener('input', function() {
    if (!searchInput.value) {
      searchCount.textContent = '';
      var tab = getActiveTab();
      if (tab && tab.searchAddon) tab.searchAddon.clearDecorations();
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
  // Session logging (per-tab)
  // -----------------------------------------------------------------------

  function formatTimestamp() {
    var d = new Date();
    var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) + '-' +
      pad(d.getHours()) +
      pad(d.getMinutes()) +
      pad(d.getSeconds());
  }

  function updateLogUI() {
    var tab = getActiveTab();
    var active = tab ? tab.loggingActive : false;
    var path = tab ? tab.loggingPath : null;

    if (active) {
      logBtn.classList.add('logging');
      logBtn.title = 'Stop logging';
      var displayPath = path || '';
      var parts = displayPath.split('/');
      statusbarLogPath.textContent = parts[parts.length - 1];
      statusbarLogPath.title = displayPath;
    } else {
      logBtn.classList.remove('logging');
      logBtn.title = 'Toggle session logging';
      statusbarLogPath.textContent = '';
      statusbarLogPath.title = '';
    }
  }

  function refreshLogStatus() {
    var tab = getActiveTab();
    if (!tab) return;
    fetch(API_BASE + '/api/log/status?tab_id=' + encodeURIComponent(tab.id))
      .then(function(res) { return res.json(); })
      .then(function(data) {
        tab.loggingActive = data.active;
        tab.loggingPath = data.path || null;
        if (tab.id === activeTabId) updateLogUI();
      })
      .catch(function(err) { console.error('Log status error:', err); });
  }

  logBtn.addEventListener('click', function() {
    var tab = getActiveTab();
    if (!tab) return;

    if (tab.loggingActive) {
      // Stop logging
      fetch(API_BASE + '/api/log/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tab_id: tab.id })
      })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.ok) {
            tab.loggingActive = false;
            tab.loggingPath = null;
            updateLogUI();
            tab.term.writeln('\r\n[Logging stopped]');
          }
        })
        .catch(function(err) { console.error('Log stop error:', err); });
    } else {
      // Show modal to pick path
      logPathInput.value = '~/Desktop/serial-rs-' + formatTimestamp() + '.log';
      logModal.classList.remove('hidden');
      logPathInput.focus();
      logPathInput.select();
    }
  });

  logStartBtn.addEventListener('click', function() {
    var tab = getActiveTab();
    if (!tab) return;

    var path = logPathInput.value.trim();
    if (!path) return;
    fetch(API_BASE + '/api/log/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab_id: tab.id, path: path })
    })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.ok) {
          tab.loggingActive = true;
          tab.loggingPath = path;
          updateLogUI();
          logModal.classList.add('hidden');
          tab.term.writeln('\r\n[Logging to ' + path + ']');
        } else {
          alert(data.message);
        }
      })
      .catch(function(err) {
        console.error('Log start error:', err);
        alert('Failed to start logging');
      });
  });

  logModalCloseBtn.addEventListener('click', function() {
    logModal.classList.add('hidden');
  });

  logPathInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      logStartBtn.click();
    }
    if (e.key === 'Escape') {
      logModal.classList.add('hidden');
    }
  });

  // -----------------------------------------------------------------------
  // Initialize
  // -----------------------------------------------------------------------

  // Create first tab
  createTab('New Tab');
  refreshPorts();
  applySshInfo();
  renderSessionList();
  if (defaults.sidebarOpen) sessionSidebar.classList.add('open');
  refreshLogStatus();
})();
