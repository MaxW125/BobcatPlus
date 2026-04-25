# Bobcat Plus

Chrome extension for Texas State students. Reads your DegreeWorks audit
and live Banner registration data, shows what you still need to graduate,
and builds conflict-free schedules from open sections — with a small
deterministic solver framed by LLM intent / affinity / rationale stages.

This is a four-person student project. The Chrome Web Store listing is
the stable build; everything else is a work in progress.

---

## Try it locally

1. Clone this repo.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**.
3. Pick the `extension/` directory in the repo. The extension shows up in
   the toolbar.
4. Sign into Texas State (Banner / DegreeWorks) when prompted. The extension
   reuses the same session.

## Run the tests

```sh
node tests/unit/run.js
```

Default suite runs in Node, no API key required. Optional intent goldens
need an OpenAI key:

```sh
OPENAI_API_KEY=… node tests/intent-fixture.js
```

## Branch model

- `main` — stable, ships to the Chrome Web Store.
- `Demo` — external demos.
- Feature branches → PR into `main`. Put the SCRUM key in the PR title
  (e.g. `[SCRUM-35] Graph-native solver`).

## Where to look next

- Curious about the codebase? Start with [`CLAUDE.md`](CLAUDE.md) — it's
  the AI session router but it's also the fastest map for humans.
- Doc tree: [`docs/README.md`](docs/README.md).
- Live status / current phase: [`compass.md`](compass.md).
- Tracker: [Bobcat Plus on Jira](https://aidanavickers.atlassian.net/browse/SCRUM).

For AI agents (Cursor, Claude Code, Codex): read
[`AGENTS.md`](AGENTS.md) first.
