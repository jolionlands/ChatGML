# GitHub workflow files

This directory contains the GitHub Actions workflows for ChatGML.

## `ci.yml`

The single CI gate. Runs `npm run ci` on every push and PR across the
`[windows-latest, ubuntu-latest] × [node 24.x, 25.x]` matrix. Includes:
format check, typecheck, oxlint, build, vitest coverage.

`concurrency:` cancels in-progress runs on the same branch+PR so a stale
push doesn't burn runner minutes.

## `python-publish.yml.disabled`

**DISABLED.** Renamed from `python-publish.yml` so GitHub won't pick it up.

This is a leftover from the Python-era `talk_codebase` package. The
TypeScript rewrite (`v0.1.0` and later) supersedes it. We keep the file
in the tree (rather than deleting it) so the migration history is
auditable, but the `.disabled` suffix prevents any accidental publish.
Delete it once the audit trail is no longer useful.

## Local equivalents

There's no local equivalent of these workflows. Run the same gate with:

```bash
npm run ci
```
