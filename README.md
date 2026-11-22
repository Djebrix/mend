# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Djebrix/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Djebrix/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

A CLI patch tool that applies an edit an AI model wrote to a tree of text files — deterministically, atomically, and with no dependencies. Node 22+ standard library only, no network.

Four patch formats: unified diffs (with wrong line numbers tolerated), `SEARCH/REPLACE` blocks, V4A patches, and JSON tool-call edits (`create`, `str_replace`, `insert`). Matching runs in three tiers — exact, trailing-whitespace-insensitive, then fully whitespace-insensitive with re-indentation — and `--strict` pins it to exact matches. Every file is changed or nothing is: a failed edit is reported and no file is written.

Practice score: **100/100** (score 1000) on the kit's practice set, and 100/100 on each of trial-0, trial-1, and trial-2.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```
