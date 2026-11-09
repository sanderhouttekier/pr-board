import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBoard, DEFAULT_SETTINGS, describeError, describeWarning } from '../src/config.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/config/', import.meta.url));
const BOARD = join(FIXTURES, 'board');
const BROKEN = join(FIXTURES, 'broken');
const REPO = fileURLToPath(new URL('../', import.meta.url));

// A fresh temp config dir holding the given files (objects are written as JSON).
function tempDir(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-board-config-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

const ACME = { hosts: { bitbucket: { workspace: 'acme' } } };
const byId = (board) => Object.fromEntries(board.projects.map((p) => [p.id, p]));

test('defaults: the SPEC table', () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    port: 7419,
    intervalSec: 300,
    idleAfterSec: 900,
    idleIntervalSec: 3600,
    staleDays: 14,
    behindWarn: 20,
    ghPath: 'gh',
    mine: {},
    fixNotes: {},
  });
});

test('no config.json: an empty board with default settings, no error', () => {
  const board = loadBoard({ dir: tempDir(), env: {} });
  assert.deepEqual(board, { settings: DEFAULT_SETTINGS, warnings: [], error: null, projects: [] });
});

test('a config dir that does not exist yet is an empty board too', () => {
  const board = loadBoard({ dir: join(tempDir(), 'nope'), env: {} });
  assert.equal(board.error, null);
  assert.deepEqual(board.projects, []);
});

test('broken top-level JSON: a board error, no projects, default settings, never throws', () => {
  const board = loadBoard({ dir: BROKEN, env: {} });
  assert.deepEqual(board.projects, []);
  assert.deepEqual(board.settings, DEFAULT_SETTINGS);
  assert.equal(board.error.file, join(BROKEN, 'config.json'));
  assert.equal(board.error.errors.length, 1);
  assert.equal(board.error.errors[0].path, '');
  assert.match(board.error.errors[0].message, /^Invalid JSON/);
});

test('a wrong type at the top level of config.json is a board error', () => {
  for (const body of [[], 'null', { port: 'x' }, { projects: [] }, { credentials: 'x' }, { fixNotes: { all: 5 } }]) {
    const board = loadBoard({ dir: tempDir({ 'config.json': body, 'projects/acme.json': ACME }), env: {} });
    assert.ok(board.error, `board error for ${JSON.stringify(body)}`);
    assert.deepEqual(board.projects, []);
    assert.deepEqual(board.settings, DEFAULT_SETTINGS);
  }
});

test('an unreadable config.json is a board error, not a crash', () => {
  const fs = {
    readFileSync() {
      throw Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' });
    },
  };
  const board = loadBoard({ dir: '/cfg', fs, env: {} });
  assert.deepEqual(board.projects, []);
  assert.equal(board.error.file, join('/cfg', 'config.json'));
  assert.match(board.error.errors[0].message, /EACCES/);
});

test('a UTF-8 BOM at the start of a file is fine', () => {
  const dir = tempDir({ 'config.json': `﻿${JSON.stringify({ projects: { acme: { file: 'a.json' } } })}`, 'a.json': `﻿${JSON.stringify(ACME)}` });
  const board = loadBoard({ dir, env: {} });
  assert.equal(board.error, null);
  assert.equal(board.projects[0].ok, true);
});

test('fixture board: projects in key order; the good one loads while the others stop', () => {
  const board = loadBoard({ dir: BOARD, env: {} });
  assert.equal(board.error, null);
  assert.deepEqual(board.projects.map((p) => [p.id, p.ok]), [
    ['acme', true], ['acme-broken', false], ['acme-invalid', false], ['acme-missing', false], ['acme-entry', false],
  ]);
});

test('fixture board: settings take config values over defaults, and drop blank fixNotes', () => {
  const { settings, warnings } = loadBoard({ dir: BOARD, env: {} });
  assert.deepEqual(settings, {
    ...DEFAULT_SETTINGS,
    port: 7500,
    intervalSec: 600,
    fixNotes: { bitbucket: 'Read pipelines through the Atlassian MCP.' },
  });
  assert.deepEqual(warnings, [{ file: join(BOARD, 'config.json'), path: 'colour', message: 'Unknown key `colour`, ignored' }]);
});

test('fixture board: the good project, with relative file, title, warnings and stripped blank fixPrompts', () => {
  const acme = byId(loadBoard({ dir: BOARD, env: {} })).acme;
  const file = join(BOARD, 'projects', 'acme.json');
  assert.equal(acme.file, file);
  assert.equal(acme.title, 'Acme');
  assert.equal(acme.error, null);
  assert.deepEqual(acme.warnings, [
    { file: join(BOARD, 'config.json'), path: 'projects.acme.label', message: 'Unknown key `projects.acme.label`, ignored' },
    { file, path: 'fixPrompts.lock-mising', message: 'Unknown key `fixPrompts.lock-mising`, ignored' },
  ]);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(acme.project, {
    ...raw,
    fixPrompts: { 'lock-mising': 'typo', group: 'Wait for CI on the shared package before you update a lock.' },
  });
});

test('fixture board: credentials merged per host, the project override wins', () => {
  const acme = byId(loadBoard({ dir: BOARD, env: {} })).acme;
  assert.deepEqual(acme.credentials, {
    github: { ref: '', override: false },
    bitbucket: { ref: 'acme-bitbucket', email: 'you@acme.example', override: true },
    jira: { ref: 'pr-board-jira', email: 'you@example.com', override: false },
  });
});

