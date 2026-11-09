import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, bootstrap } from '../src/server.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const INDEX = readFileSync(join(publicDir, 'index.html'), 'utf8');

// A stub board: records which calls each route makes.
function stubBoard(ids = ['acme', 'beta']) {
  const calls = { list: 0, snapshot: [], refresh: [] };
  const board = {
    calls,
    busy: false,
    ids: () => [...ids],
    has: (id) => ids.includes(id),
    list: () => {
      calls.list += 1;
      return { projects: ids.map((id) => ({ id })), error: null, warnings: [], configDir: null };
    },
    snapshot: (id) => {
      calls.snapshot.push(id);
      return ids.includes(id) ? { project: { id }, marker: 'stub' } : null;
    },
    refresh: (id) => {
      calls.refresh.push(id);
      return ids.includes(id) ? { started: !board.busy } : null;
    },
  };
  return board;
}

async function listen(board) {
  const server = createServer({ publicDir, board });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

let main;
let board;

before(async () => {
  board = stubBoard();
  main = await listen(board);
});

after(() => new Promise((resolve) => main.server.close(resolve)));

function request(method, path, { headers = {}, port = main.port } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const get = (path, opts) => request('GET', path, opts);
const post = (path, opts) => request('POST', path, opts);

// --- pages ---

test('GET / redirects to the first project', async () => {
  const res = await get('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/p/acme');
});

test('GET / with no projects serves the page (its no-projects state)', async () => {
  const empty = await listen(stubBoard([]));
  try {
    const res = await get('/', { port: empty.port });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.equal(res.body, INDEX);
  } finally {
    await new Promise((resolve) => empty.server.close(resolve));
  }
});

test('GET /p/<id> serves index.html for a known and an unknown id; the page reads the id', async () => {
  for (const p of ['/p/acme', '/p/beta', '/p/no-such-project']) {
    const res = await get(p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.equal(res.body, INDEX);
  }
  assert.deepEqual(board.calls.snapshot, [], 'a page request is not a snapshot request');
});

test('GET /p/<something that is no project id> is 404', async () => {
  for (const p of ['/p/', '/p/Acme', '/p/acme/extra', '/p/-x', '/p/a_b']) {
    const res = await get(p);
    assert.equal(res.status, 404, p);
  }
});

test('static files, path traversal and missing files', async () => {
  const app = await get('/app.js');
  assert.equal(app.status, 200);
  assert.match(app.headers['content-type'], /text\/javascript/);
  assert.equal((await get('/index.html')).status, 200);
  assert.equal((await get('/../package.json')).status, 404);
  assert.equal((await get('/nope.js')).status, 404);
});

test('GET /lib/derive.js serves src/derive.js as JavaScript', async () => {
  const res = await get('/lib/derive.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/javascript/);
  assert.match(res.body, /export function enrich/);
});

test('nothing else from src is served', async () => {
  for (const p of ['/lib/config.js', '/lib/secrets.js', '/lib/../config.js', '/src/derive.js', '/lib/sources/github.js', '/lib/board.js']) {
    const res = await get(p);
    assert.equal(res.status, 404, p);
  }
});

// --- API ---

test('GET /api/projects returns the board list as JSON, no-store', async () => {
  const before = board.calls.list;
  const res = await get('/api/projects');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(res.body), { projects: [{ id: 'acme' }, { id: 'beta' }], error: null, warnings: [], configDir: null });
  assert.equal(board.calls.list, before + 1);
});

test('GET /api/p/<id>/snapshot returns that project snapshot as JSON, no-store', async () => {
  const res = await get('/api/p/beta/snapshot');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(res.body), { project: { id: 'beta' }, marker: 'stub' });
  assert.equal(board.calls.snapshot.at(-1), 'beta');
});

test('an unknown project id is a 404 JSON on the API routes', async () => {
  const snap = await get('/api/p/nope/snapshot');
  assert.equal(snap.status, 404);
  assert.match(snap.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(snap.body), { error: 'Unknown project `nope`' });
  const ref = await post('/api/p/nope/refresh');
  assert.equal(ref.status, 404);
  assert.deepEqual(JSON.parse(ref.body), { error: 'Unknown project `nope`' });
  assert.ok(!board.calls.snapshot.includes('nope'));
  assert.ok(!board.calls.refresh.includes('nope'));
});

test('POST /api/p/<id>/refresh: 202 with started true, or false while a round runs', async () => {
  board.busy = false;
  const res = await post('/api/p/acme/refresh');
  assert.equal(res.status, 202);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(res.body), { started: true });
  assert.equal(board.calls.refresh.at(-1), 'acme');
  board.busy = true;
  const busy = await post('/api/p/acme/refresh');
  board.busy = false;
  assert.equal(busy.status, 202);
  assert.deepEqual(JSON.parse(busy.body), { started: false });
});

test('wrong methods and unknown API paths are 404 JSON', async () => {
  for (const [method, p] of [['GET', '/api/p/acme/refresh'], ['POST', '/api/p/acme/snapshot'], ['POST', '/api/projects'], ['GET', '/api/nope'], ['GET', '/api/p/acme']]) {
    const res = await request(method, p);
    assert.equal(res.status, 404, `${method} ${p}`);
    assert.deepEqual(JSON.parse(res.body), { error: 'Not found' });
  }
});

test('the old /api/snapshot and /api/refresh are gone', async () => {
  assert.equal((await get('/api/snapshot')).status, 404);
  assert.equal((await post('/api/refresh')).status, 404);
  assert.equal((await get('/api/refresh')).status, 404);
});

test('only /api/projects and the snapshot reach the board state; pages, static files and refresh do not', async () => {
  const list = board.calls.list;
  const snaps = board.calls.snapshot.length;
  await get('/');
  await get('/p/acme');
  await get('/app.js');
  await get('/lib/derive.js');
  await post('/api/p/acme/refresh');
  assert.equal(board.calls.list, list);
  assert.equal(board.calls.snapshot.length, snaps);
});

// --- Host/Origin guard ---

test('a foreign Host header is rejected with 403', async () => {
  for (const host of ['evil.example', 'evil.example:0', '127.0.0.1:1', 'localhost']) {
    for (const p of ['/api/projects', '/api/p/acme/snapshot', '/p/acme']) {
      const res = await get(p, { headers: { host } });
      assert.equal(res.status, 403, `${host} ${p}`);
    }
  }
});

test('localhost:<port> Host header is accepted', async () => {
  const res = await get('/api/p/acme/snapshot', { headers: { host: `localhost:${main.port}` } });
  assert.equal(res.status, 200);
});

test('POST with a foreign Origin is rejected; own origins are accepted', async () => {
  const bad = await post('/api/p/acme/refresh', { headers: { origin: 'http://evil.example' } });
  assert.equal(bad.status, 403);
  const bad2 = await post('/api/p/acme/refresh', { headers: { origin: 'null' } });
  assert.equal(bad2.status, 403);
  for (const origin of [`http://127.0.0.1:${main.port}`, `http://localhost:${main.port}`]) {
    const ok = await post('/api/p/acme/refresh', { headers: { origin } });
    assert.equal(ok.status, 202, origin);
  }
});

// --- bootstrap: config dir → loadBoard → board (stub upstream, so no live calls and no OS tools) ---

const REPO = fileURLToPath(new URL('../', import.meta.url));

function boardDir(files = {}) {
  const base = mkdtempSync(join(tmpdir(), 'pr-board-server-'));
  const dir = join(base, 'pr-board');
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

// Stub upstream for bootstrap: secrets, http, discoverers and sources that never leave the process.
const stubDeps = () => ({
  secrets: { auth: async (host) => `header-${host}` },
  http: { stats: () => ({}), get: async (url) => (url.includes('github') ? { login: 'ada' } : { uuid: '{ada}' }) },
  discoverers: { github: async () => [], bitbucket: async () => [] },
  sources: { github: async () => ({ prs: [] }), bitbucket: async () => ({ prs: [] }), jira: async () => ({ tickets: {} }) },
});

test('bootstrap: creates a missing config dir with mode 0700 and boots an empty board', { skip: process.platform === 'win32' }, () => {
  const dir = boardDir();
  const logs = [];
  const { port, board: b } = bootstrap({ env: { PR_BOARD_CONFIG_DIR: dir }, log: (l) => logs.push(l), ...stubDeps() });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(port, 7419);
  assert.deepEqual(b.ids(), []);
  assert.deepEqual(b.list(), { projects: [], error: null, warnings: [], configDir: dir });
});

test('bootstrap: a broken config.json still boots, with the error in the list and the log', () => {
  const dir = boardDir({ 'config.json': '{ nope' });
  const logs = [];
  const { port, board: b } = bootstrap({ env: { PR_BOARD_CONFIG_DIR: dir, PORT: '7611' }, log: (l) => logs.push(l), ...stubDeps() });
  assert.equal(port, 7611);
  assert.deepEqual(b.ids(), []);
  assert.match(b.list().error, /config\.json: Invalid JSON/);
  assert.ok(logs.some((l) => /config\.json/.test(l) && /Invalid JSON/.test(l)));
});

test('bootstrap: every project runs in the board; a broken one carries its error and is logged', () => {
  const dir = boardDir({
    'config.json': JSON.stringify({ projects: { broken: { file: 'nope.json' }, acme: { file: 'projects/acme.json' } } }),
    'projects/acme.json': readFileSync(join(REPO, 'projects', 'example.json'), 'utf8'),
  });
  const logs = [];
  const { board: b } = bootstrap({ env: { PR_BOARD_CONFIG_DIR: dir }, log: (l) => logs.push(l), ...stubDeps() });
  assert.deepEqual(b.ids(), ['broken', 'acme']);
  const tabs = b.list().projects;
  assert.deepEqual(tabs.map((t) => [t.id, t.title]), [['broken', 'broken'], ['acme', 'Acme']]);
  assert.match(tabs[0].error, /nope\.json: File not found/);
  assert.equal(tabs[1].error, null);
  const s = b.snapshot('acme');
  assert.deepEqual(s.repos.map((r) => r.repoShort), ['shared', 'backend', 'worker', 'web']);
  assert.deepEqual(s.project.hosts, { github: { owner: 'acme-corp' }, bitbucket: { workspace: 'acme' } });
  assert.ok(logs.some((l) => /project broken stopped/.test(l)), 'the broken project is logged');
});

test('bootstrap: the real shared package check runs, reading the consumer lock files at the PR sha', async () => {
  const dir = boardDir({
    'config.json': JSON.stringify({ projects: { acme: { file: 'projects/acme.json' } } }),
    'projects/acme.json': readFileSync(join(REPO, 'projects', 'example.json'), 'utf8'),
  });
  const urls = [];
  const deps = stubDeps();
  deps.http = {
    stats: () => ({}),
    get: async (url) => {
      urls.push(String(url));
      if (/\/2\.0\/user/.test(url)) return { uuid: '{ada}' };
      throw new Error('stub: no such file');
    },
  };
  deps.discoverers.bitbucket = async () => ['acme-shared', 'acme-backend', 'acme-worker', 'acme-web'].map((name) => ({ name, defaultBranch: 'develop' }));
  deps.sources.bitbucket = async () => ({
    prs: [{
      id: 'bitbucket:acme-backend#12', host: 'bitbucket', owner: 'acme', repo: 'acme-backend', repoShort: 'backend',
      number: 12, title: 'SHOP-42 Add invoice export', source: 'feature/SHOP-42-invoice-export', target: 'develop',
      headSha: 'abc123', author: { name: 'Ada', id: '{ada}' }, mine: true, draft: false,
      createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-08T00:00:00Z', ci: 'ok', mergeable: 'clean', behindBy: 0,
    }],
  });
  const { board: b } = bootstrap({ env: { PR_BOARD_CONFIG_DIR: dir }, log: () => {}, ...deps });
  b.refresh('acme');
  for (let i = 0; i < 200 && (b.snapshot('acme').refreshing || !b.snapshot('acme').generatedAt); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(urls.some((u) => u.includes('acme-backend') && u.includes('composer.json') && u.includes('abc123')), `no lock read in ${urls.join(', ')}`);
  b.stop?.();
});
