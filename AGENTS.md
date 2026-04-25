# AGENTS.md

This project uses [`CLAUDE.md`](CLAUDE.md) as the canonical session
router for **all** AI agents — Claude Code, Cursor, Codex, and anything
else that reads markdown at the repo root. Read it first.

Pattern-pinned guidance for specific files lives in
[`.cursor/rules/`](.cursor/rules/). Repo-shared skills (file a bug,
rebase a PR, add an ADR) live in [`.cursor/skills/`](.cursor/skills/).
Both are loaded automatically by Cursor and serve as repo-canonical
instructions for any agent that supports the format.

If you're not sure where to start: read `CLAUDE.md`, then
[`compass.md`](compass.md) for current state.
