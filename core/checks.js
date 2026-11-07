// The four checks. Each is a question about the repository's contents:
//
//   branch-filter   does this literal branch name exist?
//   path-filter     does the static prefix of this path filter exist?
//   needs-target    is this job defined in the same workflow?
//   local-uses      does this repo-relative workflow/action file exist?
//
// No expression evaluation, no glob semantics beyond a static prefix, no
// judgement about whether the CI is well designed. When a name cannot be judged
// (glob branch filters, empty path prefixes, no branch list available), the
// check is skipped with a reason and produces nothing.

const GLOB_CHARS = /[*?[\]]/;

/**
 * @param {{workflows: object[], view: object, branches: string[]|null}} input
 */
export function runChecks({ workflows, view, branches }) {
  const findings = [];
  const skipped = [];
  const files = new Set(view.filePaths.map((path) => path.replace(/^\//, '')));
  const directories = new Set(['/']);
  for (const path of files) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) directories.add(`/${parts.slice(0, i).join('/')}`);
  }

  for (const workflow of workflows) {
    checkBranches(workflow, branches, findings, skipped);
    checkPaths(workflow, files, directories, findings);
    checkNeeds(workflow, findings);
    checkLocalUses(workflow, files, findings);
  }

  return { findings, skipped };
}

function checkBranches(workflow, branches, findings, skipped) {
  const entries = filterEntriesOfKind(workflow, 'branch');
  if (entries.length === 0) return;
  if (!branches) {
    skipped.push({
      check: 'branch-filter',
      reason: `${workflow.path}: no branch list available, so literal branch names cannot be checked`,
    });
    return;
  }
  const known = new Set(branches);
  for (const entry of entries) {
    if (GLOB_CHARS.test(entry.value) || entry.value.includes('!')) continue;
    if (known.has(entry.value)) continue;
    findings.push({
      check: 'branch-filter',
      file: workflow.path,
      line: entry.line,
      subject: entry.value,
      detail: `${entry.trigger}.${entry.key} names branch "${entry.value}", which does not exist in this repository`,
    });
  }
}

function checkPaths(workflow, files, directories, findings) {
  for (const entry of filterEntriesOfKind(workflow, 'path')) {
    const value = entry.value;
    if (value.startsWith('!')) continue;
    const prefix = staticPrefix(value);
    if (prefix === '' || prefix === '.' || prefix === '/') continue; // cannot be judged
    const normalized = prefix.replace(/^\.\//, '').replace(/^\//, '').replace(/\/+$/, '');
    if (normalized === '') continue;
    if (pathExists(normalized, files, directories)) continue;
    findings.push({
      check: 'path-filter',
      file: workflow.path,
      line: entry.line,
      subject: value,
      detail: `${entry.trigger}.${entry.key} entry "${value}" starts at "${normalized}", which matches no file or directory in this repository`,
    });
  }
}

/**
 * The text before the first glob character, trimmed at a path boundary.
 * A filter whose prefix exists is never reported, even when no file matches:
 * that claim needs GitHub's glob semantics, and we do not model it.
 */
export function staticPrefix(value) {
  const text = String(value);
  const index = text.search(GLOB_CHARS);
  const head = index < 0 ? text : text.slice(0, index);
  if (index < 0) return head;
  const slash = head.lastIndexOf('/');
  return slash < 0 ? '' : head.slice(0, slash);
}

function pathExists(prefix, files, directories) {
  if (files.has(prefix)) return true;
  if (directories.has(`/${prefix}`)) return true;
  const withSlash = `${prefix}/`;
  for (const path of files) if (path.startsWith(withSlash)) return true;
  return false;
}

function checkNeeds(workflow, findings) {
  const jobs = new Set(workflow.jobs.map((job) => job.name));
  for (const job of workflow.jobs) {
    for (const need of job.needs) {
      if (jobs.has(need)) continue;
      findings.push({
        check: 'needs-target',
        file: workflow.path,
        line: job.needsLine,
        subject: need,
        detail: `job "${job.name}" needs "${need}", which is not a job in this workflow (defined: ${[...jobs].join(', ') || 'none'})`,
      });
    }
  }
}

function checkLocalUses(workflow, files, findings) {
  for (const use of workflow.uses) {
    if (!use.value.startsWith('./')) continue;
    if (use.value.includes('${{')) continue;
    const target = use.value.slice(2).split('#')[0];
    if (files.has(target) || [...files].some((path) => path.startsWith(`${target.replace(/\/$/, '')}/`))) continue;
    findings.push({
      check: 'local-uses',
      file: workflow.path,
      line: use.line,
      subject: use.value,
      detail: `"${use.value}" is a local reference, but nothing at that path exists in this repository`,
    });
  }
}

function filterEntriesOfKind(workflow, kind) {
  return workflow.filters.filter((entry) => entry.kind === kind);
}