test('fixture board: broken JSON, schema errors, a missing file and a broken entry each stop only their project', () => {
  const p = byId(loadBoard({ dir: BOARD, env: {} }));
  const broken = p['acme-broken'];
  assert.equal(broken.project, null);
  assert.equal(broken.title, 'acme-broken');
  assert.equal(broken.error.file, join(BOARD, 'projects', 'broken.json'));
  assert.match(broken.error.errors[0].message, /^Invalid JSON/);

  const invalid = p['acme-invalid'];
  assert.equal(invalid.project, null);
  assert.equal(invalid.title, 'Acme invalid', 'a valid title is still used for the tab');
  assert.equal(invalid.error.file, join(BOARD, 'projects', 'invalid.json'));
  assert.deepEqual(invalid.error.errors.map((e) => e.path), ['hosts', 'tickets[0].jira']);

  const missing = p['acme-missing'];
  assert.equal(missing.file, join(BOARD, 'projects', 'missing.json'));
  assert.deepEqual(missing.error, { file: join(BOARD, 'projects', 'missing.json'), errors: [{ path: '', message: 'File not found' }] });

  const entry = p['acme-entry'];
  assert.equal(entry.file, null);
  assert.equal(entry.error.file, join(BOARD, 'config.json'));
  assert.deepEqual(entry.error.errors.map((e) => e.path), ['projects.acme-entry.file']);
  assert.deepEqual(entry.warnings.map((w) => w.path), ['projects.acme-entry.fiel']);
});

test('an invalid project id stops that project only', () => {
  const dir = tempDir({ 'config.json': { projects: { Acme: { file: 'a.json' }, acme: { file: 'a.json' } } }, 'a.json': ACME });
  const p = byId(loadBoard({ dir, env: {} }));
  assert.equal(p.Acme.ok, false);
  assert.deepEqual(p.Acme.error.errors.map((e) => e.path), ['projects.Acme']);
  assert.equal(p.acme.ok, true);
});

test('an absolute file path is used as is', () => {
  const elsewhere = tempDir({ 'acme.json': ACME });
  const dir = tempDir({ 'config.json': { projects: { acme: { file: join(elsewhere, 'acme.json') } } } });
  const [acme] = loadBoard({ dir, env: {} }).projects;
  assert.equal(acme.file, join(elsewhere, 'acme.json'));
  assert.equal(acme.ok, true);
  assert.equal(acme.title, 'acme', 'title defaults to the id');
});

test('a broken global credential stops the projects that inherit it, and only those', () => {
  const dir = tempDir({
    'config.json': {
      credentials: { bitbucket: { ref: 'pr-board-bitbucket' } },
      projects: {
        inherits: { file: 'bb.json' },
        overrides: { file: 'bb.json', credentials: { bitbucket: { ref: 'acme-bitbucket', email: 'you@acme.example' } } },
        'github-only': { file: 'gh.json' },
      },
    },
    'bb.json': ACME,
    'gh.json': { hosts: { github: { owner: 'acme-corp' } } },
  });
  const board = loadBoard({ dir, env: {} });
  assert.equal(board.error, null);
  const p = byId(board);
  assert.equal(p.inherits.ok, false);
  assert.deepEqual(p.inherits.error, {
    file: join(dir, 'config.json'),
    errors: [{ path: 'credentials.bitbucket.email', message: 'Missing required key `credentials.bitbucket.email`' }],
  });
  assert.equal(p.overrides.ok, true);
  assert.equal(p['github-only'].ok, true);
});

test('a project credential override with an error stops that project', () => {
  const dir = tempDir({
    'config.json': { projects: { acme: { file: 'a.json', credentials: { jira: { ref: 'acme-jira' } } } } },
    'a.json': ACME,
  });
  const [acme] = loadBoard({ dir, env: {} }).projects;
  assert.equal(acme.ok, false);
  assert.deepEqual(acme.error.errors.map((e) => e.path), ['projects.acme.credentials.jira.email']);
});

test('PORT env wins when it is a valid port number', () => {
  const dir = tempDir({ 'config.json': { port: 7500 } });
  assert.equal(loadBoard({ dir, env: { PORT: '7600' } }).settings.port, 7600);
  for (const bad of ['', 'abc', '0', '70000', '7600.5', ' 7600']) {
    assert.equal(loadBoard({ dir, env: { PORT: bad } }).settings.port, 7500, `PORT=${JSON.stringify(bad)} is ignored`);
  }
  assert.equal(loadBoard({ dir: tempDir(), env: { PORT: '7601' } }).settings.port, 7601);
  assert.equal(loadBoard({ dir: BROKEN, env: { PORT: '7602' } }).settings.port, 7602, 'also with a board error');
});

test('the shipped examples load as one OK project with no warnings', () => {
  const dir = tempDir({
    'config.json': readFileSync(join(REPO, 'config.example.json'), 'utf8'),
    'projects/acme.json': readFileSync(join(REPO, 'projects', 'example.json'), 'utf8'),
  });
  const board = loadBoard({ dir, env: {} });
  assert.equal(board.error, null);
  assert.deepEqual(board.warnings, []);
  assert.deepEqual(board.projects.map((p) => [p.id, p.ok, p.title, p.warnings]), [['acme', true, 'Acme', []]]);
});

// Display strings for the snapshot, tabs and logs.
test('describeError: the file path, then every message', () => {
  assert.equal(describeError(null), null);
  assert.equal(
    describeError({ file: '/cfg/projects/acme.json', errors: [{ path: 'hosts', message: 'Missing required key `hosts`' }, { path: '', message: 'second' }] }),
    '/cfg/projects/acme.json: Missing required key `hosts`; second',
  );
});

test('describeWarning: the file name and the message; a string stays as it is', () => {
  assert.equal(describeWarning({ file: '/cfg/config.json', path: 'colour', message: 'Unknown key `colour`, ignored' }), 'config.json: Unknown key `colour`, ignored');
  assert.equal(describeWarning('already a string'), 'already a string');
});
