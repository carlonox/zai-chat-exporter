# Contributing

Thanks for wanting to help. This extension already ships on Chrome Web Store and Firefox Add-ons, so a careless merge reaches real users.

## Before writing code

- **Open an issue first** for new features, changes to permissions, or anything that touches how conversations are parsed. It keeps us from reviewing 800 lines built on a wrong assumption.
- Typos, docs and obvious fixes: send the PR directly.

## What a PR must contain

The PR body answers four questions (the template asks):

1. **What changes** — two or three lines.
2. **Why** — the real problem, not the solution you like.
3. **How you tested it** — command, test, or manual steps. "I did not test it" is a valid answer; lying is not.
4. **Risk** — what can break and how to revert it.

Also:

- **One PR, one topic.** A refactor and a feature in the same PR review badly and revert worse.
- **Conventional Commits 1.0.0** in messages (`type(scope): imperative`, max 72 chars).
- **No secrets**: no tokens, keys or `.env` files.
- **Docs ship with the code** that needs them.
- **Versioning**: if the change is user-facing, bump the version and add a CHANGELOG entry. Merging without publishing leaves the repo and the stores out of sync.

## Tests

`npm test` runs the suite. Say what you ran. If a change affects the exported Markdown or JSON, include a fixture or a test for it.

## Review

Everything lands through a PR. An automated reviewer (Kiro) comments and publishes the `kiro-review` status; a human decides the merge.

## Licence

By opening a PR you agree that your contribution is published under the repository's licence (MIT).
