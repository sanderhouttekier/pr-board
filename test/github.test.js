import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectGithub, githubViewer, githubLockReader } from '../src/sources/github.js';
import { HttpError } from '../src/http.js';

const API = 'https://api.github.com';
const AUTH = 'Bearer ghp_TESTONLY_not_a_real_token';
const FIXTURES = fileURLToPath(new URL('./fixtures/github/', import.meta.url));
const INDEX = {
  ...JSON.parse(readFileSync(FIXTURES + 'index.json', 'utf8')),
  // The shared package check's reads (made-up `acme-corp/acme-shared`, consumer `acme-api`).
  ...JSON.parse(readFileSync(FIXTURES + 'lock-index.json', 'utf8')),
};

const API_PATH = '/repos/acme-corp/acme-api';
const CS = '/repos/acme-corp/acme-status';
const CS_SHA = 'be731f0e0dc81f20344a7bd33d0510181fa9a511';
const CS_MAIN = 'e8ef44b9abfef60b8005e0d6b23f4a6ad46b26d7';
const CS_LIST = `${CS}/pulls?state=open&per_page=100`;
const CS_DETAIL = `${CS}/pulls/42`;
const CS_RUNS = `${CS}/actions/runs?head_sha=${CS_SHA}&per_page=50`;
const CS_COMPARE = `${CS}/compare/${CS_MAIN}...${CS_SHA}`;
const API_LIST = `${API_PATH}/pulls?state=open&per_page=100`;

function fixture(path) {
  return JSON.parse(readFileSync(FIXTURES + INDEX[path], 'utf8'));
}

// Made-up project (see projects/example.json), with GitHub repos as repoSet gives them.
const PROJECT = {
  title: 'Acme',
  hosts: { github: { owner: 'acme-corp' }, bitbucket: { workspace: 'acme' } },
  tickets: [{ prefix: 'SHOP', browse: 'https://jira.example.com/browse/{key}', jira: 'main' }],
  jira: { main: { cloudId: '00000000-0000-4000-8000-000000000000' } },
};
const SHORTS = { 'acme-api': 'api', 'acme-app': 'app', 'acme-status': 'status' };

function testRepos(names = ['acme-api', 'acme-status']) {
  return names.map((repo) => ({
    host: 'github',
    repo,
    repoShort: SHORTS[repo] ?? repo,
    repoUrl: `https://github.com/acme-corp/${repo}/pulls`,
    defaultBranch: 'main',
  }));
}

// Serves recorded fixtures by URL path; `overrides` (path -> body | Error) win. Unknown paths 404.
function fakeHttp(overrides = {}) {
  const calls = [];
  async function serve(url, opts = {}) {
    calls.push({ url, opts });
    assert.ok(url.startsWith(API), `unexpected host: ${url}`);
    const path = url.slice(API.length);
    if (Object.hasOwn(overrides, path)) {
      const v = overrides[path];
      if (v instanceof Error) throw v;
      return structuredClone(v);
    }
    if (Object.hasOwn(INDEX, path)) return fixture(path);
    throw new HttpError({ status: 404, url, body: '{"message":"Not Found"}' });
  }
  const paths = () => calls.map((c) => c.url.slice(API.length));
  return { get: serve, getAll: serve, calls, paths };
}

const ME = 'ada';
const run = (http, extra = {}) =>
  collectGithub({
    project: extra.project ?? PROJECT,
    repos: extra.repos ?? testRepos(),
    http,
    auth: async () => AUTH,
    cache: extra.cache ?? new Map(),
    log: extra.log,
    me: 'me' in extra ? extra.me : ME,
  });

const byId = (prs, id) => prs.find((p) => p.id === id);

// A one-PR status list whose PR #42 targets `target`.
function csListWithTarget(target) {
  const list = fixture(CS_LIST);
  list[0].base.ref = target;
  return list;
}

