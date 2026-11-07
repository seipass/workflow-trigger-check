import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../core/analyze.js';
import { staticPrefix } from '../core/checks.js';
import { deriveDirectories } from './derive.js';

function viewOf(files) {
  const filePaths = Object.keys(files);
  return { root: '.', filePaths, directories: deriveDirectories(filePaths) };
}

const wf = (text) => ({ path: '.github/workflows/ci.yml', text });

test('static prefix stops at the first glob character and a path boundary', () => {
  assert.equal(staticPrefix('docs/**'), 'docs');
  assert.equal(staticPrefix('apps/website/**.md'), 'apps/website');
  assert.equal(staticPrefix('pnpm-lock.yaml'), 'pnpm-lock.yaml');
  assert.equal(staticPrefix('**/*.md'), '');
  assert.equal(staticPrefix('src/*.ts'), 'src');
});

test('a paths filter whose static prefix exists is never reported', () => {
  const result = analyze({
    workflows: [wf('on:\n  push:\n    paths:\n      - "docs/**"\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: []\n')],
    view: viewOf({ 'docs/index.md': '', 'README.md': '' }),
  });
  assert.deepEqual(result.findings, []);
});

test('a paths filter whose static prefix does not exist is reported with the source line', () => {
  const result = analyze({
    workflows: [wf('on:\n  push:\n    paths:\n      - "apps/website/**"\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: []\n')],
    view: viewOf({ 'apps/web/index.ts': '' }),
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].check, 'path-filter');
  assert.equal(result.findings[0].line, 4);
  assert.equal(result.findings[0].subject, 'apps/website/**');
});

test('needs: accepts a string, a flow list and a block list', () => {
  const result = analyze({
    workflows: [
      wf(`on: [push, pull_request]
jobs:
  a:
    runs-on: ubuntu-latest
    steps: []
  b:
    needs: a
    runs-on: ubuntu-latest
    steps: []
  c:
    needs: [a, b]
    runs-on: ubuntu-latest
    steps: []
  d:
    needs:
      - a
      - b
    runs-on: ubuntu-latest
    steps: []
  e:
    needs: [a, missing-job]
    runs-on: ubuntu-latest
    steps: []
`),
    ],
    view: viewOf({ 'index.js': '' }),
  });
  const found = result.findings.filter((finding) => finding.check === 'needs-target');
  assert.equal(found.length, 1);
  assert.equal(found[0].subject, 'missing-job');
  assert.equal(found[0].line, 21);
});

test('a local uses: that points at a missing file is reported, and a present one is not', () => {
  const result = analyze({
    workflows: [
      wf(`on: push
jobs:
  a:
    uses: ./.github/workflows/reusable.yml
  b:
    uses: ./.github/workflows/missing.yml
  c:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup
      - uses: ./.github/actions/nope
`),
    ],
    view: viewOf({
      '.github/workflows/reusable.yml': 'on: push\njobs: {}\n',
      '.github/actions/setup/action.yml': 'name: setup\n',
    }),
  });
  const found = result.findings.filter((finding) => finding.check === 'local-uses').map((finding) => finding.subject);
  assert.deepEqual(found.sort(), ['./.github/actions/nope', './.github/workflows/missing.yml']);
});

test('branch filters: literal names are checked, globs are skipped, no branch list means skip', () => {
  const text = `on:
  push:
    branches:
      - main
      - release/**
      - dev
  pull_request:
    branches-ignore: [main]
jobs:
  a:
    runs-on: ubuntu-latest
    steps: []
`;
  const withBranches = analyze({
    workflows: [wf(text)],
    view: viewOf({ 'index.js': '' }),
    branches: ['main', 'release/1.0'],
  });
  assert.deepEqual(
    withBranches.findings.filter((finding) => finding.check === 'branch-filter').map((finding) => finding.subject),
    ['dev'],
  );

  const without = analyze({ workflows: [wf(text)], view: viewOf({ 'index.js': '' }), branches: null });
  assert.deepEqual(without.findings, []);
  assert.ok(without.skipped.some((item) => /no branch list/.test(item.reason)));
});

test('a workflow with nothing dangling produces no findings and the honest verdict', () => {
  const result = analyze({
    workflows: [
      wf(`on:
  push:
    branches: [main]
    paths: ["src/**"]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`),
    ],
    view: viewOf({ 'src/index.js': '', 'package.json': '{}' }),
    branches: ['main'],
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.ok, true);
});

test('the caller is told whether a branch list is needed before it fetches', () => {
  const withoutFilters = analyze({
    workflows: [wf('on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: []\n')],
    view: viewOf({ 'index.js': '' }),
    branches: null,
  });
  assert.equal(withoutFilters.needs.branches, false);

  const filtered = ['on:', '  push:', '    branches: [main]', 'jobs:', '  a:', '    runs-on: ubuntu-latest', '    steps: []', ''].join('\n');
  const withFilters = analyze({
    workflows: [wf(filtered)],
    view: viewOf({ 'index.js': '' }),
    branches: null,
  });
  assert.equal(withFilters.needs.branches, true);
});
