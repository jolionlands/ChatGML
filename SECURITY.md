# Security

This file describes what ChatGML does and does NOT defend against, and how to report a
vulnerability.

## Threat model

ChatGML is an agentic coding assistant that runs on a developer machine, talks to an
OpenAI-compatible chat endpoint + a separate embedding endpoint + optionally a remote memory
service, and writes edits to a project directory. The trust boundary is:

- **Trusted**: the user running the CLI; the local filesystem inside the project root; the chat
  endpoint and its API key (assumed TLS-protected; secrets never written to repo files).
- **Untrusted**: the contents of files inside the project root; the output of `grep` /
  `read_file` / `search_code`; any user message; any MCP tool input/output.

## Defenses in place

### Edit sandbox (single chokepoint: `src/tools/sandbox.ts`)

Every fs-touching tool routes through `assertInsideRoot` (lexical, fs-free) and
`resolveInsideRoot` (realpath-validated deepest existing ancestor + re-check containment).
The rejections are intentionally strict:

- `..` traversal escaping the root
- absolute paths that resolve outside the root
- UNC paths (`\\server\share`)
- Win32 device prefixes (`\\?\`, `\\.\`)
- drive-relative paths (`C:foo`)
- NTFS alternate-data-stream paths (`file.gml:hidden`)

Writes go through `safeWriteFileInRoot`: realpath parent re-validated, `lstat` rejects
overwriting a symlink leaf, and a randomly-named temp file is `rename`d onto the leaf
(atomic, no cross-dir move, no partial file ever visible).

### Approval gate (single chokepoint: `src/agent.ts`)

`apply_patch` and `search_replace` and `execute_command` are gated by the agent's
`ApprovalGate`. The gate:

- emits `edit_proposal` (with the diff) and `approval_request` to the client in `gated` mode;
  the client's `approve`/`reject` resolves the pending promise.
- supports a per-tool override (`Config.toolApproval`) and a per-request `policy` (so MCP /
  inline tools can opt into stricter gating without breaking other tools).
- has a **destructive-edit backstop** (GAP4): in `auto` mode, a high-risk diff (whole-file
  rewrite / mass deletion) still asks a human. Small additive in-place edits auto-apply as
  before.

### Secret handling

- API keys live in env vars (or `env:NAME` references); the CLI's `config set` refuses to write
  a literal secret to disk (`SECRET_FIELD_PATHS` in `src/config.ts`).
- Error bodies are key-scrubbed before they leave the process (`scrubBody` in `src/http.ts` —
  removes `Bearer …` and `sk-…` patterns).
- LLM error messages truncate bodies to 2 KB so a hostile upstream can't pad a response with a
  secret.

### Untrusted project config (`.chatgml.json`)

The project-local config file is **UNTRUSTED**:

- may NOT set `approval:'auto'` (forces a prompt for every edit)
- may NOT set per-tool `toolApproval` (forces the global default)
- may NOT override a `chat.baseURL` / `embed.baseURL` / `memory.hippo.url` while the
  matching key resolves from `env:` (SSRF / key-exfiltration defense)

Pass `--trust-project-config` to opt in (you take responsibility for what the file contains).

### Prompt-injection defense (GAP4)

- The system prompt declares tool/file/search content to be UNTRUSTED DATA, never
  instructions; edits require an explicit user request.
- A "destructive edit" instruction embedded in a file content (e.g. a comment saying "apply
  this patch" or "ignore previous instructions") is **not enough** to bypass the approval
  gate — even in `auto` mode, a high-risk edit goes through human approval.

### MCP server (chatgml mcp)

- **Mode-filtered tool surface**: `ask` mode omits `apply_patch` / `execute_command` /
  `search_replace` from `tools/list`, so a model in read-only mode can't even see the tool.
- **`requestApproval: () => true`** — the agent IDE owns the human gate. Documented in
  `src/mcp.ts` and the protocol docs.
- **`forceGate` warning surface** — when a destructive edit auto-applies in MCP mode, the
  warning is appended to the tool result text so the agent IDE can show it to the user.

### Output handling

- **`apply_patch` writes are sandboxed + checkpointed** before overwrite
  (`.chatgml/checkpoints/<id>.orig`), so `chatgml mcp`'s `undo` command can roll back.
- The protocol is **NDJSON over stdio** with a one-line-per-event wire shape. A malformed
  inbound line emits ONE `error` event and the loop continues (one bad line never crashes
  the session).

## Out of scope / known limitations

We do NOT defend against:

- **A malicious chat endpoint.** The chat endpoint can choose to leak your code, refuse to
  follow your request, or return misformatted JSON. We scrub known secret patterns but cannot
  scrub arbitrary data leaks. Use a trusted provider (or self-host).
- **A malicious embedding endpoint.** Same caveat — an embedding endpoint that returns biased
  vectors can steer the model toward attacker-chosen content. We do not validate cosine
  similarity distributions.
- **A malicious MCP server.** `wrapMcpTools` trusts the MCP server's input schema and
  description. A hostile server can advertise a tool whose description tries prompt-injection.
  The system prompt's "untrusted content" clause is the only defense — there is no
  schema-level sandbox for arbitrary MCP tool outputs.
- **Side-channel exfiltration via token timing.** We don't pad responses.
- **Multi-user / multi-tenant scenarios.** ChatGML assumes a single developer on a single
  machine. Concurrent `chatgml index` runs against the same scope will clobber each other.

## Reporting a vulnerability

Email **security@…** (TODO: set up an actual security inbox before the first tagged
release). Please include:

1. The version (`chatgml --version`).
2. The OS + Node version (`node --version`).
3. Reproduction steps — minimal `chatgml` command, plus any config or env.
4. Expected vs actual behavior.

We will acknowledge within 2 business days and aim to patch within 7 days for high-severity
issues. Please do not file public GitHub issues for suspected vulnerabilities — coordinated
disclosure first.

## Audit history

- **2026-06-25** — Initial security review (M7 milestone). See
  `docs/superpowers/plans/2026-06-24-chatgml-implementation-plan.md` for the audit
  resolutions captured during the rewrite.
- **2026-06-28** — Post-rewrite hardening pass (this work). Fixes:
  - MCP `tools/list` now mode-filtered (was advertising `apply_patch` in `ask` mode).
  - MCP `forceGate` warnings now surfaced to the tool result (were silently dropped).
  - Hermetic CLI/config tests (were silently loading the developer's real config).
  - `plugin/legacy/` removed (was a known-insecure Python-era plugin still checked in).
