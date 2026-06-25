// chatgml.js — GMEdit plugin lifecycle glue (Electron renderer, CommonJS, Node integration on).
//
// Modernizes the old `show-codebase` plugin onto `chatgml serve` (NDJSON over stdio). Replaces the
// Python venv / git-pull / talk-codebase.git clone / YAML config / `...END` + RECREATE_VECTOR_STORE
// protocol entirely. The plugin spawns the ESM core as a SEPARATE child process (it cannot require
// the ESM core) and speaks the existing NDJSON protocol via plugin/client.js. All protocol/state
// logic is in plugin/state.js (a tested port of src/plugin-runtime.ts); this file is DOM/IDE glue.
//
// Load order (config.json): state.js, diff-view.js, panel.js, config-bridge.js, client.js, chatgml.js
// (each later file uses globals defined by the earlier ones).
(function () {
  'use strict';

  const MenuItem = Electron_MenuItem;
  const Preferences = $gmedit['ui.Preferences'];
  const ClientApi = globalThis.ChatGmlClient || require('./client.js');
  const PanelApi = globalThis.ChatGmlPanel || require('./panel.js');
  const ConfigBridgeApi = globalThis.ChatGmlConfigBridge || require('./config-bridge.js');

  const PLUGIN_NAME = 'chatgml';

  let ready = false; // side-panel DOM prepared
  let sizer, splitter, container, editor, mainCont;
  let panelHostEl = null;
  let gmlFile = null;

  let projectDirectory = null;
  let client = null;
  let panel = null;
  const configBridge = new ConfigBridgeApi.ConfigBridge(__dirname);

  // -------------------------------------------------------------------------
  // Child process lifecycle (NdjsonClient) <-> ChatPanel wiring.
  // -------------------------------------------------------------------------
  function launch() {
    if (!projectDirectory) {
      console.warn('chatgml: open a project first');
      return;
    }
    if (client) return;
    client = new ClientApi.NdjsonClient({
      projectDir: projectDirectory,
      configuredPath: configBridge.getBinaryPath(),
      scope: configBridge.getScope() || undefined,
      pluginDir: __dirname,
      onEvent: function (event) {
        if (panel) panel.handleEvent(event);
      },
      onReady: function () {
        if (panel) panel.setReady();
      },
      onMalformed: function (line) {
        console.warn('chatgml: malformed protocol line (ignored):', line);
      },
      onStderr: function (text) {
        // stdout is protocol-only; stderr is diagnostics. Route to the console/log, never the panel.
        console.info('chatgml[serve]:', text.trim());
      },
      onError: function (err) {
        console.error('chatgml: failed to launch core —', err.message);
        if (panel) panel.handleEvent({ type: 'error', message: err.message });
        client = null;
        if (panel) panel.setRunning(false);
      },
      onExit: function (code) {
        console.info('chatgml: core exited', code);
        client = null;
        if (panel) panel.setRunning(false);
      },
    });
    const started = client.start();
    if (started && panel) {
      panel.setRunning(true);
    } else if (!started) {
      client = null;
    }
  }

  function stop() {
    if (client) {
      client.stop();
      client = null;
    }
    if (panel) panel.setRunning(false);
  }

  // -------------------------------------------------------------------------
  // Side-panel scaffolding (reparent the main editor into a flex-row, add the chat panel beside it).
  // Port of the old plugin's GMEdit_Splitter + aceTools side-panel, minus the second Ace editor.
  // -------------------------------------------------------------------------
  function forceUpdate() {
    const e = new CustomEvent('resize');
    e.initEvent('resize');
    window.dispatchEvent(e);
  }

  function hide() {
    if (mainCont && sizer) mainCont.removeChild(sizer);
    if (mainCont && container) mainCont.removeChild(container);
    gmlFile = null;
    forceUpdate();
    setTimeout(function () {
      aceEditor.focus();
    });
  }

  function show() {
    if (gmlFile != null) return;
    if (ready) {
      mainCont.appendChild(sizer);
      mainCont.appendChild(container);
    } else {
      prepare();
    }
    gmlFile = true;
    forceUpdate();
  }

  function prepare() {
    ready = true;

    container = document.createElement('div');
    container.classList.add('ace_container');
    container.id = 'chatgml_editor';

    panelHostEl = document.createElement('div');
    panelHostEl.id = 'chatgml_panel_host';
    container.appendChild(panelHostEl);

    panel = new PanelApi.ChatPanel({
      container: panelHostEl,
      onSend: function (text) {
        if (client) client.sendUser(text);
      },
      onReindex: function () {
        if (client) client.reindex();
      },
      onLaunch: launch,
      onStop: stop,
      onApprove: function (id) {
        if (client) client.approve(id);
        if (panel) panel.settleProposal(id, 'approved');
      },
      onReject: function (id) {
        if (client) client.reject(id);
        if (panel) panel.settleProposal(id, 'rejected');
      },
    });

    sizer = document.createElement('div');
    sizer.setAttribute('splitter-element', '#chatgml_editor');
    sizer.setAttribute('splitter-lskey', 'chatgml_aside_width');
    sizer.setAttribute('splitter-default-width', '420');
    sizer.classList.add('splitter-td');

    // Reparent the existing editor children into a flex-row container so the panel sits beside them.
    const nextCont = document.createElement('div');
    nextCont.classList.add('ace_container');
    mainCont = aceEditor.container.parentElement;
    const mainChildren = [];
    for (let i = 0; i < mainCont.children.length; i++) mainChildren.push(mainCont.children[i]);
    for (let i = 0; i < mainChildren.length; i++) {
      const ch = mainChildren[i];
      mainCont.removeChild(ch);
      nextCont.appendChild(ch);
    }
    mainCont.style.setProperty('flex-direction', 'row');
    mainCont.appendChild(nextCont);
    mainCont.appendChild(sizer);
    mainCont.appendChild(container);

    splitter = new GMEdit_Splitter(sizer);
    void splitter;
    void editor;
  }

  // -------------------------------------------------------------------------
  // GMEdit lifecycle.
  // -------------------------------------------------------------------------
  function init() {
    const mainMenu = aceEditor.contextMenu.menu;
    let insertAt = 0;
    while (insertAt < mainMenu.items.length) {
      if (mainMenu.items[insertAt++].aceCommand === 'selectall') break;
    }
    const insertPosition = Math.min(insertAt + 2, mainMenu.items.length);
    mainMenu.insert(
      insertPosition,
      new MenuItem({
        label: 'ChatGML',
        id: 'chatgml',
        icon: __dirname + '/icons/silk/application_split_vertical.png',
        click: function () {
          show();
        },
      }),
    );

    GMEdit.on('projectOpen', function (e) {
      projectDirectory = e.project.dir; // the on-disk directory (NOT e.project.path / the .yyp)
      console.info('chatgml: project opened', projectDirectory);
    });

    GMEdit.on('preferencesBuilt', function (e) {
      const out = e.target.querySelector('.plugin-settings[for="' + PLUGIN_NAME + '"]');
      if (!out) return;
      Preferences.addInput(
        out,
        'ChatGML binary path (optional)',
        configBridge.getBinaryPath(),
        function (text) {
          configBridge.setBinaryPath(text);
        },
      );
      Preferences.addInput(out, 'Scope (optional)', configBridge.getScope(), function (text) {
        configBridge.setScope(text);
      });
    });
  }

  GMEdit.register(PLUGIN_NAME, {
    init: init,
    cleanup: function () {
      stop();
      hide();
    },
  });
})();
