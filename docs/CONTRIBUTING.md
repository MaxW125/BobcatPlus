# Contributing — docs

Three rules. Short version lives in [`../CLAUDE.md`](../CLAUDE.md).

## 1. A human reads what's committed

If a markdown file is checked in, someone read it line-by-line and can
answer "why is this sentence here" for every sentence. AI drafts are
fine; unread AI output isn't.

## 2. Docs explain *why*, not *what*

The code already says what it does. Docs are for the things the code
can't say on its own:

- Decisions and the path back ("we chose X over Y because… reversible
  by reverting commit `abc1234`").
- Invariants the code depends on but doesn't enforce ("Banner returns
  meeting times on online sections; the conflict detector checks the
  `online` flag explicitly").

Paraphrasing the code in prose goes stale on the next refactor and
costs tokens on every AI session. Don't.

## 3. New docs are linked

When you add a markdown file, link it from [`README.md`](README.md) or
[`../CLAUDE.md`](../CLAUDE.md) in the same commit. Unindexed docs are
dead docs.

---

## Where new docs go (quick reference)

| You want to write… | It goes in… |
| --- | --- |
| An architectural / product decision | Append to [`decisions.md`](decisions.md). Don't start a new file. |
| An open bug diagnosis (non-obvious failure mode) | New `bugs/scrum-{N}-{slug}.md`. When closed, `git mv` to `postmortems/`. |
| A phase / feature design | New `plans/{name}.md`. |
| Per-module "why this code is shaped this way" | Top-of-file comment in the module. See `extension/requirements/wildcardExpansion.js`. |
| Anything else | Probably a commit message or a chat message, not a doc. |
