// plugin/sessions.js — multi-session history per project (Cline/Roo-style sidebar data layer).
//
// One project (keyed by projectHash) can hold MANY sessions. Each session is a separate NDJSON
// file (one turn_end record per line, capped at SESSION_MAX_TURNS) plus a sidecar metadata file
// (title, createdAt, updatedAt, messageCount) used by the sidebar. The "active" pointer is a
// per-project JSON file so a /resume or relaunch restores the last-active session.
//
// Same IIFE module pattern as state.js / markdown.js: attaches to a renderer global AND exports
// via `module.exports` so the Node-based unit tests (test/plugin/sessions.test.ts) can require()
// it directly. Same `path.join(__dirname, ...)` resolution style as chatgml.js so the renderer
// (which loads scripts via <script> tags from index.html, NOT __dirname) gets a working require.
//
// All methods are async because every disk touch is async; the legacy `listTasks()` was sync
// because it only scanned the dir, but we keep async for forward-compat (the dir scan is bounded
// by SESSION_MAX_TURNS-sized files, so an async readdir has no observable cost on the UI thread).
(function (root) {
  'use strict';

  const fs = require('fs');
  const fsp = fs.promises || require('fs').promises;
  const path = require('path');
  const crypto = require('crypto');

  // Same hashing style as chatgml.js: SHA-1 of the project dir, hex, first 12 chars. Stable across
  // OSes so the same project always maps to the same disk files. NOT used for anything security-
  // sensitive — this is just an opaque 12-char folder-friendly token.
  function projectHash(projectDir) {
    return crypto
      .createHash('sha1')
      .update(String(projectDir || 'default'))
      .digest('hex')
      .slice(0, 12);
  }

  // Resolve the session directory (parent of the per-project hash files). Matches chatgml.js's
  // SESSION_DIR constant: ~/.config/chatgml/sessions on both Windows and POSIX. Tests can
  // override via the `_chatgmlSessionDirForTests` setter to redirect to a tmpdir.
  let _sessionDirOverride = null;
  function sessionDir() {
    if (_sessionDirOverride) return _sessionDirOverride;
    const home = process.env.USERPROFILE || process.env.HOME || '';
    return path.join(home.replace(/[\\/]+$/, ''), '.config', 'chatgml', 'sessions');
  }
  // Test-only injection point. Production code never calls this; the tests use it to redirect
  // reads/writes to a fresh tmpdir so they don't trample real session files.
  function _setSessionDirForTests(dir) {
    _sessionDirOverride = dir;
  }

  // Path to a session's NDJSON file. Convention: <projectHash>-<id>.ndjson (the dash is a
  // safe separator because projectHash is hex-only and id is matched by TASK_ID_RE).
  function sessionFile(projectDir, id) {
    const h = projectHash(projectDir);
    return path.join(sessionDir(), h + '-' + (id || 'default') + '.ndjson');
  }

  // Path to a session's metadata sidecar. Same naming scheme with a .meta.json suffix.
  function metadataFile(projectDir, id) {
    const h = projectHash(projectDir);
    return path.join(sessionDir(), h + '-' + (id || 'default') + '.meta.json');
  }

  // Path to the per-project active-pointer file. There is only ONE such file per project
  // regardless of how many sessions exist; it stores `{activeId: <string>}`.
  function activeFile(projectDir) {
    const h = projectHash(projectDir);
    return path.join(sessionDir(), h + '.active.json');
  }

  // ---- Default metadata factory -----------------------------------------------------------
  // Pure: no Date.now() side effects from outside; we still call Date.now() to give a fresh
  // session a creation timestamp, but the caller can pass an override for testability.
  function defaultMetadata(id, now) {
    const ts = typeof now === 'number' ? now : Date.now();
    return {
      title: 'untitled',
      createdAt: ts,
      updatedAt: ts,
      messageCount: 0,
    };
  }

  // ---- deriveTitle ------------------------------------------------------------------------
  // Take the first non-empty user-text entry, strip newlines, truncate to ~50 chars with an
  // ellipsis. Falls back to 'untitled' if no usable text is present. Pure — no I/O, safe inside
  // a reducer or render path.
  function deriveTitle(turns) {
    if (!Array.isArray(turns)) return 'untitled';
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      if (!t) continue;
      const raw = typeof t.userText === 'string' ? t.userText : '';
      const flat = raw.replace(/[\r\n]+/g, ' ').trim();
      if (flat === '') continue;
      if (flat.length <= 50) return flat;
      return flat.slice(0, 49).trimEnd() + '…';
    }
    return 'untitled';
  }

  // ---- read/write metadata ----------------------------------------------------------------
  // Reads sidecar JSON. Missing files => null. Corrupted JSON => null (caller treats null as
  // "no metadata" and falls back to defaultMetadata). Defensive: the metadata file is the only
  // place where a single bad write could hide the whole session from the sidebar, so we are
  // strict about never throwing here.
  async function readMetadata(projectDir, id) {
    const p = metadataFile(projectDir, id);
    try {
      const text = await fsp.readFile(p, 'utf8');
      const obj = JSON.parse(text);
      if (!obj || typeof obj !== 'object') return null;
      return obj;
    } catch (e) {
      // ENOENT (no metadata yet) is the common case — return null so the caller can default.
      // Any other error (corrupt JSON, permission denied) is also "no metadata" — the sidebar
      // will fall back to derived counts from the NDJSON.
      return null;
    }
  }

  async function writeMetadata(projectDir, id, meta) {
    const p = metadataFile(projectDir, id);
    await fsp.mkdir(sessionDir(), { recursive: true });
    await fsp.writeFile(p, JSON.stringify(meta, null, 2), 'utf8');
  }

  // ---- read/write active pointer ----------------------------------------------------------
  async function readActive(projectDir) {
    const p = activeFile(projectDir);
    try {
      const text = await fsp.readFile(p, 'utf8');
      const obj = JSON.parse(text);
      if (!obj || typeof obj !== 'object') return null;
      return typeof obj.activeId === 'string' ? obj.activeId : null;
    } catch (e) {
      return null;
    }
  }

  async function writeActive(projectDir, id) {
    const p = activeFile(projectDir);
    await fsp.mkdir(sessionDir(), { recursive: true });
    await fsp.writeFile(p, JSON.stringify({ activeId: id || 'default' }, null, 2), 'utf8');
  }

  // ---- list (the workhorse) ---------------------------------------------------------------
  // Returns [{id, title, messageCount, createdAt, updatedAt, isActive}]. Robust against:
  //   - missing sessionDir (returns the default session entry only)
  //   - a corrupted metadata sidecar (skips that session; still emits the NDJSON-derived entry)
  //   - a corrupted NDJSON (skips the file)
  // The DEFAULT session is always present in the returned list, even if no NDJSON file exists,
  // so the UI never starts with an empty sidebar.
  async function list(projectDir) {
    const h = projectHash(projectDir);
    const activeId = (await readActive(projectDir)) || 'default';
    const out = new Map();
    // Ensure 'default' is always present.
    out.set('default', {
      id: 'default',
      title: 'untitled',
      messageCount: 0,
      createdAt: 0,
      updatedAt: 0,
      isActive: activeId === 'default',
    });
    let files = [];
    try {
      files = await fsp.readdir(sessionDir());
    } catch (e) {
      // sessionDir missing or unreadable — return just the default entry.
      return Array.from(out.values());
    }
    const prefix = h + '-';
    // First pass: collect NDJSON-derived counts (messageCount + lastUpdated) by session id.
    // We do this in a separate map so a second pass can pick up sessions that have ONLY a
    // metadata sidecar (freshly-created sessions, no turns yet) — those still belong in the
    // sidebar so the user sees "+ New session" actually create a row, just like Cline/Roo.
    const ndjsonCounts = new Map();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!f.startsWith(prefix)) continue;
      if (!f.endsWith('.ndjson')) continue;
      const id = f.slice(prefix.length, f.length - '.ndjson'.length);
      if (id === '' || id.indexOf('/') !== -1) continue;
      let messageCount = 0;
      let lastUpdated = 0;
      try {
        const text = await fsp.readFile(path.join(sessionDir(), f), 'utf8');
        const lines = text.split('\n');
        for (let j = 0; j < lines.length; j++) {
          const line = lines[j].trim();
          if (line === '') continue;
          try {
            const rec = JSON.parse(line);
            if (rec && typeof rec.userText === 'string' && rec.userText.trim() !== '') {
              messageCount += 1;
              if (typeof rec.ts === 'number' && rec.ts > lastUpdated) lastUpdated = rec.ts;
            }
          } catch (e) {
            /* corrupt line — skip */
          }
        }
      } catch (e) {
        // NDJSON unreadable — skip this session entirely.
        continue;
      }
      ndjsonCounts.set(id, { messageCount, lastUpdated });
    }

    // Second pass: emit one entry per discovered session id. Sources: NDJSON counts from
    // the first pass, OR a metadata sidecar if no NDJSON exists yet (freshly-created
    // sessions).
    const seen = new Set();
    for (const [id, counts] of ndjsonCounts) {
      const meta = await readMetadata(projectDir, id);
      out.set(id, {
        id: id,
        title: meta && typeof meta.title === 'string' ? meta.title : 'untitled',
        messageCount: counts.messageCount,
        createdAt: meta && typeof meta.createdAt === 'number' ? meta.createdAt : counts.lastUpdated,
        updatedAt: meta && typeof meta.updatedAt === 'number' ? meta.updatedAt : counts.lastUpdated,
        isActive: id === activeId,
      });
      seen.add(id);
    }
    // Emit metadata-only sessions (freshly-created, no turns yet). Cline/Roo surface these
    // immediately so the user sees the "+" button actually create a sidebar row. We also keep
    // a placeholder entry when the sidecar is corrupt — a miswritten JSON should never silently
    // hide a session the user explicitly created; the row falls back to "untitled" with
    // zeroed-out timestamps, which is a much nicer failure mode than invisibility.
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!f.startsWith(prefix)) continue;
      if (!f.endsWith('.meta.json')) continue;
      const id = f.slice(prefix.length, f.length - '.meta.json'.length);
      if (id === '' || id.indexOf('/') !== -1) continue;
      if (seen.has(id)) continue;
      const meta = await readMetadata(projectDir, id);
      out.set(id, {
        id: id,
        title: meta && typeof meta.title === 'string' ? meta.title : 'untitled',
        messageCount:
          meta && typeof meta.messageCount === 'number' ? meta.messageCount : 0,
        createdAt: meta && typeof meta.createdAt === 'number' ? meta.createdAt : 0,
        updatedAt: meta && typeof meta.updatedAt === 'number' ? meta.updatedAt : 0,
        isActive: id === activeId,
      });
    }
    return Array.from(out.values()).sort(function (a, b) {
      // Newest updatedAt first; ties broken by id alphabetically so the order is stable.
      if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  // ---- create -----------------------------------------------------------------------------
  // Generate a fresh id (projectHash-style: 's-' + short random hex), write a default metadata
  // sidecar, set it as active, and return the id. Does NOT touch the NDJSON (an empty session
  // has no turns yet). Idempotent: if `id` is provided AND valid AND not already on disk, reuse
  // it; otherwise mint a fresh one.
  async function create(projectDir, providedId) {
    const dir = sessionDir();
    await fsp.mkdir(dir, { recursive: true });
    let id = providedId;
    if (id && (await sessionExists(projectDir, id))) {
      // Already exists — refresh the active pointer but don't overwrite the existing NDJSON or
      // metadata. This is what `/new_task foo` followed by another `/new_task foo` should do.
      await writeActive(projectDir, id);
      return id;
    }
    if (!id) {
      // Mint a fresh id. Avoid collisions by retrying a few times.
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate =
          's-' +
          crypto
            .createHash('sha1')
            .update(String(projectDir) + ':' + Date.now() + ':' + Math.random())
            .digest('hex')
            .slice(0, 8);
        if (!(await sessionExists(projectDir, candidate))) {
          id = candidate;
          break;
        }
      }
      if (!id) {
        // Last-resort fallback: time-based id.
        id = 's-' + Date.now().toString(36);
      }
    }
    const meta = defaultMetadata(id);
    await writeMetadata(projectDir, id, meta);
    await writeActive(projectDir, id);
    return id;
  }

  // Cheap existence check: either the NDJSON OR the metadata sidecar counts as "exists".
  async function sessionExists(projectDir, id) {
    try {
      await fsp.access(sessionFile(projectDir, id));
      return true;
    } catch (e) {
      // try metadata
      try {
        await fsp.access(metadataFile(projectDir, id));
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  // ---- switchTo ---------------------------------------------------------------------------
  // Set the active pointer to `id`. Side effects: writes <projectHash>.active.json. Caller
  // (chatgml.js) is responsible for clearing the panel + resending a /resume.
  async function switchTo(projectDir, id) {
    if (!id) return;
    await fsp.mkdir(sessionDir(), { recursive: true });
    await writeActive(projectDir, id);
  }

  // ---- delete -----------------------------------------------------------------------------
  // Remove both the NDJSON file and the metadata sidecar. The 'default' session is NEVER
  // deleted (the file may not exist, but the active pointer MUST always be able to fall back to
  // it). The active pointer is updated to 'default' if it was pointing at the deleted session.
  async function _delete(projectDir, id) {
    if (!id || id === 'default') {
      const err = new Error('cannot delete the default session');
      err.code = 'ECHANNEL';
      throw err;
    }
    const targets = [sessionFile(projectDir, id), metadataFile(projectDir, id)];
    for (let i = 0; i < targets.length; i++) {
      try {
        await fsp.unlink(targets[i]);
      } catch (e) {
        // ENOENT is fine; anything else is logged but not fatal — the goal is to remove both
        // files; if one is already gone we still try the other.
        if (e && e.code !== 'ENOENT') {
          // Best-effort: swallow so delete is robust. Real errors bubble via the next attempt.
        }
      }
    }
    // If we were the active session, fall back to 'default'.
    const cur = await readActive(projectDir);
    if (cur === id) {
      await writeActive(projectDir, 'default');
    }
  }

  // ---- getActive / setActive --------------------------------------------------------------
  async function getActive(projectDir) {
    const a = await readActive(projectDir);
    return a || 'default';
  }

  async function setActive(projectDir, id) {
    if (!id) return;
    await writeActive(projectDir, id);
  }

  // ---- appendTurn -------------------------------------------------------------------------
  // Append one turn_end record to the session's NDJSON and update the metadata sidecar (bump
  // messageCount, set updatedAt, re-derive the title if it was still 'untitled'). Best-effort:
  // a write failure must never break the live panel (matches chatgml.js's appendTurn policy).
  async function appendTurn(projectDir, turn) {
    if (!projectDir || !turn) return;
    const id = (await getActive(projectDir)) || 'default';
    try {
      await fsp.mkdir(sessionDir(), { recursive: true });
    } catch (e) {
      return;
    }
    const ts = typeof turn.ts === 'number' ? turn.ts : Date.now();
    const record = Object.assign({}, turn, { ts: ts, sessionId: id });
    let writeOk = true;
    try {
      await fsp.appendFile(
        sessionFile(projectDir, id),
        JSON.stringify(record) + '\n',
        'utf8',
      );
    } catch (e) {
      writeOk = false;
    }
    if (!writeOk) return;
    // Update metadata.
    let meta = await readMetadata(projectDir, id);
    if (!meta) meta = defaultMetadata(id, ts);
    meta.messageCount = (meta.messageCount || 0) + 1;
    meta.updatedAt = ts;
    if (meta.title === 'untitled' || !meta.title) {
      // Re-derive from the just-written turn + existing sidecar turns. We re-load the NDJSON
      // and run deriveTitle — bounded at SESSION_MAX_TURNS*2 lines so this is cheap.
      try {
        const text = await fsp.readFile(sessionFile(projectDir, id), 'utf8');
        const lines = text.split('\n').filter(function (l) {
          return l.trim() !== '';
        });
        const turns = lines
          .slice(-200)
          .map(function (l) {
            try {
              return JSON.parse(l);
            } catch (e) {
              return null;
            }
          })
          .filter(function (t) {
            return t && typeof t.userText === 'string';
          });
        meta.title = deriveTitle(turns);
      } catch (e) {
        /* keep old title */
      }
    }
    try {
      await writeMetadata(projectDir, id, meta);
    } catch (e) {
      /* metadata is best-effort */
    }
  }

  // ---- loadTurns --------------------------------------------------------------------------
  // Read the NDJSON, parse, filter to valid turn records. Mirrors chatgml.js's loadSessionTurns
  // (cap to SESSION_MAX_TURNS*2 lines). Always returns [] on error.
  async function loadTurns(projectDir, id) {
    if (!projectDir || !id) return [];
    try {
      const text = await fsp.readFile(sessionFile(projectDir, id), 'utf8');
      const lines = text.split('\n').filter(function (l) {
        return l.trim() !== '';
      });
      return lines
        .slice(-200)
        .map(function (l) {
          try {
            return JSON.parse(l);
          } catch (e) {
            return null;
          }
        })
        .filter(function (t) {
          return (
            t &&
            typeof t.userText === 'string' &&
            typeof t.assistantText === 'string'
          );
        });
    } catch (e) {
      return [];
    }
  }

  // ---- updateTitle ------------------------------------------------------------------------
  // Optional helper (not in the public surface but useful for chatgml.js if it ever wants to
  // rename a session explicitly). Returns the new metadata or null on failure.
  async function updateTitle(projectDir, id, title) {
    if (!id) return null;
    const safe = String(title || '').trim();
    if (safe === '') return null;
    const meta = (await readMetadata(projectDir, id)) || defaultMetadata(id);
    meta.title = safe.length > 80 ? safe.slice(0, 79).trimEnd() + '…' : safe;
    meta.updatedAt = Date.now();
    await writeMetadata(projectDir, id, meta);
    return meta;
  }

  // ---- API surface ------------------------------------------------------------------------
  const api = {
    projectHash: projectHash,
    sessionDir: sessionDir,
    sessionFile: sessionFile,
    metadataFile: metadataFile,
    activeFile: activeFile,
    list: list,
    create: create,
    switchTo: switchTo,
    delete: _delete,
    getActive: getActive,
    setActive: setActive,
    appendTurn: appendTurn,
    loadTurns: loadTurns,
    deriveTitle: deriveTitle,
    updateTitle: updateTitle,
    // Exposed for tests only; never call from production code.
    _setSessionDirForTests: _setSessionDirForTests,
  };

  // Renderer global (for chatgml.js / panel.js).
  root.ChatGmlSessions = api;
  // CommonJS export (for the Node-based tests).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);