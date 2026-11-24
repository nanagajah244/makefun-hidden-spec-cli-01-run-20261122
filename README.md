[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/nanagajah244/makefun-hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/nanagajah244/makefun-hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend — one patch tool for every AI edit format

`mend` applies an edit an AI model wrote to a tree of text files, in four formats:
unified diff, SEARCH/REPLACE blocks, V4A patches, and JSON text-editor tool calls.
It reads a patch in one format, finds the lines each edit names at the first of
three matching tiers (exact, trailing-whitespace-insensitive, fully-trimmed with
re-indentation), and writes every change or none.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory (the root of the
  tree). Absent or `-` reads the patch from standard input.
- `--format=NAME` reads the patch as `unified`, `search-replace`, `v4a` or
  `json`; `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file is
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and PATCH may come in any order; `--` ends the options.

Exit codes: `2` for usage, unreadable-patch, undetected-format and parse errors
(one `error: ...` line); `1` when edits fail (one `error: <code> <path>` line per
failed edit, then `failed: <k> of <n> edits`, and no file is written); `0` when
the tree is written (one line per changed path — `A`, `D`, `M`, or `R <old> ->
<new>` for a move — then `ok: <n> files`).

## Requirements

Node 22 or later, standard library only. No network, no model calls.

## License

MIT — see `LICENSE`.
