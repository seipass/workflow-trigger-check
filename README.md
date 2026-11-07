# Find CI triggers that can never fire: branch filters naming branches that don't exist

A workflow filter that names a branch, a path, a job or a local action the
repository does not have is valid YAML, passes `actionlint`, and simply never
runs. This checks those names and nothing else: no expressions, no `if:`, no
permissions, no version currency. Every finding is "this name is not present in
what we looked at" - the checkout, or the branch list you supplied - and it names
what we looked at, so you can refute it in one click.

Measured on 21 public repositories, with this tool's own parser:

| check | repositories with a finding |
|---|---|
| `branch-filter` | 2 of 21 (5 findings) |
| `path-filter` | 1 of 21 (1 finding) |
| `needs-target` | 0 of 21 — kept for completeness |
| `local-uses` | 0 of 21 — kept for completeness |

**3 of 21 repositories produced any finding at all.** The headline above is the
check that actually fires; the two zero-yield checks are decidable and cheap,
not common.

Run it in one command:

```bash
npx --yes github:seipass/workflow-trigger-check#v0.1.2 .
```

A fresh tarball has no branch list, so branch filters print a skip reason rather
than a finding; pass `--branches` (see below) to enable them.

## What it looks like

Real output, run against a real public repository
([`trpc/trpc`](https://github.com/trpc/trpc), 191 branches at the time of the
run; the branch list is what makes branch findings possible):

```
3 trigger names name something that does not exist.
10 workflows read in 1920 files.

branch-filter .github/workflows/main.yml:7
              push.branches names branch "next", which does not exist in this repository
```

Falsify it:

```bash
git ls-remote --heads https://github.com/trpc/trpc | grep -c 'refs/heads/next'   # 0: the branch is not there
```

## Run it from a clone

```bash
git clone https://github.com/seipass/workflow-trigger-check
cd workflow-trigger-check
node bin/workflow-trigger-check.js .
```

With no flags it reads `.github/workflows/*.yml`, every branch name it can find
in a local clone, and the repository's file list. Exit code is `0` when nothing
dangles and `2` when something does.

Branch checks need a complete branch list. From a shallow or local-only clone we
cannot prove a branch is missing, so the check prints a reason and does nothing;
supply one explicitly to enable it:

```bash
git ls-remote --heads https://github.com/OWNER/REPO | sed 's#.*refs/heads/##' > branches.txt
node bin/workflow-trigger-check.js . --branches branches.txt
```

## What each check asks

| check | question |
|---|---|
| `branch-filter` | a literal branch in `branches` / `branches-ignore` does not exist |
| `path-filter` | the static prefix of a `paths` / `paths-ignore` entry does not exist |
| `needs-target` | a job `needs:` a job that is not in the same workflow |
| `local-uses` | `uses: ./...` names a workflow/action file the repo does not have |

Glob branch filters (`release/**`), negated entries (`!main`) and filters whose
static prefix exists are never reported — see the limits below.

## What this cannot see

- **An expression.** `branches: ${{ ... }}`, `if:` conditions, matrix values and
  reusable-workflow inputs are skipped, never guessed.
- **Glob semantics.** For `paths`, only the text before the first `*`, `?` or
  `[` is checked. If that prefix exists, nothing is reported even when no file
  matches the full glob — a claim about GitHub's matching rules, which this tool
  does not model. For `branches`, any entry containing a glob character is
  skipped, because a literal-name check cannot judge a pattern.
- **Whether a workflow runs.** A filter whose names resolve can still be dead
  for reasons this tool does not model. "Nothing dangling" is not "CI works".
- **Remote state.** A branch that exists on the remote but not in your clone is
  reported only if you gave a list that is missing it. With no list, branch
  checks are skipped.
- **Semantics of the workflow itself.** No action versions, no permissions, no
  secrets, no runner labels, no expression typing.
- **Reusable workflows in other repositories.** `uses: owner/repo/...` is a
  remote reference; only local `./` paths are checked.
- **Writing anything.** There is no write path in this package; output and
  suggested fixes are printed only.

## Exit codes and `--json`

| code | meaning |
|---|---|
| 0 | nothing dangling |
| 2 | findings |
| 1 | usage error, or a workflow this tool cannot read (the message says it is our parser) |

`--json` emits:

```jsonc
{
  "ok": true,
  "version": "0.1.2",
  "findings": [{ "check": "branch-filter", "file": ".github/workflows/main.yml", "line": 7, "subject": "next", "detail": "..." }],
  "skipped": [{ "check": "branch-filter", "reason": "... no branch list available ..." }],
  "summary": { "workflows": 10, "findings": 3, "by_check": { "branch-filter": 3 }, "branches_known": 191 },
  "exit": 2
}
```

`--fail-on <checks>` narrows which checks fail the run; `--fail-on none` never
fails.

## Development

```bash
npm test                     # node --test, no dependencies
node tools/sweep.mjs         # re-measure the table above (network + gh auth)
```

Upstream semantics this tool depends on are only the documented workflow file
format; there is no product algorithm being modelled. The claims in this README
are listed with the command that reproduces each one in `CLAIMS.md`.

## CI

`.github/workflows/ci.yml` runs the suite on `ubuntu-latest` and
`windows-latest` with Node 20 and 24.

MIT licensed.