test('normalizes a real PR exactly per SPEC "Normalized PR"', async () => {
  const http = fakeHttp();
  const { prs, errors } = await run(http);
  assert.equal(errors, undefined);
  assert.deepEqual(byId(prs, 'github:acme-status#42'), {
    id: 'github:acme-status#42',
    host: 'github',
    owner: 'acme-corp',
    repo: 'acme-status',
    repoShort: 'status',
    repoUrl: 'https://github.com/acme-corp/acme-status/pulls',
    defaultBranch: 'main',
    number: 42,
    title: 'feat(delivery): order delivery state per warehouse and customer - SHOP-42',
    url: 'https://github.com/acme-corp/acme-status/pull/42',
    description: 'Adds the delivery state per warehouse.\n\nhttps://trello.com/c/AbC123/95-delivery-state',
    author: { name: 'ada', id: 'ada' },
    mine: true,
    source: 'feature/SHOP-42-checkout',
    target: 'main',
    headSha: CS_SHA,
    draft: false,
    createdAt: '2026-11-06T12:39:40Z',
    updatedAt: '2026-11-06T13:14:44Z',
    ci: 'ok',
    mergeable: 'clean',
    behindBy: 0,
    locks: [],
  });
});

test('collects every repo it is given, sends auth + GitHub headers', async () => {
  const http = fakeHttp();
  const { prs } = await run(http);
  assert.deepEqual(prs.map((p) => p.id).sort(), [
    'github:acme-api#584',
    'github:acme-api#598',
    'github:acme-api#611',
    'github:acme-status#42',
  ]);
  for (const { opts } of http.calls) {
    assert.equal(opts.auth, AUTH);
    assert.equal(opts.headers.Accept, 'application/vnd.github+json');
    assert.equal(opts.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.equal(opts.method, undefined);
  }
  // Recorded live values: #598 had mergeable null, #598 is 130 behind main.
  assert.equal(byId(prs, 'github:acme-api#598').mergeable, 'unknown');
  assert.equal(byId(prs, 'github:acme-api#598').behindBy, 130);
  assert.equal(byId(prs, 'github:acme-api#584').mine, false);
  // The base branch head is fetched once per repo+target per round.
  assert.equal(http.paths().filter((p) => p === `${API_PATH}/branches/main`).length, 1);
});

test('mergeable_state mapping', async () => {
  const table = [
    [true, 'clean', 'clean'],
    [true, 'unstable', 'clean'],
    [true, 'blocked', 'clean'],
    [true, 'behind', 'clean'],
    [true, 'has_hooks', 'clean'],
    [false, 'dirty', 'conflict'],
    [true, 'unknown', 'unknown'],
    [true, 'draft', 'unknown'],
    [true, null, 'unknown'],
    [null, 'clean', 'unknown'],
    [null, 'dirty', 'unknown'],
    [true, 'something_new', 'unknown'],
  ];
  for (const [mergeable, state, expected] of table) {
    const http = fakeHttp({ [CS_DETAIL]: { number: 42, mergeable, mergeable_state: state, head: { sha: CS_SHA } } });
    const { prs } = await run(http, { repos: testRepos(['acme-status']) });
    assert.equal(prs[0].mergeable, expected, `${mergeable}/${state}`);
  }
});

const wr = (workflow_id, created_at, status, conclusion, head_sha = CS_SHA) => ({
  id: Math.floor(Math.random() * 1e9), workflow_id, head_sha, status, conclusion, created_at,
});

test('CI aggregation: latest run per workflow, failed beats running, none', async () => {
  const table = [
    ['no runs', [], 'none'],
    ['one success', [wr(1, '2026-11-06T10:00:00Z', 'completed', 'success')], 'ok'],
    ['skipped + success', [wr(1, '2026-11-06T10:00:00Z', 'completed', 'skipped'), wr(2, '2026-11-06T10:00:00Z', 'completed', 'success')], 'ok'],
    ['failure', [wr(1, '2026-11-06T10:00:00Z', 'completed', 'failure')], 'failed'],
    ['timed_out', [wr(1, '2026-11-06T10:00:00Z', 'completed', 'timed_out')], 'failed'],
    ['cancelled', [wr(1, '2026-11-06T10:00:00Z', 'completed', 'cancelled')], 'failed'],
    ['startup_failure', [wr(1, '2026-11-06T10:00:00Z', 'completed', 'startup_failure')], 'failed'],
    ['latest per workflow wins over an older failure', [
      wr(1, '2026-11-06T09:00:00Z', 'completed', 'failure'),
      wr(1, '2026-11-06T10:00:00Z', 'completed', 'success'),
    ], 'ok'],
    ['latest per workflow: newer failure wins', [
      wr(1, '2026-11-06T10:00:00Z', 'completed', 'failure'),
      wr(1, '2026-11-06T09:00:00Z', 'completed', 'success'),
    ], 'failed'],
    ['failed beats running', [wr(1, '2026-11-06T10:00:00Z', 'in_progress', null), wr(2, '2026-11-06T10:00:00Z', 'completed', 'failure')], 'failed'],
    ...['queued', 'in_progress', 'waiting', 'requested', 'pending'].map((s) => [
      `running: ${s}`, [wr(1, '2026-11-06T10:00:00Z', s, null), wr(2, '2026-11-06T10:00:00Z', 'completed', 'success')], 'running',
    ]),
    ['re-run in progress hides the old failure', [
      wr(1, '2026-11-06T09:00:00Z', 'completed', 'failure'),
      wr(1, '2026-11-06T10:00:00Z', 'queued', null),
    ], 'running'],
    ['runs for another sha are ignored', [wr(1, '2026-11-06T10:00:00Z', 'completed', 'failure', 'deadbeef')], 'none'],
  ];
  for (const [name, runs, expected] of table) {
    const http = fakeHttp({ [CS_RUNS]: { total_count: runs.length, workflow_runs: runs } });
    const { prs } = await run(http, { repos: testRepos(['acme-status']) });
    assert.equal(prs[0].ci, expected, name);
  }
});

test('CI cache: reuses only ok for the same sha; re-fetches failed (re-runs), none (not registered yet), running and unknown', async () => {
  const repos = testRepos(['acme-status']);
  const countRuns = (http) => http.paths().filter((p) => p === CS_RUNS).length;

  {
    const cache = new Map();
    const first = fakeHttp({ [CS_RUNS]: { total_count: 1, workflow_runs: [wr(1, '2026-11-06T10:00:00Z', 'completed', 'success')] } });
    assert.equal((await run(first, { repos, cache })).prs[0].ci, 'ok');
    assert.ok([...cache.keys()].every((k) => k.startsWith('gh:')), 'cache keys are prefixed gh:');
    const second = fakeHttp({ [CS_RUNS]: new HttpError({ status: 500, url: API + CS_RUNS }) });
    assert.equal((await run(second, { repos, cache })).prs[0].ci, 'ok', 'ok reused');
    assert.equal(countRuns(second), 0, 'ok not refetched');
  }

  for (const [runs, expected] of [
    [[wr(1, '2026-11-06T10:00:00Z', 'completed', 'failure')], 'failed'],
    [[], 'none'],
  ]) {
    const cache = new Map();
    const first = fakeHttp({ [CS_RUNS]: { total_count: runs.length, workflow_runs: runs } });
    assert.equal((await run(first, { repos, cache })).prs[0].ci, expected);
    const rerun = fakeHttp({ [CS_RUNS]: { total_count: 1, workflow_runs: [wr(1, '2026-11-06T11:00:00Z', 'completed', 'success')] } });
    assert.equal((await run(rerun, { repos, cache })).prs[0].ci, 'ok', `${expected} is refetched and picks up the new run`);
    assert.equal(countRuns(rerun), 1);
  }

  const cache = new Map();
  const running = fakeHttp({ [CS_RUNS]: { total_count: 1, workflow_runs: [wr(1, '2026-11-06T10:00:00Z', 'in_progress', null)] } });
  assert.equal((await run(running, { repos, cache })).prs[0].ci, 'running');
  const done = fakeHttp({ [CS_RUNS]: { total_count: 1, workflow_runs: [wr(1, '2026-11-06T10:00:00Z', 'completed', 'success')] } });
  assert.equal((await run(done, { repos, cache })).prs[0].ci, 'ok');
  assert.equal(countRuns(done), 1, 'running is refetched');

  const cache2 = new Map();
  const broken = fakeHttp({ [CS_RUNS]: new HttpError({ status: 502, url: API + CS_RUNS }) });
  assert.equal((await run(broken, { repos, cache: cache2 })).prs[0].ci, 'unknown');
  const healed = fakeHttp();
  assert.equal((await run(healed, { repos, cache: cache2 })).prs[0].ci, 'ok');
  assert.equal(countRuns(healed), 1, 'unknown is refetched');
});

test('compare cache: same base head + head sha is not fetched again; branch head is re-read every round', async () => {
  const repos = testRepos(['acme-status']);
  const cache = new Map();
  const first = fakeHttp();
  assert.equal((await run(first, { repos, cache })).prs[0].behindBy, 0);
  assert.equal(first.paths().filter((p) => p === CS_COMPARE).length, 1);

  const second = fakeHttp({ [CS_COMPARE]: new HttpError({ status: 500, url: API + CS_COMPARE }) });
  assert.equal((await run(second, { repos, cache })).prs[0].behindBy, 0);
  assert.equal(second.paths().filter((p) => p === CS_COMPARE).length, 0);
  assert.equal(second.paths().filter((p) => p === `${CS}/branches/main`).length, 1);

  // Base moved: new compare.
  const moved = 'f'.repeat(40);
  const third = fakeHttp({
    [`${CS}/branches/main`]: { name: 'main', commit: { sha: moved } },
    [`${CS}/compare/${moved}...${CS_SHA}`]: { status: 'diverged', ahead_by: 4, behind_by: 3, total_commits: 4 },
  });
  assert.equal((await run(third, { repos, cache })).prs[0].behindBy, 3);
});

test('branch names with a slash are encoded as one path segment', async () => {
  const target = 'feature/SHOP-1-base';
  const http = fakeHttp({
    [CS_LIST]: csListWithTarget(target),
    [`${CS}/branches/feature%2FSHOP-1-base`]: { name: target, commit: { sha: CS_MAIN } },
    [`${CS}/pulls?state=all&head=acme-corp%3Afeature%2FSHOP-1-base&per_page=20`]: [],
  });
  const { prs } = await run(http, { repos: testRepos(['acme-status']) });
  assert.equal(prs[0].behindBy, 0);
  assert.ok(http.paths().includes(`${CS}/branches/feature%2FSHOP-1-base`));
});

test('stacked PRs: basePr open > merged (newest) > closed (newest); none -> null; not stacked -> key omitted', async () => {
  const target = 'feature/SHOP-1-base';
  const lookup = `${CS}/pulls?state=all&head=acme-corp%3Afeature%2FSHOP-1-base&per_page=20`;
  const pr = (number, state, merged_at, updated_at) => ({
    number, state, merged_at, updated_at, created_at: '2026-01-01T00:00:00Z', closed_at: state === 'closed' ? updated_at : null,
    html_url: `https://github.com/acme-corp/acme-status/pull/${number}`,
    head: { ref: target, sha: 'a'.repeat(40) }, base: { ref: 'main' }, user: { login: 'x' },
  });
  const base = (lookupBody) => fakeHttp({
    [CS_LIST]: csListWithTarget(target),
    [`${CS}/branches/feature%2FSHOP-1-base`]: { name: target, commit: { sha: CS_MAIN } },
    [lookup]: lookupBody,
  });
  const repos = testRepos(['acme-status']);
  const url = (n) => `https://github.com/acme-corp/acme-status/pull/${n}`;

  const table = [
    ['open wins', [pr(1, 'closed', '2026-11-01T00:00:00Z', '2026-11-05T00:00:00Z'), pr(2, 'open', null, '2026-10-01T00:00:00Z')], { number: 2, state: 'open', url: url(2) }],
    ['merged newest', [
      pr(3, 'closed', null, '2026-11-06T00:00:00Z'),
      pr(4, 'closed', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z'),
      pr(5, 'closed', '2026-11-03T00:00:00Z', '2026-11-03T00:00:00Z'),
    ], { number: 5, state: 'merged', url: url(5) }],
    ['closed newest', [pr(6, 'closed', null, '2026-11-01T00:00:00Z'), pr(7, 'closed', null, '2026-11-04T00:00:00Z')], { number: 7, state: 'closed', url: url(7) }],
    ['none', [], null],
  ];
  for (const [name, body, expected] of table) {
    const { prs } = await run(base(body), { repos });
    assert.deepEqual(prs[0].basePr, expected, name);
  }

  // Real recorded head= lookup shape: a merged/open PR whose source is the target.
  const real = fakeHttp({
    [`${API_PATH}/pulls?state=open&per_page=100`]: [{ ...fixture(API_LIST)[0], base: { ref: 'feature/SHOP-42-checkout' } }],
    [`${API_PATH}/branches/feature%2FSHOP-42-checkout`]: { name: 'feature/SHOP-42-checkout', commit: { sha: '83cf6bbba06a66b9a55c5748de62802273b6d076' } },
  });
  const { prs: realPrs } = await run(real, { repos: testRepos(['acme-api']) });
  assert.deepEqual(realPrs[0].basePr, { number: 598, state: 'open', url: 'https://github.com/acme-corp/acme-api/pull/598' });

  for (const main of ['develop', 'main', 'master', 'staging', 'acceptance']) {
    const http = fakeHttp({
      [CS_LIST]: csListWithTarget(main),
      [`${CS}/branches/${main}`]: { name: main, commit: { sha: CS_MAIN } },
    });
    const { prs } = await run(http, { repos });
    assert.equal('basePr' in prs[0], false, `${main} is not stacked`);
    assert.equal(http.paths().some((p) => p.includes('head=')), false, `${main}: no head= lookup`);
  }
});

test('one repo list failing keeps the other repos and reports a short error', async () => {
  const lines = [];
  const http = fakeHttp({ [API_LIST]: new HttpError({ status: 403, url: API + API_LIST, body: '{"message":"Resource not accessible"}' }) });
  const { prs, errors } = await run(http, { log: (l) => lines.push(l) });
  assert.deepEqual(prs.map((p) => p.id), ['github:acme-status#42']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^acme-api: 403\b/);
  assert.ok(errors[0].length <= 200);
  for (const s of [...errors, ...lines]) assert.ok(!s.includes('ghp_') && !s.includes('Bearer'), 'no auth in output');
});

test('every repo list failing throws (the collector records a source error)', async () => {
  const http = fakeHttp({
    [API_LIST]: new HttpError({ status: 401, url: API + API_LIST }),
    [CS_LIST]: new HttpError({ status: 401, url: API + CS_LIST }),
  });
  await assert.rejects(run(http), /401/);
});

test('per-PR detail failures set that field to unknown/null and log one line, never failing the repo', async () => {
  const lines = [];
  const err = (path) => new HttpError({ status: 500, url: API + path, body: 'boom' });
  const http = fakeHttp({ [CS_DETAIL]: err(CS_DETAIL), [CS_RUNS]: err(CS_RUNS), [CS_COMPARE]: err(CS_COMPARE) });
  const { prs, errors } = await run(http, { repos: testRepos(['acme-status']), log: (l) => lines.push(l) });
  assert.equal(errors, undefined);
  assert.equal(prs[0].mergeable, 'unknown');
  assert.equal(prs[0].ci, 'unknown');
  assert.equal(prs[0].behindBy, null);
  assert.equal(prs[0].title.length > 0, true);
  assert.equal(lines.length, 3);
  for (const l of lines) {
    assert.ok(!l.includes('\n'), 'one line');
    assert.match(l, /acme-status#42/);
    assert.ok(!l.includes('Bearer') && !l.includes('ghp_'));
  }

  // Branch lookup failing -> behindBy null for every PR on that target, other fields intact.
  const http2 = fakeHttp({ [`${CS}/branches/main`]: err(`${CS}/branches/main`) });
  const { prs: prs2 } = await run(http2, { repos: testRepos(['acme-status']) });
  assert.equal(prs2[0].behindBy, null);
  assert.equal(prs2[0].ci, 'ok');

  // Base-PR lookup failing -> basePr omitted (unknown), never null ("no PR exists").
  const target = 'feature/SHOP-1-base';
  const lookup = `${CS}/pulls?state=all&head=acme-corp%3Afeature%2FSHOP-1-base&per_page=20`;
  const http3 = fakeHttp({
    [CS_LIST]: csListWithTarget(target),
    [`${CS}/branches/feature%2FSHOP-1-base`]: { name: target, commit: { sha: CS_MAIN } },
    [lookup]: err(lookup),
  });
  const { prs: prs3 } = await run(http3, { repos: testRepos(['acme-status']) });
  assert.equal('basePr' in prs3[0], false);
});

test('mine follows the me argument; me null makes every PR not mine', async () => {
  const { prs: asMe } = await run(fakeHttp());
  assert.equal(byId(asMe, 'github:acme-status#42').mine, true);
  const { prs: anon } = await run(fakeHttp(), { me: null });
  assert.ok(anon.length > 0);
  assert.ok(anon.every((p) => p.mine === false));
});

test('githubViewer: GET /user with auth and GitHub headers → login', async () => {
  const http = fakeHttp({ '/user': { login: 'octo', id: 1 } });
  assert.equal(await githubViewer({ http, auth: AUTH }), 'octo');
  assert.equal(http.calls.length, 1);
  const [{ url, opts }] = http.calls;
  assert.equal(url, `${API}/user`);
  assert.equal(opts.auth, AUTH);
  assert.equal(opts.headers.Accept, 'application/vnd.github+json');
  assert.equal(opts.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(opts.method, undefined);
});

test('githubViewer: a body without login throws', async () => {
  await assert.rejects(githubViewer({ http: fakeHttp({ '/user': {} }), auth: AUTH }), /login/);
});

test('owner comes from the project: API paths, head= lookup and the normalized owner', async () => {
  const project = { ...PROJECT, hosts: { github: { owner: 'acme-labs' } } };
  const repos = [{ host: 'github', repo: 'acme-status', repoShort: 'status', repoUrl: 'https://github.com/acme-labs/acme-status/pulls', defaultBranch: 'main' }];
  const labs = '/repos/acme-labs/acme-status';
  const list = csListWithTarget('feature/SHOP-1-base');
  const http = fakeHttp({
    [`${labs}/pulls?state=open&per_page=100`]: list,
    [`${labs}/pulls/42`]: fixture(CS_DETAIL),
    [`${labs}/actions/runs?head_sha=${CS_SHA}&per_page=50`]: fixture(CS_RUNS),
    [`${labs}/branches/feature%2FSHOP-1-base`]: { name: 'feature/SHOP-1-base', commit: { sha: CS_MAIN } },
    [`${labs}/compare/${CS_MAIN}...${CS_SHA}`]: fixture(CS_COMPARE),
    [`${labs}/pulls?state=all&head=acme-labs%3Afeature%2FSHOP-1-base&per_page=20`]: [],
  });
  const { prs, errors } = await run(http, { project, repos });
  assert.equal(errors, undefined);
  assert.equal(prs[0].owner, 'acme-labs');
  assert.equal(prs[0].basePr, null);
  assert.ok(http.paths().every((p) => p.startsWith(labs)), 'no other owner is called');
});

test('description: the PR body, null when empty or absent', async () => {
  for (const body of [null, '', undefined]) {
    const list = fixture(CS_LIST);
    if (body === undefined) delete list[0].body;
    else list[0].body = body;
    const { prs } = await run(fakeHttp({ [CS_LIST]: list }), { repos: testRepos(['acme-status']) });
    assert.equal(prs[0].description, null, String(body));
  }
});

test('defaultBranch comes from the repo; a PR into a non-standard default branch is not stacked', async () => {
  const repos = testRepos(['acme-status']).map((r) => ({ ...r, defaultBranch: 'trunk' }));
  const http = fakeHttp({
    [CS_LIST]: csListWithTarget('trunk'),
    [`${CS}/branches/trunk`]: { name: 'trunk', commit: { sha: CS_MAIN } },
  });
  const { prs } = await run(http, { repos });
  assert.equal(prs[0].defaultBranch, 'trunk');
  assert.equal('basePr' in prs[0], false);
  assert.equal(http.paths().some((p) => p.includes('head=')), false);
});

test('no repos: no calls and no PRs', async () => {
  const http = fakeHttp();
  assert.deepEqual(await run(http, { repos: [] }), { prs: [] });
  assert.equal(http.calls.length, 0);
});

// --- Lock reader (SPEC "Shared package check"): the GitHub reads of the shared package check.

const SH = '/repos/acme-corp/acme-shared';
const API_SHA = '17681ff4900c41dcdb6a6310b45683504323fadf';
const GH_LOCK_REF = 'e091054718b2bc350c5b704b7e18e6bdc0443b88';
const GH_SHARED_HEAD = '12925e26f48b04d0c804a9eae8251ca47ecf537e';
const RAW = 'application/vnd.github.raw+json';
const WINDOW_START = Date.parse('2026-10-07T00:00:00Z');

function lockReader(http, authCalls = { n: 0 }) {
  return githubLockReader({ http, owner: 'acme-corp', auth: async () => { authCalls.n += 1; return AUTH; } });
}

test('lock reader: readJson reads a file at a sha through the contents API, raw', async () => {
  const http = fakeHttp();
  const reader = lockReader(http);
  assert.deepEqual(await reader.readJson('acme-api', API_SHA, 'composer.json'), fixture(`${API_PATH}/contents/composer.json?ref=${API_SHA}`));
  const lock = await reader.readJson('acme-api', API_SHA, 'composer.lock');
  assert.equal(lock['packages-dev'][0].source.reference, GH_LOCK_REF);
  assert.deepEqual(http.paths(), [
    `${API_PATH}/contents/composer.json?ref=${API_SHA}`,
    `${API_PATH}/contents/composer.lock?ref=${API_SHA}`,
  ]);
  for (const { opts } of http.calls) {
    assert.equal(opts.auth, AUTH);
    assert.equal(opts.headers.Accept, RAW);
    assert.equal(opts.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.equal(opts.method, undefined);
  }
});

test('lock reader: auth is asked once per reader, and only when a read happens', async () => {
  const authCalls = { n: 0 };
  const reader = lockReader(fakeHttp(), authCalls);
  assert.equal(authCalls.n, 0);
  await reader.readJson('acme-api', API_SHA, 'composer.json');
  await reader.branchHead('acme-shared', 'main');
  assert.equal(authCalls.n, 1);
});

test('lock reader: a failed read rejects (the caller reports it)', async () => {
  await assert.rejects(lockReader(fakeHttp()).readJson('acme-api', 'f'.repeat(40), 'composer.json'), (err) => err.status === 404);
});

test('lock reader: branchHead is the branch commit sha (slashes encoded)', async () => {
  const http = fakeHttp({ [`${SH}/branches/release%2F2`]: { name: 'release/2', commit: { sha: 'b'.repeat(40) } } });
  const reader = lockReader(http);
  assert.equal(await reader.branchHead('acme-shared', 'main'), GH_SHARED_HEAD);
  assert.equal(await reader.branchHead('acme-shared', 'release/2'), 'b'.repeat(40));
  assert.equal(http.calls[0].opts.headers.Accept, 'application/vnd.github+json');
});

test('lock reader: mergedPrs keeps the closed PRs merged since the window start that have a merge sha', async () => {
  const http = fakeHttp();
  const merged = await lockReader(http).mergedPrs('acme-shared', WINDOW_START);
  assert.deepEqual(http.paths(), [`${SH}/pulls?state=closed&sort=updated&direction=desc&per_page=50`]);
  assert.deepEqual(merged, [
    {
      number: 7, url: 'https://github.com/acme-corp/acme-shared/pull/7',
      title: 'feat(orders): send the order to every warehouse - SHOP-42', source: 'feature/SHOP-42-checkout',
      description: 'Sends the order to every warehouse.', mergeSha: '2566fb2c8633321d45ed13b859a3a5056dab242b',
    },
    {
      number: 3, url: 'https://github.com/acme-corp/acme-shared/pull/3',
      title: 'fix: card link in the order mail', source: 'fix/trello-card',
      description: 'See https://trello.com/c/AbC123/95-checkout', mergeSha: '0b1aea3e58f762938905eb9bb92b125684bb498a',
    },
    {
      number: 6, url: 'https://github.com/acme-corp/acme-shared/pull/6',
      title: 'SHOP-41: filter offered products on offer type', source: 'feature/SHOP-41-offer-type',
      description: null, mergeSha: 'df71a980b020a19517fb46d31edecbd69684cebc',
    },
  ]);
});

test('lock reader: commitsLacking lists the compare commits from the lock ref to the head', async () => {
  const http = fakeHttp();
  const shas = await lockReader(http).commitsLacking('acme-shared', GH_LOCK_REF, GH_SHARED_HEAD);
  assert.deepEqual(shas, ['2566fb2c8633321d45ed13b859a3a5056dab242b', GH_SHARED_HEAD]);
  assert.deepEqual(http.paths(), [`${SH}/compare/${GH_LOCK_REF}...${GH_SHARED_HEAD}`]);
});

test('lock reader: prBySourceBranch is the base-PR lookup on the shared repo (open, merged, none)', async () => {
  const lookup = (branch) => `${SH}/pulls?state=all&head=${encodeURIComponent(`acme-corp:${branch}`)}&per_page=20`;
  const reader = lockReader(fakeHttp({
    [lookup('feature/SHOP-9-done')]: [{ number: 2, state: 'closed', merged_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', html_url: 'https://github.com/acme-corp/acme-shared/pull/2' }],
    [lookup('feature/SHOP-9-gone')]: [],
  }));
  assert.deepEqual(await reader.prBySourceBranch('acme-shared', 'feature/SHOP-42-checkout'), { number: 8, state: 'open', url: 'https://github.com/acme-corp/acme-shared/pull/8' });
  assert.deepEqual(await reader.prBySourceBranch('acme-shared', 'feature/SHOP-9-done'), { number: 2, state: 'merged', url: 'https://github.com/acme-corp/acme-shared/pull/2' });
  assert.equal(await reader.prBySourceBranch('acme-shared', 'feature/SHOP-9-gone'), null);
});
