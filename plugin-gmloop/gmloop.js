// GMEdit companion plugin: safe read-only GMLoop checks from the editor menu.
(function () {
  'use strict';

  const fs = require('fs');
  const path = require('path');
  const { spawn } = require('child_process');
  const MenuItem = Electron_MenuItem;
  const PLUGIN_NAME = 'chatgml-gmloop';
  let projectDirectory = null;

  function existsFile(p) {
    try {
      return p && fs.existsSync(p) && fs.statSync(p).isFile();
    } catch (_) {
      return false;
    }
  }

  function findOnPath(name) {
    const parts = (process.env.PATH || '').split(path.delimiter);
    const suffixes = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : [''];
    for (let i = 0; i < parts.length; i++) {
      for (let j = 0; j < suffixes.length; j++) {
        const p = path.join(parts[i], name + suffixes[j]);
        if (existsFile(p)) return p;
      }
    }
    return '';
  }

  function runner() {
    const configured = process.env.CHATGML_GMLOOP_BIN || '';
    if (existsFile(configured)) {
      return /\.js$/i.test(configured)
        ? { cmd: 'node', prefix: [configured], label: configured }
        : { cmd: configured, prefix: [], label: configured };
    }
    const onPath = findOnPath('gmloop');
    if (onPath) return { cmd: onPath, prefix: [], label: onPath };
    const sibling = path.resolve(__dirname, '..', '..', 'GMLoop', 'src', 'cli', 'dist', 'index.js');
    if (existsFile(sibling)) return { cmd: 'node', prefix: [sibling], label: sibling };
    return { cmd: '', prefix: [], label: 'not found' };
  }

  function currentFile() {
    try {
      const f = aceEditor.session && aceEditor.session.gmlFile;
      return f && (f.path || f.filePath || (f.codeEditor && f.codeEditor.path));
    } catch (_) {
      return '';
    }
  }

  function show(text) {
    alert(String(text || '').slice(0, 12000));
  }

  function getProjectDirectory() {
    if (projectDirectory) return projectDirectory;
    try {
      if (typeof gml_Project !== 'undefined' && gml_Project.current && gml_Project.current.dir) {
        projectDirectory = gml_Project.current.dir;
      }
    } catch (_) {}
    return projectDirectory;
  }

  function run(label, argv) {
    const dir = getProjectDirectory();
    if (!dir) return show('Open a GameMaker project first.');
    const r = runner();
    if (!r.cmd) return show('GMLoop not found. Set CHATGML_GMLOOP_BIN or put gmloop on PATH.');
    const proc = spawn(r.cmd, r.prefix.concat(argv), {
      cwd: dir,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', function (s) {
      chunks.push(s);
    });
    proc.stderr.on('data', function (s) {
      chunks.push(s);
    });
    proc.on('error', function (err) {
      show(label + ' failed: ' + err.message);
    });
    proc.on('close', function (code) {
      show(label + ' exit ' + code + '\n\n' + chunks.join(''));
    });
  }

  function runProject(label, argv) {
    const dir = getProjectDirectory();
    if (!dir) return show('Open a GameMaker project first.');
    return run(
      label,
      argv.map(function (arg) {
        return arg === '$PROJECT' ? dir : arg;
      }),
    );
  }

  function runAceCommand(name, label) {
    try {
      if (!aceEditor || !aceEditor.commands || !aceEditor.commands.commands[name]) {
        return show(label + ' is not available. Install/enable the matching GMLive plugin first.');
      }
      aceEditor.execCommand(name);
      return show(label + ' sent.');
    } catch (err) {
      return show(label + ' failed: ' + (err && err.message ? err.message : err));
    }
  }

  function addMenuItem(menu, index, label, id, click) {
    menu.insert(index, new MenuItem({ label: label, id: id, click: click }));
  }

  function runCurrent(action) {
    const file = currentFile();
    if (!file || !/\.gml$/i.test(file)) return show('Open a .gml file first.');
    if (action === 'lint') return run('GMLoop lint', ['lint', file]);
    if (action === 'format') return run('GMLoop format check', ['format', '--path', file]);
    return run('GMLoop parse', ['parse', '--path', file]);
  }

  function init() {
    const menu = aceEditor.contextMenu.menu;
    addMenuItem(menu, 0, 'GMLoop: lint current file', 'chatgml-gmloop-lint', function () {
      runCurrent('lint');
    });
    addMenuItem(menu, 1, 'GMLoop: format check current file', 'chatgml-gmloop-format', function () {
      runCurrent('format');
    });
    addMenuItem(menu, 2, 'GMLoop: graph doctor project', 'chatgml-gmloop-graph', function () {
      runProject('GMLoop graph doctor', ['graph', 'doctor', '--path', '$PROJECT']);
    });
    addMenuItem(menu, 3, 'GMLoop: live reload status', 'chatgml-gmloop-live-status', function () {
      runProject('GMLoop live reload status', ['live-reload', 'status', '--path', '$PROJECT']);
    });
    addMenuItem(menu, 4, 'GMLoop: discover live reload', 'chatgml-gmloop-live-discover', function () {
      runProject('GMLoop live reload discover', ['live-reload', 'discover', '--path', '$PROJECT']);
    });
    addMenuItem(menu, 5, 'GMLoop: prepare live reload', 'chatgml-gmloop-live-prepare', function () {
      runProject('GMLoop live reload prepare', ['live-reload', 'prepare']);
    });
    addMenuItem(menu, 6, 'GMLoop: wait for patch', 'chatgml-gmloop-live-wait', function () {
      runProject('GMLoop wait for patch', ['live-reload', 'wait-for-patch', '--path', '$PROJECT']);
    });
    addMenuItem(menu, 7, 'GMLoop: runner status', 'chatgml-gmloop-runner-status', function () {
      runProject('GMLoop runner status', ['runner', 'status', '--path', '$PROJECT']);
    });
    addMenuItem(menu, 8, 'GMLoop: runner start', 'chatgml-gmloop-runner-start', function () {
      runProject('GMLoop runner start', ['runner', 'start', '--path', '$PROJECT']);
    });
    addMenuItem(menu, 9, 'GMLoop: runner stop', 'chatgml-gmloop-runner-stop', function () {
      runProject('GMLoop runner stop', ['runner', 'stop', '--path', '$PROJECT']);
    });
    addMenuItem(menu, 10, 'GMLive: toggle bridge', 'chatgml-gmlive-bridge-toggle', function () {
      runAceCommand('gmliveBridgeToggle', 'GMLive bridge toggle');
    });
    addMenuItem(menu, 11, 'GMLive: run', 'chatgml-gmlive-run', function () {
      runAceCommand('gmliveRun', 'GMLive run');
    });
    addMenuItem(menu, 12, 'GMLive: stop', 'chatgml-gmlive-stop', function () {
      runAceCommand('gmliveStop', 'GMLive stop');
    });
    window.ChatGmlGmloop = {
      run: runProject,
      lintCurrent: function () {
        runCurrent('lint');
      },
      formatCurrent: function () {
        runCurrent('format');
      },
      liveStatus: function () {
        runProject('GMLoop live reload status', ['live-reload', 'status', '--path', '$PROJECT']);
      },
      runnerStart: function () {
        runProject('GMLoop runner start', ['runner', 'start', '--path', '$PROJECT']);
      },
      runnerStop: function () {
        runProject('GMLoop runner stop', ['runner', 'stop', '--path', '$PROJECT']);
      },
    };
    window.ChatGmlGmlive = {
      bridgeToggle: function () {
        runAceCommand('gmliveBridgeToggle', 'GMLive bridge toggle');
      },
      run: function () {
        runAceCommand('gmliveRun', 'GMLive run');
      },
      stop: function () {
        runAceCommand('gmliveStop', 'GMLive stop');
      },
    };
    GMEdit.on('projectOpen', function (e) {
      projectDirectory = e.project.dir;
    });
  }

  GMEdit.register(PLUGIN_NAME, {
    init: init,
    cleanup: function () {
      delete window.ChatGmlGmloop;
      delete window.ChatGmlGmlive;
    },
  });
})();
