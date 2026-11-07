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
  --branches <file>       branch evidence: one name per line, or JSON
                          {"branches":[...]}. Mark an incomplete list
                          {"truncated":true} (or "complete":false) and the check
                          skips instead of guessing. Without it, refs from a
                          complete local clone are used; a shallow or
                          single-branch clone yields no list, so the check skips.
  --tree <file>           the repository's COMPLETE file list (JSON {paths:[...]}
                          or one path per line, e.g. git/trees?recursive=1). If it
                          is partial, mark it {"truncated":true}: path and
                          local-uses checks then skip. Unmarked = trusted.
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
  let treeTruncated = false;
  if (options.tree) {
    try {
      const tree = readTreeFile(options.tree);
      filePaths = tree.paths;
      treeTruncated = tree.truncated;
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

  view.truncated = treeTruncated;
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
    return {
      paths: paths.map((entry) => String(entry).replace(/^\//, '')).filter(Boolean).sort(),
      // A caller that hit its cap says so; a partial list makes present files
      // look missing, so the checks that use it are skipped rather than guessed.
      truncated: Boolean(!Array.isArray(data) && (data.truncated === true || data.complete === false)),
    };
  }
  return {
    paths: text
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^\//, ''))
      .filter(Boolean)
      .sort(),
    truncated: false,
  };
}

function readBranches(file) {
  const text = readFileSync(file, 'utf8').trim();
  if (text === '' || text === 'null') return null;
  if (text.startsWith('[') || text.startsWith('{')) {
    const parsed = JSON.parse(text);
    // A caller that hit its cap says so; an incomplete list makes real
    // branches look absent, so it counts as no list at all.
    if (parsed && !Array.isArray(parsed) && (parsed.truncated === true || parsed.complete === false)) return null;
    const list = Array.isArray(parsed) ? parsed : parsed.branches ?? parsed.names;
    return Array.isArray(list) && list.length > 0 ? list : null;
  }
  const names = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return names.length > 0 ? names : null;
}

/**
 * Branch list from a local clone, or null when the clone cannot prove one.
 * A shallow or single-branch clone knows only what it fetched; using it would
 * call real remote branches missing, the strongest false accusation here.
 */
function localBranches(root) {
  try {
    const shallow = execFileSync('git', ['-C', root, 'rev-parse', '--is-shallow-repository'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (shallow === 'true') return null;

    let refspec = '';
    try {
      refspec = execFileSync('git', ['-C', root, 'config', '--get', 'remote.origin.fetch'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      refspec = '';
    }
    if (refspec !== '' && refspec !== '+refs/heads/*:refs/remotes/origin/*') return null;

    const remotes = execFileSync('git', ['-C', root, 'for-each-ref', '--format=%(refname:short)', 'refs/remotes'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const names = new Set();
    for (const raw of remotes.split(/\r?\n/)) {
      const name = raw.trim().replace(/^origin\//, '');
      if (name === '' || name === 'HEAD') continue;
      names.add(name);
    }
    return names.size >= 2 ? [...names] : null;
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
