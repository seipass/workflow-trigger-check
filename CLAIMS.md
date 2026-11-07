# Claims

Every public claim about behaviour, with the command that reproduces it and the
output that confirms it. Reviewers check this table instead of re-reading prose;
when the tool changes, a claim that no longer reproduces is a failing row, not a
judgement call.

Commands assume the repository root. `--branches`/`--tree` files are produced by
`tools/sweep.mjs` (cached under `tools/cache/`), so these rows are reproducible
offline once that has run once.

| # | claim (as stated in README) | command | expected |
|---|---|---|---|
| 1 | finds branch filters naming branches that do not exist | `node bin/workflow-trigger-check.js tools/cache/trpc__trpc --branches tools/cache/trpc__trpc/.branches.json --tree tools/cache/trpc__trpc/.tree.json --json \| node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).findings.map(f=>f.check).join(',')))"` | `branch-filter,branch-filter,branch-filter` |
| 2 | a real branch that exists is not reported | `gh api 'repos/trpc/trpc/branches?per_page=100' --jq '.[].name' \| grep -cx main` | `1` (and `main` appears in no finding) |
| 3 | the sample's `next` branch really is absent | `gh api 'repos/trpc/trpc/branches?per_page=100&page=1' --jq '.[].name' \| grep -cx next` | `0` (page 2 also 0; 191 branches fetched by the sweep) |
| 4 | path filters are checked at their static prefix, not as globs | `node bin/workflow-trigger-check.js tools/cache/supabase__supabase --tree tools/cache/supabase__supabase/.tree.json --json > o.json && node -p "JSON.parse(require('fs').readFileSync('o.json','utf8')).findings.filter(f=>f.check==='path-filter').map(f=>f.subject).join()" && rm o.json` | `apps/www/next.config.js` |
| 5 | that path really does not exist while its directory does | `gh api repos/supabase/supabase/contents/apps/www/next.config.js` | `404` |
| 6 | without a complete branch list, branch checks are skipped, not guessed | `printf 'null' > b.json && node bin/workflow-trigger-check.js tools/cache/calcom__cal.com --branches b.json --tree tools/cache/calcom__cal.com/.tree.json --json > o.json && node -p "const p=JSON.parse(require('fs').readFileSync('o.json','utf8')); p.findings.length + ' findings, ' + p.skipped.filter(s=>s.check==='branch-filter').length + ' skipped'" && rm o.json b.json` | `0 findings, 4 skipped` - the count is the number of workflows that have branch filters (4 in this sample); every skipped row says no branch list |
| 7 | glob and negated branch filters are skipped | `npm test` (fixture `branch filters: literal names are checked, globs are skipped, no branch list means skip`) | pass |
| 8 | `needs:` accepts string, flow list and block list | `npm test` (fixture `needs: accepts a string, a flow list and a block list`) | pass |
| 9 | local `uses:` that names a missing file is reported, a present one is not | `npm test` (fixture `a local uses: that points at a missing file is reported, and a present one is not`) | pass |
| 10 | exit codes are 0 / 2 / 1 | `node bin/workflow-trigger-check.js tools/cache/trpc__trpc --fail-on none; echo $?` | `0`; without `--fail-on none` → `2` |
| 11 | prevalence: 3 of 21 repositories produced a finding | `node tools/sweep.mjs` | first line contains `with >=1 finding: 3` |
| 12 | per-check prevalence: branch 2/21, paths 1/21, needs 0/21, local-uses 0/21 | `node tools/sweep.mjs` | `per check: {"branch-filter":5,"path-filter":1}` |

Deliberately absent claims: "silently", "any repository", "all four checks" and
any statement about whether a workflow runs. None of them has a command that
could confirm or refute it.
