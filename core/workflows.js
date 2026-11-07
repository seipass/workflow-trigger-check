// Workflow extraction: triggers, jobs and `uses:` references, with source lines.
//
// Everything here is structural. We never evaluate an expression, an `if:`, a
// matrix, or a permission; the checks that consume this file ask one question
// each: "does this name exist in this repository?"

import { parseYaml, mapGet, mapEntry } from './yaml.js';

/** Normalize `on:` (string | array | mapping) into {triggerName: node|null}. */
function triggers(node) {
  if (!node) return new Map();
  if (node.type === 'scalar' && typeof node.value === 'string') return new Map([[node.value, null]]);
  if (node.type === 'seq') {
    const out = new Map();
    for (const item of node.items) {
      if (item.value.type === 'scalar' && typeof item.value.value === 'string') out.set(item.value.value, null);
    }
    return out;
  }
  if (node.type === 'map') {
    const out = new Map();
    for (const entry of node.entries) out.set(entry.key, entry.value);
    return out;
  }
  return new Map();
}

/** `branches:` / `paths:` can be a string or a sequence. */
function stringList(node) {
  if (!node) return [];
  if (node.type === 'scalar' && typeof node.value === 'string') return [{ value: node.value, line: node.line }];
  if (node.type === 'seq') {
    const out = [];
    for (const item of node.items) {
      if (item.value.type === 'scalar' && typeof item.value.value === 'string') {
        out.push({ value: item.value.value, line: item.value.line });
      }
    }
    return out;
  }
  return [];
}

/** `needs:` is a string, a flow sequence, or a block sequence. */
export function needsNames(node) {
  return stringList(node).map((item) => item.value);
}

/** Every `uses:` in the file, with the line it sits on. */
function collectUses(node, out) {
  if (!node) return;
  if (node.type === 'map') {
    for (const entry of node.entries) {
      if (entry.key === 'uses' && entry.value.type === 'scalar' && typeof entry.value.value === 'string') {
        out.push({ value: entry.value.value, line: entry.value.line });
      } else {
        collectUses(entry.value, out);
      }
    }
    return;
  }
  if (node.type === 'seq') {
    for (const item of node.items) collectUses(item.value, out);
  }
}

/**
 * @param {string} text
 * @param {string} path repo-relative path, for messages
 */
export function parseWorkflow(text, path) {
  const root = parseYaml(text);
  if (!root || root.type !== 'map') {
    throw new Error('workflow is not a mapping');
  }

  const onEntry = mapEntry(root, 'on') ?? mapEntry(root, 'true'); // YAML 1.1 parses `on` as boolean true
  const triggerMap = triggers(onEntry?.value);

  const jobsNode = mapGet(root, 'jobs');
  const jobs = [];
  if (jobsNode && jobsNode.type === 'map') {
    for (const entry of jobsNode.entries) {
      if (entry.value.type !== 'map') continue;
      jobs.push({
        name: entry.key,
        line: entry.keyLine,
        needs: needsNames(mapGet(entry.value, 'needs')),
        needsLine: mapGet(entry.value, 'needs')?.line ?? entry.keyLine,
      });
    }
  }

  const uses = [];
  collectUses(root, uses);

  const workflow = { path, root, triggerMap, line: root.line, jobs, uses, filters: [] };
  workflow.filters = filterEntries(workflow);
  return workflow;
}

/** Branch/path filters for the four triggers that accept them. */
export function filterEntries(workflow) {
  const out = [];
  const names = ['push', 'pull_request', 'pull_request_target', 'workflow_run'];
  for (const name of names) {
    const node = workflow.triggerMap.get(name);
    if (!node || node.type !== 'map') continue;
    for (const key of ['branches', 'branches-ignore']) {
      const entry = mapEntry(node, key);
      if (!entry) continue;
      for (const item of stringList(entry.value)) {
        out.push({ trigger: name, kind: 'branch', key, value: item.value, line: item.line });
      }
    }
    for (const key of ['paths', 'paths-ignore']) {
      const entry = mapEntry(node, key);
      if (!entry) continue;
      for (const item of stringList(entry.value)) {
        out.push({ trigger: name, kind: 'path', key, value: item.value, line: item.line });
      }
    }
  }
  return out;
}
