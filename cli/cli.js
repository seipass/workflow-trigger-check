// CLI: filesystem + argv + exit codes. All judgement lives in core/.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyze, VERSION } from '../core/analyze.js';
import { renderText } from '../core/report.js';

const USAGE = `workflow-trigger-check ${VERSION}
Find GitHub Actions triggers and job edges that name something the repository
does not have: branch filters, path filters, needs: targets and local uses:.

Usage
  workflow-trigger-check [path] [options]

  path                    repository to inspect (default: current directory)

Options
  --branches <file>       branch list to check against (one per line, or JSON
                          array). Without it, branch filters are skipped rather
                          than guessed. Default: read refs from a local .git.
  --tree <file>           authoritative file list for the checkout (JSON
                          {paths:[...]} or one path per line). Use it when the
                          checkout holds only part of the repository.
  --json                  machine-readable output
  --fail-on <checks>      comma-separated check names that fail the run
                          (default: all)
  --version               print the version
  --help                  print this help

Exit codes
  0  nothing dangling
  2  findings
  1  usage error, or a workflow this tool cannot read

Checks
  branch-filter   a literal branch name in branches/branches-ignore does not exist
  path-filter     the static prefix of a paths/paths-ignore entry does not exist
  needs-target    a job needs: a job that is not defined in the same workflow
  local-uses      uses: ./... names a file this repository does not have
`;

export function main(argv = process.argv.slice(2)) {
  const options = { path: '.', json: false, failOn: 'all', branches: null, tree: null };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (arg === '--version' || arg === '-v') {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--branches') {
      options.branches = argv[i + 1];
      i += 1;
      if (!options.branches) {
        process.stderr.write('error: --branches needs a file path\n');
        return 1;
      }
      continue;
    }
    if (arg.startsWith('--branches=')) {
      options.branches = arg.slice('--branches='.length);
      continue;
    }
    if (arg === '--tree') {
      options.tree = argv[i + 1];
      i += 1;
      if (!options.tree) {
        process.stderr.write('error: --tree needs a file path' + String.fromCharCode(10));
        return 1;
      }
      continue;
    }
    if (arg.startsWith('--tree=')) {
      options.tree = arg.slice('--tree='.length);
      continue;
    }
    if (arg === '--fail-on') {
      options.failOn = argv[i + 1] ?? 'all';
      i += 1;
      continue;
    }
    if (arg.startsWith('--fail-on=')) {
      options.failOn = arg.slice('--fail-on='.length);
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      process.stderr.write(`error: unknown option ${arg}\nTry --help.\n`);
      return 1;
    }
    positional.push(arg);
  }

  const root = resolve(positional[0] ?? '.');
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    process.stderr.write(`error: not a directory: ${root}\n`);
    return 1;
  }

  const workflowDir = join(root, '.github', 'workflows');
  if (!existsSync(workflowDir)) {
    process.stderr.write(`error: no .github/workflows directory under ${root}\n`);
    return 1;
  }

  const workflows = [];
  for (const name of readdirSync(workflowDir).sort()) {
    if (!/\.ya?ml$/i.test(name)) continue;
    const absolute = join(workflowDir, name);
    try {
      workflows.push({ path: `.github/workflows/${name}`, text: readFileSync(absolute, 'utf8') });
    } catch (error) {
      process.stderr.write(`error: cannot read ${absolute}: ${error.message}\n`);
      return 1;
    }
  }
  if (workflows.length === 0) {
    process.stderr.write(`error: no workflow files under ${workflowDir}\n`);
    return 1;
  }

  let filePaths = walk(root).sort();
  if (options.tree) {
    try {
      filePaths = readTreeFile(options.tree);
    } catch (error) {
      process.stderr.write(`error: cannot read --tree ${options.tree}: ${error.message}` + String.fromCharCode(10));
      return 1;
    }
  }
  const view = {
    root,
    filePaths,
    read(relativePath) {
      try {
        return readFileSync(join(root, ...relativePath.split('/')), 'utf8');
      } catch {
        return null;
      }
    },
  };

  const branches = options.branches ? readBranches(options.branches) : localBranches(root);
  const result = analyze({ workflows, view, branches });

  if (options.json) {
    const payload = { ...result, exit: exitCodeFor(result, options.failOn) };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload.exit;
  }

  process.stdout.write(`${renderText(result)}\n`);
  return exitCodeFor(result, options.failOn);
}

export function exitCodeFor(result, failOn = 'all') {
  if (!result.ok) return 1;
  const list = String(failOn)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (list.includes('none')) return 0;
  const matched = result.findings.filter((finding) => list.includes('all') || list.includes(finding.check));
  return matched.length > 0 ? 2 : 0;
}

/** Read a `--tree` file: JSON {paths:[...]} or one path per line. */
function readTreeFile(file) {
  const text = readFileSync(file, 'utf8').trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    const data = JSON.parse(text);
    const paths = Array.isArray(data) ? data : data.paths ?? data.tree ?? data.files;
    if (!Array.isArray(paths)) throw new Error('no paths array');
    return paths.map((path) => String(path).replace(/^\//, '')).filter(Boolean).sort();
  }
  const separator = new RegExp(String.fromCharCode(13) + '?' + String.fromCharCode(10));
  return text.split(separator).map((line) => line.trim().replace(/^\//, '')).filter(Boolean).sort();
}

function readBranches(file) {
  const text = readFileSync(file, 'utf8').trim();
  // "null" / empty means "the caller could not obtain a complete list": skip the
  // check rather than call real branches missing.
  if (text === '' || text === 'null') return null;
  if (text.startsWith('[') || text.startsWith('{')) {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : parsed.branches ?? parsed.names;
    return Array.isArray(list) && list.length > 0 ? list : null;
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Best-effort local branch list; null when we cannot know (then we skip). */
function localBranches(root) {
  try {
    const output = execFileSync('git', ['-C', root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const names = new Set();
    for (const raw of output.split(/\r?\n/)) {
      const name = raw.trim().replace(/^origin\//, '');
      if (name === '' || name === 'HEAD') continue;
      names.add(name);
    }
    return names.size > 0 ? [...names] : null;
  } catch {
    return null;
  }
}

const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', 'vendor']);
const SKIP_PREFIXES = ['tools/cache'];

function walk(directory, base = directory, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue;
      const relativePath = relative(base, join(directory, entry.name)).split(sep).join('/');
      if (SKIP_PREFIXES.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`))) continue;
      walk(join(directory, entry.name), base, out);
    } else if (entry.isFile()) {
      out.push(relative(base, join(directory, entry.name)).split(sep).join('/'));
    }
  }
  return out;
}
