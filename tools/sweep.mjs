#!/usr/bin/env node
// Prevalence sweep for workflow-trigger-check, measured with the real parser.
//
// Sample = the 21 repositories Strategy named. For each: fetch the workflow
// files, the git tree (authoritative file list) and the branch list, materialise
// into a temp dir, then run the CLI exactly as a user would. No regex anywhere.
//
// Usage: node tools/sweep.mjs [--refresh]

import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const cache = join(here, 'cache');
const bin = join(here, '..', 'bin', 'workflow-trigger-check.js');
const refresh = process.argv.includes('--refresh');

const REPOS = [
  'nestjs/nest',
  'supabase/supabase',
  'calcom/cal.com',
  'n8n-io/n8n',
  'immich-app/immich',
  'appwrite/appwrite',
  'directus/directus',
  'medusajs/medusa',
  'strapi/strapi',
  'excalidraw/excalidraw',
  'tldraw/tldraw',
  'trpc/trpc',
  'documenso/documenso',
  'formbricks/formbricks',
  'hoppscotch/hoppscotch',
  'lobehub/lobe-chat',
  'continuedev/continue',
  'cli/cli',
  'payloadcms/payload',
  'novuhq/novu',
  'typeorm/typeorm',
];

const token = process.env.GITHUB_TOKEN || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const HEADERS = { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'wtc-sweep' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(url, attempt = 0) {
  const response = await fetch(url, { headers: HEADERS });
  if (response.status === 403 || response.status === 429) {
    if (attempt > 5) throw new Error(`rate limited: ${url}`);
    await sleep(10000);
    return api(url, attempt + 1);
  }
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

/**
 * Every branch, paginated. `complete: false` when the cap is hit, in which case
 * the list is not authoritative and branch checks must be skipped.
 */
async function allBranches(repo) {
  const names = new Set();
  const info = await api(`https://api.github.com/repos/${repo}`);
  names.add(info.default_branch);
  for (let page = 1; page <= 10; page += 1) {
    const batch = await api(`https://api.github.com/repos/${repo}/branches?per_page=100&page=${page}`);
    for (const branch of batch) names.add(branch.name);
    if (batch.length < 100) return { names: [...names], complete: true };
  }
  return { names: [...names], complete: false };
}

async function raw(repo, sha, path) {
  const response = await fetch(`https://raw.githubusercontent.com/${repo}/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`);
  if (!response.ok) return null;
  return response.text();
}

function pool(items, size, worker) {
  let index = 0;
  const results = [];
  return Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const current = index;
        index += 1;
        if (current >= items.length) return;
        results[current] = await worker(items[current]);
      }
    }),
  ).then(() => results);
}

const results = await pool(REPOS, 4, async (repo) => {
  const dir = join(cache, repo.replace('/', '__'));
  const meta = join(dir, '.meta.json');
  try {
    if (refresh && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    let saved = null;
    if (existsSync(meta)) saved = JSON.parse(readFileSync(meta, 'utf8'));
    if (!saved || !saved.sha) {
      const info = await api(`https://api.github.com/repos/${repo}`);
      const commit = await api(`https://api.github.com/repos/${repo}/commits/${info.default_branch}`);
      const tree = await api(`https://api.github.com/repos/${repo}/git/trees/${commit.sha}?recursive=1`);
      const branches = await allBranches(repo);
      saved = {
        sha: commit.sha,
        truncated: Boolean(tree.truncated),
        paths: tree.tree.filter((entry) => entry.type === 'blob').map((entry) => entry.path),
        branches: branches.names,
        branches_complete: branches.complete,
      };
      mkdirSync(dir, { recursive: true });
      writeFileSync(meta, JSON.stringify(saved));
    }
    const workflowPaths = saved.paths.filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path));
    for (const path of workflowPaths) {
      const absolute = join(dir, path);
      if (existsSync(absolute)) continue;
      const text = await raw(repo, saved.sha, path);
      if (text == null) continue;
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, text);
    }
    writeFileSync(join(dir, '.branches.json'), JSON.stringify(saved.branches_complete === false ? null : saved.branches));
    writeFileSync(join(dir, '.tree.json'), JSON.stringify({ paths: saved.paths }));
    if (workflowPaths.length === 0) return { repo, workflows: 0, findings: [], skipped: [] };
    const out = spawnSync(
      process.execPath,
      [bin, dir, '--json', '--branches', join(dir, '.branches.json'), '--tree', join(dir, '.tree.json'), '--fail-on', 'none'],
      { encoding: 'utf8', timeout: 60000 },
    );
    const payload = JSON.parse(out.stdout);
    return {
      repo,
      workflows: workflowPaths.length,
      findings: payload.findings,
      skipped: payload.skipped,
      truncated: saved.truncated,
      branches_complete: saved.branches_complete !== false,
    };
  } catch (error) {
    return { repo, error: error.message };
  }
});


const usable = results.filter((item) => item && !item.error && item.workflows > 0);
const perCheck = {};
for (const item of usable) for (const finding of item.findings) perCheck[finding.check] = (perCheck[finding.check] ?? 0) + 1;
const withFinding = usable.filter((item) => item.findings.length > 0);

console.log(`repos: ${results.length}, with workflows: ${usable.length}, with >=1 finding: ${withFinding.length}`);
console.log(`per check: ${JSON.stringify(perCheck)}`);
for (const item of results.filter((entry) => entry && entry.error)) console.log(`  error ${item.repo}: ${item.error}`);
for (const item of withFinding) {
  console.log(`\n${item.repo} (${item.workflows} workflows)`);
  for (const finding of item.findings) console.log(`  ${finding.check} ${finding.file}:${finding.line} ${finding.subject}`);
}
writeFileSync(join(here, 'results.json'), `${JSON.stringify({ generated_at: new Date().toISOString(), repos: results }, null, 2)}\n`);
