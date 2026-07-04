// plugin/agent-packs.js - local installable coding-agent prompt packs.
(function (root) {
  'use strict';

  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const BUILTIN_PACKS = [
    {
      id: 'ponytail',
      name: 'Ponytail',
      kind: 'agent-pack',
      description: 'Smallest correct code change: stdlib first, no speculative abstractions.',
      prompt:
        'Use Ponytail mode: make the smallest correct change, prefer existing code and platform features, and call out anything intentionally skipped.',
    },
    {
      id: 'superpowers',
      name: 'Superpowers',
      kind: 'agent-pack',
      description: 'Spec/plan/check workflow for larger coding tasks.',
      prompt:
        'Use the Superpowers workflow: clarify the target, keep a short implementation plan, make focused edits, and verify with concrete checks.',
    },
    {
      id: 'cline-roo',
      name: 'Cline/Roo style',
      kind: 'agent-pack',
      description: 'Plan/Act/Review coding assistant behavior with explicit context and changes.',
      prompt:
        'Work like a Cline/Roo coding agent: state the plan, use project context and tools, propose concrete edits, then summarize tests and remaining risk.',
    },
    {
      id: 'gmedit-gml',
      name: 'GMEdit GML',
      kind: 'agent-pack',
      description: 'GameMaker-focused review/debug/edit behavior.',
      prompt:
        'Use the GMEdit GML pack: inspect current object/event context, prefer safe GML edits, mention missing resources/events, and include GMEdit/GMLoop checks when useful.',
    },
  ];

  function userDir() {
    if (process.env.CHATGML_AGENT_PACKS_DIR) return process.env.CHATGML_AGENT_PACKS_DIR;
    if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'chatgml', 'agent-packs');
    if (process.platform === 'win32' && process.env.APPDATA) {
      return path.join(process.env.APPDATA, 'chatgml', 'agent-packs');
    }
    return path.join(os.homedir(), '.config', 'chatgml', 'agent-packs');
  }

  function packById(id) {
    return BUILTIN_PACKS.find(function (p) {
      return p.id === id;
    });
  }

  function installedIds(dir) {
    const out = Object.create(null);
    const base = dir || userDir();
    try {
      const files = fs.readdirSync(base);
      for (let i = 0; i < files.length; i++) {
        if (!/\.json$/i.test(files[i])) continue;
        try {
          const raw = fs.readFileSync(path.join(base, files[i]), 'utf8');
          const json = JSON.parse(raw);
          if (json && typeof json.id === 'string') out[json.id] = true;
        } catch (_) {
          /* ignore one bad manifest */
        }
      }
    } catch (_) {
      /* no installed packs yet */
    }
    return out;
  }

  function listPacks(dir) {
    const installed = installedIds(dir);
    return BUILTIN_PACKS.map(function (p) {
      return Object.assign({}, p, { installed: !!installed[p.id] });
    });
  }

  function installPack(id, dir) {
    const pack = packById(id);
    if (!pack) throw new Error('unknown agent pack: ' + id);
    const base = dir || userDir();
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(
      path.join(base, pack.id + '.json'),
      JSON.stringify(
        {
          id: pack.id,
          name: pack.name,
          description: pack.description,
          prompt: pack.prompt,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    return Object.assign({}, pack, { installed: true });
  }

  const api = { BUILTIN_PACKS, userDir, listPacks, installPack, installedIds };
  root.ChatGmlAgentPacks = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
