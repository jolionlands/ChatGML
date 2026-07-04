# GMLoop Integration Plan

ChatGML should treat GMLoop as the GameMaker-specific analysis/refactor layer, not as a replacement
for the agent core. GMLoop owns GML parsing, formatting, lint diagnostics, semantic graph checks,
refactor codemods, live-reload helpers, and MCP packaging. ChatGML owns model routing, approvals,
conversation state, edit proposals, sessions, and the GMEdit workbench UI.

## Current Bridge

- ChatGML detects a GMLoop install in Diagnostics.
- Detection checks `CHATGML_GMLOOP_BIN`, `CHATGML_GMLOOP_DIR`, a sibling `../GMLoop` checkout, a
  built `src/cli/dist/index.js`, and a `gmloop` binary on `PATH`.
- `/gmloop` reports the detected status and the safe commands exposed by the bridge.
- `/gmloop lint`, `/gmloop format-check`, `/gmloop graph-doctor`, and `/gmloop parse` run read-only
  commands with fixed argv lists, capped output, and a 120s timeout.
- Lint and format target the current open `.gml` file by default.
- `/gmloop lint-project` and `/gmloop format-project` are explicit slower project-wide checks.
- No write-mode GMLoop command is executed, so there are no silent write paths.

## Next Safe Tools

Promote the renderer slash commands into core tools:

- `gmloop_lint`: `gmloop lint <project>` for diagnostics only.
- `gmloop_format_check`: `gmloop format --path <project>` (read-only unless `--write` is passed).
- `gmloop_graph_doctor`: `gmloop graph doctor --path <project>`.
- `gmloop_parse_file`: `gmloop parse --path <file.gml>`.

Each promoted tool should:

- refuse to run until Diagnostics says GMLoop is ready;
- use a fixed argv list, never shell-built strings;
- cap output and timeouts;
- redact paths/secrets in plugin Diagnostics;
- show stderr/stdout in a collapsed transcript block;
- stay read-only by default.

## Approval-Gated Writes

After read-only checks are reliable, add write-capable actions behind ChatGML approval:

- `gmloop_lint_fix`: `gmloop lint <project> --write`.
- `gmloop_format_write`: `gmloop format <project> --write`.
- `gmloop_refactor_codemod`: list first, then apply selected codemods with approval.
- `gmloop_fix`: `gmloop fix --path <project> --write`.

These should create a ChatGML checkpoint before execution and surface a Changes section with
Apply/Reject/Undo just like normal edit proposals.

## UI Hooks

- Show GMLoop readiness in Diagnostics.
- Add compact workbench actions once the tools exist: Lint, Format Check, Graph Doctor.
- Add `@problems` context backed by latest GMLoop lint output.
- Prefer GMLoop parse/semantic results when explaining current-file GML warnings.
