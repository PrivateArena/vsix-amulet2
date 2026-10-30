# PROJECT_OVERVIEW — vsix-amulet2

Stage: **fork is in place** — this directory now *is* the fork. It contains a full clone of **Pintra**
(`bilalbentoumi/pi-vsc` v1.0.5) at the repo root, ready to be developed into **Amulet**, the
open-source VS Code coding-agent extension.

## Decision (2026-10-30, supersedes the 2026-10-30 morning entry)

Fork **Pintra** (`bilalbentoumi/pi-vsc`). Chosen empirically, by running all candidates, over
`kaiwood/vscode-tauren` (previous recommendation) and over `Printaga/PiLot`:

- **Only candidate with a real editor-tab chat frontend**, not sidebar-only — the sidebar webview caps
  the conversation at panel width, which is the deciding usability factor.
- **No SDK pin**: it drives an external `pi --mode rpc` child process over stdio JSON-lines, so the
  `0.80.10 → 1.4.0` migration spike that gated the tauren option does not apply. Verified clean against
  installed `pi` 1.4.0.
- Small and clean: ~4.4k TS/TSX LOC, esbuild two-target build, React 18 + zustand + sass, vitest.

`docs/fork-evaluation.md` is retained as the historical comparison of the five earlier candidates.

## Status

Build is green from a clean tree: `pnpm typecheck`, `pnpm build`, `pnpm test` (22 tests),
`pnpm package` → `pi-vsc-1.0.5.vsix`. Requires **pnpm 10**. Full provenance, drift analysis and the
next-session task list: **`docs/pintra-fork.md`** — read that first.

## Layout

```
DRAFT.md                  original brief (sidebar/fork decision)
PROJECT_OVERVIEW.md       this file
docs/fork-evaluation.md   historical 5-way comparison (superseded)
docs/pintra-fork.md       provenance · verified baseline · pi 1.4.0 drift · open tasks
LICENSE                   added by us; upstream declared MIT but shipped no file
<upstream tree>           src/ webview/ shared/ media/ esbuild.mjs package.json ...
```

Our notes (`DRAFT.md`, `PROJECT_OVERVIEW.md`, `docs/`) live alongside upstream code but never inside it,
so `git merge upstream/main` stays clean.

## Remotes

`upstream` → `https://github.com/bilalbentoumi/pi-vsc` (fetch/merge fixes from here).
No `origin` yet — the GitHub-side fork under `gunir` has not been created.

## Hard constraint carried over from vsix-amulet

`../vsix-amulet/extension/` is under an EULA: study only, never copy. Behaviour and contracts may be
recovered from it; its JavaScript may not. Pintra is MIT — a separate, permitted lineage. Keep the two
distinguishable in commit messages.
