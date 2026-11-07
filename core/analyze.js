// Orchestration: workflow texts + a repo view -> findings.
//
// Pure and synchronous, like dependabot-doctor's core: the CLI supplies a
// node:fs view, the page supplies a view backed by raw.githubusercontent.com,
// tests supply an in-memory map.

import { parseWorkflow } from './workflows.js';
import { runChecks } from './checks.js';
import { YamlError } from './yaml.js';

export const VERSION = '0.1.0';

/**
 * @param {{
 *   workflows: {path: string, text: string}[],
 *   view: {root?: string, filePaths: string[], read?: (path:string)=>string|null},
 *   branches?: string[]|null
 * }} input
 */
export function analyze({ workflows, view, branches = null }) {
  const parsed = [];
  const errors = [];
  for (const workflow of workflows) {
    try {
      parsed.push(parseWorkflow(workflow.text, workflow.path));
    } catch (error) {
      errors.push({
        file: workflow.path,
        line: error instanceof YamlError ? error.line : null,
        message: error.message,
        kind: error instanceof YamlError && error.kind === 'unsupported' ? 'unsupported-yaml' : 'invalid-yaml',
      });
    }
  }

  const { findings, skipped } = runChecks({ workflows: parsed, view, branches });
  findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));

  const byCheck = {};
  for (const finding of findings) byCheck[finding.check] = (byCheck[finding.check] ?? 0) + 1;

  // Told to the caller *before* it fetches anything: a page can announce one API
  // call for the tree, and a second one only when some workflow filters branches.
  const needsBranches = parsed.some((workflow) => workflow.filters.some((entry) => entry.kind === 'branch'));

  return {
    ok: errors.length === 0,
    needs: { tree: true, branches: needsBranches },
    version: VERSION,
    root: view.root ?? '.',
    workflows: parsed.map((workflow) => ({
      path: workflow.path,
      jobs: workflow.jobs.length,
      triggers: [...workflow.triggerMap.keys()],
    })),
    findings,
    skipped,
    errors,
    summary: {
      workflows: workflows.length,
      workflows_parsed: parsed.length,
      findings: findings.length,
      by_check: byCheck,
      files_scanned: view.filePaths.length,
      branches_known: Array.isArray(branches) ? branches.length : null,
    },
  };
}
