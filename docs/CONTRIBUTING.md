# Contributing — docs rules

Four rules. Read once, follow always. These apply to humans *and* to AI
sessions drafting doc changes. The longer version of "why" lives in
`../CLAUDE.md` § Documentation rules.

---

## 1. AI drafts, humans ratify

If a markdown file is checked in, a human has read it line-by-line and
can defend every claim in it. Unread AI output does not land in the
`docs/` tree. When AI drafts a new doc, the commit sha and a one-line
"reviewed 2026-MM-DD by " are reasonable proof of step-through,
but the actual bar is: can a reviewer answer "why is this sentence here"
for every sentence?

## 2. Docs describe *why* + *what would change this decision*

Not *what the code does*. The code does that, faster and more
accurately than prose. Paraphrases of code go stale the moment the
code changes, and they waste tokens on every future AI turn that
ingests the docs tree as context.

Good doc content:

- "We chose subject-batch search over per-course search because the
 handshake cost dominates for N ≥ ~30 courses. Reversible by reverting
`searchCoursesBySubjects`." (decision + rollback path)
- "Banner returns meeting-time data on online sections; the conflict
 detector needs to check the `online` flag explicitly." (invariant
the code alone cannot convey)

Bad doc content:

- "`searchCoursesBySubjects` calls `fetch(url)` in a loop." (code narrates itself)
- "The function returns a map." (refer to the signature)

## 3. No end-of-task narrative docs

Commit messages exist. A change that ships does not also need a
"here's what I did" markdown file. If something is worth
preserving:

- A locked-in decision → append to `decisions.md`.
- A bug with a non-obvious failure mode → new
 `bugN-{short-name}-diagnosis.md`, mark "closed" when fixed, keep as
historical record.
- A phase / feature design → `{name}-rfc.md`.

Anything else that doesn't fit these buckets should probably be a
commit message, a code comment, or a Slack / chat message — not a new
doc.

## 4. Every new doc must be linked from `README.md` or `CLAUDE.md`

Unindexed docs are dead docs. When you create a new doc, update
`docs/README.md` (or `../CLAUDE.md` § File map, if it's describing
extension runtime code) in the same commit. If it doesn't appear in
one of those two indices, it gets GC'd the next time someone cleans up
stale docs, and no one will notice.

---

## Where new docs go (quick reference)


| You want to write…                            | It goes in…                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| An architectural decision                     | Append to `[decisions.md](decisions.md)`. **Never start a new file for a decision.**                                                 |
| A bug postmortem + fix plan                   | New `bugN-{short-name}-diagnosis.md`. Mark `Status: ✅ Closed` or `🟡 Deferred` in the header.                                        |
| A phase / feature RFC                         | New `{name}-rfc.md`.                                                                                                                 |
| Per-module "why this code is shaped this way" | Top-of-file comment in the module itself — not a standalone doc. See `extension/requirements/wildcardExpansion.js` for the template. |
| Anything else                                 | Ask for review before creating it. No exceptions.                                                                                    |
