# Plugin troubleshooting

This file covers the failure modes a GMEdit user is most likely to hit and how to diagnose
them. The GMEdit plugin (`plugin/`) and the two companion plugins (`plugin-inline/`,
`plugin-explain/`) all spawn `chatgml serve` as a child process and speak NDJSON over its
stdio — so almost every "plugin does nothing" symptom traces back to one of three things:

1. **The binary can't be found.**
2. **The handshake never arrives.**
3. **A protocol line is malformed.**

Read this top-to-bottom — the same diagnostic checks for each.

## "ChatGML" context-menu entry is missing entirely

The plugin loaded but `GMEdit.register` never wired the menu. This is a plugin-load failure,
not a runtime failure. Open **GMEdit → Tools → Open User Plugins Folder** and confirm:

1. `chatgml/`, `chatgml-inline/`, `chatgml-explain/` (one, two, or all three) are symlinked
   under `%APPDATA%/AceGM/GMEdit/plugins/`.
2. The symlink target exists (`mklink /D "chatgml" "C:\path\to\ChatGML\plugin"`).
3. The plugin dir contains a `config.json` with the correct `name` field matching the
   directory name.

The two companion plugins **silently no-op if `../chatgml/state.js` cannot be loaded** — they
warn to the console but no UI is shown. Check the GMEdit devtools console (`View → Toggle
Developer Tools → Console`).

## "Failed to resolve the chatgml executable"

`plugin/state.js`'s `resolveServeBinary` returns a structured `argvPrefix + cmd` (see the
file's ladder of fallbacks: explicit Preference → `CHATGML_BIN` → win32 npm `.cmd` shim →
bundled `<pluginDir>/dist/cli.js` → `node + <pluginDir>/dist/cli.js`).

When NONE resolve, the plugin throws `chatgml executable not found`. Fix by **either**:

1. Setting `CHATGML_BIN` in the user-global env (so Electron's renderer can `spawn` it):
   ```
   setx CHATGML_BIN "C:\path\to\chatgml.cmd"
   ```
   (Restart GMEdit after setting this.)

2. Or building the core so the bundled path works:
   ```
   cd C:\path\to\ChatGML
   npm ci && npm run build
   ```
   The plugin then spawns `node <plugin-dir>/dist/cli.js serve <project-dir>`.

3. Or using the *ChatGML binary path* plugin Preference (Plugins → ChatGML → Preferences).

The companion plugins (`plugin-inline/`, `plugin-explain/`) hardcode `nodePath: 'node'` —
they assume the system `node` is on `PATH`. If Electron-bundled Node is the only Node on the
system, the spawn fails with `ENOENT node`. Install Node system-wide or set
`CHATGML_BIN` to an absolute path.

## The plugin loads but never opens

After `start()`, the plugin waits for the `status:ready` handshake before enabling Send /
Reindex / Approve buttons. If the handshake never arrives:

1. Check GMEdit devtools console — there should be a `ChatGML core heartbeat timeout` after
   60s, then the Send button stays disabled.
2. Run the core manually to see the actual error:
   ```
   chatgml serve C:\path\to\project
   ```
   The session should print `status:ready` and then wait for NDJSON on stdin.
3. If `chatgml serve` errors with `missing required config field 'chat.baseURL'` — your user-global
   config is missing. Run `chatgml config show` to verify, then `chatgml config set chat.baseURL …`
   (or pass `--chat-base-url` to the CLI).
4. If the session hangs on the embedding endpoint — the chat lane works but the embed lane
   doesn't. Same fix: `chatgml config set embed.baseURL …` and `embed.model`.

## "Child died with code N" / "Spawn failed"

The plugin's `NdjsonClient` logs to devtools console. Common causes:

- **code 1**: the core exited with an unhandled error (look for `stderr` lines). Often a
  malformed `~/.config/chatgml/config.json` (use `chatgml config show` to validate).
- **code 7 (EINVAL on POSIX)**: `.cmd` shim on Windows without `cmd.exe /c` wrapping. The
  plugin handles this automatically (see `wrapCmdForWindows` in `plugin/child-process.js`) —
  if you see EINVAL, your symlink probably points at a path that bypasses the wrapper.
- **code 127**: `node` not on PATH (companion plugins only).
- **EPIPE**: you wrote to stdin after the child closed it. The plugin guards against this;
  if you see it, the protocol is desynced.

## Approve / Reject does nothing

The plugin renders an EditProposal overlay for `edit_proposal` events. Approve/Reject
fire `{type:'approve', id}` / `{type:'reject', id}` on stdin. If clicking does nothing:

1. Open devtools → Network / Console — the message should appear in the stdout stream.
2. The proposal id must match — `state.js`'s `matchApproval(req, pendingProposals)` is a
   strict `Map.get(req.id)`. A stale id (e.g. the model re-proposed) needs a fresh `approve`.
3. If the file on disk didn't change after approve, the write probably failed — check
   stderr for `sandbox_escape` or `cannot read file to patch`.

## Inline plugin: Accept/Reject overlay shows no buttons

`plugin-inline/inline.js`'s `showOverlay` now wires Accept/Reject handlers **synchronously**
when the overlay is created (no `setTimeout` race). If the overlay is empty:

1. Confirm `edit_proposal` arrived: devtools → look for the event in the stdout stream.
2. Confirm the proposal `id` is preserved through the Accept click — the click handler sends
   `{type:'approve', id}` with the same id.

## Reading the protocol manually

The wire is one JSON object per line. To debug, redirect the core's stdio:

```bash
# Save what the plugin sends and receives
chatgml serve C:\path\to\project | tee chatgml-session.ndjson
# Then in another shell, send:
{"type":"user","text":"hello"}
```

For the full schema see [docs/agent-api.md](agent-api.md).

## Clearing a stuck session

If a tool call is stuck waiting for approval, send a `cancel`:

```bash
echo '{"type":"cancel"}' | chatgml serve C:\path\to\project
```

The core will emit `status:cancelled` and `error{aborted}` and exit 0.

## Reporting a plugin bug

If you can't resolve with the above:

1. Reproduce with `chatgml serve <dir> | tee session.ndjson` and capture the session.
2. Capture `chatgml config show` output (with secrets redacted).
3. Capture the GMEdit devtools console log (View → Toggle Developer Tools).
4. Open an issue with all three attached.
