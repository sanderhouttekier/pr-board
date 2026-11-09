import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectBitbucket, bitbucketViewer, bitbucketLockReader } from '../src/sources/bitbucket.js';
import { HttpError } from '../src/http.js';

// Recorded live 2026-11-06 (backend #2504, web #3487, shared #215, shared merged list), bodies only, trimmed.
const FIX = new URL('./fixtures/bitbucket/', import.meta.url);
const fixture = (name) => JSON.parse(readFileSync(new URL(name, FIX), 'utf8'));
const ROUTES = fixture('routes.json');

const AUTH = 'Basic dGVzdDp0ZXN0LXNlY3JldA==';
const API = 'https://api.bitbucket.org/2.0/repositories/acme/';
const A = `${API}acme-web`;

const BACKEND_SHA = '5eefa8141168f3c3eafaf20df2d410819fd97aa7';
const WEB_SHA = '825c9227687aa27470b9f9fb5e44c907d112840c';
const LOCK_REF = '597950ed303b893b4db8dd05ae30232070b828f2';

// The exact URLs the source is expected to request (they are the keys of routes.json).
const urlFor = (file) => {
  const url = Object.keys(ROUTES).find((u) => ROUTES[u] === file);
  assert.ok(url, `no route for ${file}`);
  return url;
};
const U = {
  backendStatuses: urlFor('backend-statuses.json'),
  backendDiffstat: urlFor('backend-diffstat.json'),
  backendBehind: urlFor('backend-behind.json'),
  backendCommit: urlFor('backend-commit.json'),
  backendComposer: urlFor('backend-composer.json'),
  backendLock: urlFor('backend-composer-lock.json'),
  backendList: urlFor('backend-list.json'),
  webList: urlFor('web-list.json'),
  webStatuses: urlFor('web-statuses.json'),
  webDiffstat: urlFor('web-diffstat.json'),
  webBehind: urlFor('web-behind.json'),
  webByBranch: urlFor('web-by-branch-SHOP-42.json'),
  pkgMerged: urlFor('shared-merged.json'),
  pkgByBranch: urlFor('shared-by-branch-SHOP-42.json'),
  pkgSinceLock: urlFor('shared-commits-since-lock.json'),
  pkgRefDevelop: urlFor('shared-ref-develop.json'),
};

// Made-up project (see projects/example.json), with Bitbucket repos as repoSet gives them.
const PROJECT = {
  title: 'Acme',
  hosts: { github: { owner: 'acme-corp' }, bitbucket: { workspace: 'acme' } },
  tickets: [{ prefix: 'SHOP', browse: 'https://jira.example.com/browse/{key}', jira: 'main' }, { prefix: 'OPS', browse: null }],
  jira: { main: { cloudId: '00000000-0000-4000-8000-000000000000' } },
  sharedPackages: [{ repo: 'acme-shared', kind: 'composer', package: 'acme/shared', consumers: ['acme-backend', 'acme-worker'] }],
};
const SHORT_TO_REPO = { shared: 'acme-shared', backend: 'acme-backend', worker: 'acme-worker', web: 'acme-web' };

function testRepos(shorts = ['backend', 'web', 'shared'], defaultBranch = 'develop') {
  return shorts.map((repoShort) => {
    const repo = SHORT_TO_REPO[repoShort];
    return { host: 'bitbucket', repo, repoShort, repoUrl: `https://bitbucket.org/acme/${repo}/pull-requests/`, defaultBranch };
  });
}

// Fake http: serves recorded fixtures by exact URL; overrides win (a body, or an Error to throw).
function fakeHttp(overrides = {}) {
  const calls = [];
  const resolve = (url, opts) => {
    calls.push(url);
    assert.equal(opts?.auth, AUTH, `auth not passed for ${url}`);
    if (url in overrides) {
      const v = overrides[url];
      if (v instanceof Error) throw v;
      return structuredClone(v);
    }
    if (url in ROUTES) return fixture(ROUTES[url]);
    throw new HttpError({ status: 404, url, message: `GET ${url} failed with 404 (no fixture)` });
  };
  return {
    calls,
    count: (url) => calls.filter((c) => c === url).length,
    get: async (url, opts) => resolve(url, opts),
    getAll: async (url, opts) => resolve(url, opts).values ?? [],
  };
}

const ME = '{f86c9766-3a9b-4cf6-8a5d-0c0fc2a70e76}';

async function run({ overrides, shorts, cache = new Map(), http = fakeHttp(overrides), me = ME, project = PROJECT, repos = testRepos(shorts) } = {}) {
  const logs = [];
  const res = await collectBitbucket({ project, repos, http, auth: async () => AUTH, cache, log: (l) => logs.push(l), me });
  const by = Object.fromEntries(res.prs.map((p) => [p.id, p]));
  return { res, by, http, logs, cache };
}

const BACKEND_ID = 'bitbucket:acme-backend#2504';
const WEB_ID = 'bitbucket:acme-web#3487';
const PKG_ID = 'bitbucket:acme-shared#215';

test('normalizes backend #2504 exactly per SPEC, with the full head sha', async () => {
  const { res, by, logs } = await run();
  assert.equal(res.errors, undefined);
  assert.deepEqual(by[BACKEND_ID], {
    id: BACKEND_ID,
    host: 'bitbucket',
    owner: 'acme',
    repo: 'acme-backend',
    repoShort: 'backend',
    repoUrl: 'https://bitbucket.org/acme/acme-backend/pull-requests/',
    defaultBranch: 'develop',
    number: 2504,
    title: 'feat(checkout): send the order to every warehouse, with the shop language - SHOP-42',
    url: 'https://bitbucket.org/acme/acme-backend/pull-requests/2504',
    description: 'Sends the order to every warehouse.\n\nhttps://trello.com/c/AbC123/95-checkout',
    author: { name: 'Ada Example', id: '{f86c9766-3a9b-4cf6-8a5d-0c0fc2a70e76}' },
    mine: true,
    source: 'feature/SHOP-42-checkout',
    target: 'develop',
    headSha: BACKEND_SHA,
    draft: false,
    createdAt: '2026-11-06T12:41:56.187298+00:00',
    updatedAt: '2026-11-06T13:47:54.412707+00:00',
    ci: 'failed',
    mergeable: 'clean',
    behindBy: 4,
    locks: [],
  });
  assert.ok(!('basePr' in by[BACKEND_ID]), 'basePr key only on stacked PRs');
  assert.deepEqual(logs, []);
});

test('web and shared: CI ok, behind counts', async () => {
  const { by } = await run();
  assert.equal(by[WEB_ID].headSha, WEB_SHA);
  assert.equal(by[WEB_ID].ci, 'ok');
  assert.equal(by[WEB_ID].behindBy, 25);
  assert.equal(by[PKG_ID].headSha, '788d0ba1c51f78860fee4e9002210a69d78eda25');
  assert.equal(by[PKG_ID].behindBy, 0);
});

test('the source reads no lock files: every PR has locks [] (src/sharedPackages.js fills them)', async () => {
  const { res, http } = await run();
  assert.ok(res.prs.length > 0);
  assert.ok(res.prs.every((p) => Array.isArray(p.locks) && p.locks.length === 0));
  assert.equal(http.calls.some((u) => u.includes('/src/') || u.includes('state%3D%22MERGED%22') || u.includes('exclude=597950ed')), false);
});

test('mine is false for another author uuid; draft is read from the PR', async () => {
  const list = fixture('web-list.json');
  list.values[0].author = { display_name: 'Linus', uuid: '{other}' };
  list.values[0].draft = true;
  const { by } = await run({ overrides: { [U.webList]: list } });
  assert.equal(by[WEB_ID].mine, false);
  assert.deepEqual(by[WEB_ID].author, { name: 'Linus', id: '{other}' });
  assert.equal(by[WEB_ID].draft, true);
});

test('draft defaults to false when the field is absent', async () => {
  const list = fixture('web-list.json');
  delete list.values[0].draft;
  const { by } = await run({ overrides: { [U.webList]: list } });
  assert.equal(by[WEB_ID].draft, false);
});

const st = (...states) => ({ values: states.map((state, i) => ({ key: `k${i}`, state })) });
for (const [states, ci] of [
  [[], 'none'],
  [['SUCCESSFUL'], 'ok'],
  [['SUCCESSFUL', 'INPROGRESS'], 'running'],
  [['INPROGRESS', 'FAILED'], 'failed'],
  [['SUCCESSFUL', 'STOPPED'], 'failed'],
]) {
  test(`CI: statuses [${states.join(', ')}] → ${ci}`, async () => {
    const { by } = await run({ overrides: { [U.webStatuses]: st(...states) } });
    assert.equal(by[WEB_ID].ci, ci);
  });
}

test('CI: a failing statuses call → unknown and one log line without auth', async () => {
  const { by, logs } = await run({ overrides: { [U.webStatuses]: new HttpError({ status: 500, url: U.webStatuses }) } });
  assert.equal(by[WEB_ID].ci, 'unknown');
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes(AUTH) && !logs[0].includes('dGVzdDp0ZXN0LXNlY3JldA'));
});

test('conflicts: a merge conflict entry in the diffstat → conflict', async () => {
  const ds = fixture('web-diffstat.json');
  ds.values.push({ status: 'merge conflict' });
  const { by } = await run({ overrides: { [U.webDiffstat]: ds } });
  assert.equal(by[WEB_ID].mergeable, 'conflict');
});

test('conflicts: a failing diffstat → unknown', async () => {
  const { by, logs } = await run({ overrides: { [U.webDiffstat]: new HttpError({ status: 500, url: U.webDiffstat }) } });
  assert.equal(by[WEB_ID].mergeable, 'unknown');
  assert.equal(logs.length, 1);
});

test('behind: a full page of 100 is reported as 100; failure → null', async () => {
  const page = { values: Array.from({ length: 100 }, (_, i) => ({ hash: String(i).padStart(40, '0') })) };
  const { by } = await run({ overrides: { [U.webBehind]: page, [U.backendBehind]: new HttpError({ status: 500, url: U.backendBehind }) } });
  assert.equal(by[WEB_ID].behindBy, 100);
  assert.equal(by[BACKEND_ID].behindBy, null);
});

test('caching: round 2 reuses ok CI, conflicts, behind and sha; still lists PRs', async () => {
  const cache = new Map();
  const http = fakeHttp();
  await run({ cache, http });
  const first = http.calls.length;
  const { by } = await run({ cache, http });
  const second = http.calls.slice(first);
  for (const url of [U.webStatuses, U.backendDiffstat, U.webDiffstat, U.backendBehind, U.webBehind, U.backendCommit]) {
    assert.equal(second.filter((c) => c === url).length, 0, `round 2 refetched ${url}`);
  }
  assert.ok(second.includes(U.backendList) && second.includes(U.webList));
  assert.equal(by[BACKEND_ID].ci, 'failed');
  assert.equal(by[WEB_ID].behindBy, 25);
  assert.ok([...cache.keys()].every((k) => k.startsWith('bb:')), 'cache keys are prefixed bb:');
});

for (const [label, body] of [['running', st('INPROGRESS')], ['failed (re-runnable)', st('FAILED')], ['none (not registered yet)', st()], ['unknown', new HttpError({ status: 500, url: 'x' })]]) {
  test(`caching: ${label} CI is fetched again next round`, async () => {
    const cache = new Map();
    const http = fakeHttp({ [U.webStatuses]: body });
    await run({ cache, http });
    await run({ cache, http });
    assert.equal(http.count(U.webStatuses), 2);
  });
}

test('caching: a new target head refetches conflicts and behind', async () => {
  const cache = new Map();
  await run({ cache, http: fakeHttp() });
  const newHead = 'f'.repeat(40);
  const refUrl = `${A}/refs/branches/develop?fields=target.hash`;
  const behindUrl = `${A}/commits?include=${newHead}&exclude=${WEB_SHA}&pagelen=100&fields=values.hash`;
  const http = fakeHttp({ [refUrl]: { target: { hash: newHead } }, [behindUrl]: { values: [{ hash: 'x' }] } });
  const { by } = await run({ cache, http });
  assert.equal(http.count(U.webDiffstat), 1);
  assert.equal(by[WEB_ID].behindBy, 1);
});

// Stacked: web PR targeting the backend-style Ticket branch of #3487.
function stackedOverrides(byBranch) {
  const target = 'feature/SHOP-42-checkout';
  const head = 'e'.repeat(40);
  const list = fixture('web-list.json');
  const stacked = structuredClone(list.values[0]);
  stacked.id = 3490;
  stacked.source.branch.name = 'feature/SHOP-42-stacked';
  stacked.destination.branch.name = target;
  stacked.links.html.href = 'https://bitbucket.org/acme/acme-web/pull-requests/3490';
  list.values.push(stacked);
  return {
    [U.webList]: list,
    [`${A}/refs/branches/${encodeURIComponent(target)}?fields=target.hash`]: { target: { hash: head } },
    [`${A}/pullrequests/3490/diffstat?pagelen=500&fields=values.status,next`]: { values: [] },
    [`${A}/commits?include=${head}&exclude=${WEB_SHA}&pagelen=100&fields=values.hash`]: { values: [] },
    ...(byBranch === undefined ? {} : { [U.webByBranch]: byBranch }),
  };
}
const STACKED_ID = 'bitbucket:acme-web#3490';

test('stacked: basePr is the open PR whose source is the target', async () => {
  const { by } = await run({ overrides: stackedOverrides() });
  assert.deepEqual(by[STACKED_ID].basePr, { number: 3487, state: 'open', url: 'https://bitbucket.org/acme/acme-web/pull-requests/3487' });
  assert.ok(!('basePr' in by[WEB_ID]));
});

const prv = (id, state, updated) => ({ id, state, updated_on: updated, links: { html: { href: `https://bb/pr/${id}` } } });
test('stacked: no open → newest merged; else newest declined/superseded; none → null', async () => {
  let r = await run({ overrides: stackedOverrides({ values: [prv(1, 'DECLINED', '2026-11-05T00:00:00Z'), prv(2, 'MERGED', '2026-11-01T00:00:00Z'), prv(3, 'MERGED', '2026-11-03T00:00:00Z')] }) });
  assert.deepEqual(r.by[STACKED_ID].basePr, { number: 3, state: 'merged', url: 'https://bb/pr/3' });
  r = await run({ overrides: stackedOverrides({ values: [prv(4, 'DECLINED', '2026-11-01T00:00:00Z'), prv(5, 'SUPERSEDED', '2026-11-02T00:00:00Z')] }) });
  assert.deepEqual(r.by[STACKED_ID].basePr, { number: 5, state: 'declined', url: 'https://bb/pr/5' });
  r = await run({ overrides: stackedOverrides({ values: [] }) });
  assert.equal(r.by[STACKED_ID].basePr, null);
});

test('stacked: a failing basePr lookup leaves basePr undefined (key omitted), not null', async () => {
  const { by, logs } = await run({ overrides: stackedOverrides(new HttpError({ status: 500, url: U.webByBranch })) });
  assert.ok(by[STACKED_ID]);
  assert.ok(!('basePr' in by[STACKED_ID]));
  assert.equal(logs.length, 1);
});

test('one repo list failing → other repos returned and that repo in errors', async () => {
  const { res, by } = await run({ shorts: ['backend', 'web', 'worker'], overrides: { [U.backendList]: new HttpError({ status: 503, url: U.backendList }) } });
  assert.ok(by[WEB_ID]);
  assert.ok(!by[BACKEND_ID]);
  assert.equal(res.errors.length, 2, 'backend (503) and worker (no fixture → 404)');
  assert.ok(res.errors.some((e) => e.startsWith('backend: ')));
  assert.ok(res.errors.some((e) => e.startsWith('worker: ')));
  assert.ok(res.errors.every((e) => !e.includes(AUTH)));
});

test('only GET helpers on api.bitbucket.org are used', async () => {
  const http = fakeHttp();
  const res = await collectBitbucket({ project: PROJECT, repos: testRepos(['backend']), http, auth: async () => AUTH, cache: new Map() });
  assert.ok(http.calls.every((u) => u.startsWith('https://api.bitbucket.org/2.0/')));
  assert.ok(res.prs.every((p) => p.host === 'bitbucket'));
  assert.equal(res.errors, undefined);
});

test('mine follows the me argument; me null makes every PR not mine', async () => {
  const { by } = await run();
  assert.equal(by[BACKEND_ID].mine, true);
  const { res } = await run({ me: null });
  assert.ok(res.prs.length > 0);
  assert.ok(res.prs.every((p) => p.mine === false));
});

test('bitbucketViewer: GET /2.0/user?fields=uuid with auth → uuid', async () => {
  const url = 'https://api.bitbucket.org/2.0/user?fields=uuid';
  const http = fakeHttp({ [url]: { uuid: '{abc}' } });
  assert.equal(await bitbucketViewer({ http, auth: AUTH }), '{abc}');
  assert.deepEqual(http.calls, [url]);
});

test('bitbucketViewer: a body without uuid throws', async () => {
  const url = 'https://api.bitbucket.org/2.0/user?fields=uuid';
  await assert.rejects(bitbucketViewer({ http: fakeHttp({ [url]: {} }), auth: AUTH }), /uuid/);
});

test('description: description, else summary.raw, else null', async () => {
  const list = fixture('web-list.json');
  const pr0 = list.values[0];
  const cases = [
    [{ description: 'own text', summary: { raw: 'summary text' } }, 'own text'],
    [{ summary: { raw: 'summary text' } }, 'summary text'],
    [{ description: '', summary: { raw: '' } }, null],
    [{}, null],
  ];
  for (const [fields, expected] of cases) {
    const raw = { ...structuredClone(pr0), ...fields };
    if (!('description' in fields)) delete raw.description;
    if (!('summary' in fields)) delete raw.summary;
    const { by } = await run({ shorts: ['web'], overrides: { [U.webList]: { values: [raw] } } });
    assert.equal(by[WEB_ID].description, expected, JSON.stringify(fields));
  }
});

test('the workspace comes from the project: list URL and normalized owner', async () => {
  const project = { ...PROJECT, hosts: { bitbucket: { workspace: 'acme-labs' } }, sharedPackages: [] };
  const listUrl = U.webList.replace('/repositories/acme/', '/repositories/acme-labs/');
  const http = fakeHttp({ [listUrl]: { values: [] } });
  const repos = [{ host: 'bitbucket', repo: 'acme-web', repoShort: 'web', repoUrl: 'https://bitbucket.org/acme-labs/acme-web/pull-requests/', defaultBranch: 'develop' }];
  const { res } = await run({ http, project, repos });
  assert.deepEqual(res, { prs: [] });
  assert.deepEqual(http.calls, [listUrl]);

  const raw = fixture('web-list.json').values[0];
  delete raw.links;
  const http2 = fakeHttp({ [listUrl]: { values: [raw] } });
  const { res: res2 } = await run({ http: http2, project, repos });
  assert.equal(res2.prs[0].owner, 'acme-labs');
  assert.equal(res2.prs[0].url, 'https://bitbucket.org/acme-labs/acme-web/pull-requests/3487');
});

test('stacked: a PR into the repo default branch (non-standard name) is not stacked', async () => {
  const list = fixture('web-list.json');
  list.values[0].destination.branch.name = 'trunk';
  const head = 'd'.repeat(40);
  const { by, http } = await run({
    shorts: ['web'],
    repos: testRepos(['web'], 'trunk'),
    overrides: {
      [U.webList]: list,
      [`${A}/refs/branches/trunk?fields=target.hash`]: { target: { hash: head } },
      [`${A}/commits?include=${head}&exclude=${WEB_SHA}&pagelen=100&fields=values.hash`]: { values: [] },
    },
  });
  assert.equal(by[WEB_ID].defaultBranch, 'trunk');
  assert.ok(!('basePr' in by[WEB_ID]));
  assert.equal(http.calls.some((u) => u.includes('q=source.branch.name')), false);
});

// --- Lock reader (SPEC "Shared package check"): the Bitbucket reads of the shared package check.

const SHARED_DEVELOP_HEAD = '1a9ce1309b560fee740a8e5fe211c733ece40786';

function lockReader(http, authCalls = { n: 0 }) {
  return bitbucketLockReader({ http, owner: 'acme', auth: async () => { authCalls.n += 1; return AUTH; } });
}

test('lock reader: readJson reads a file at a sha through /src', async () => {
  const http = fakeHttp();
  const reader = lockReader(http);
  assert.deepEqual(await reader.readJson('acme-backend', BACKEND_SHA, 'composer.json'), fixture('backend-composer.json'));
  assert.deepEqual(await reader.readJson('acme-backend', BACKEND_SHA, 'composer.lock'), fixture('backend-composer-lock.json'));
  assert.deepEqual(http.calls, [U.backendComposer, U.backendLock]);
});

test('lock reader: auth is asked once per reader, and only when a read happens', async () => {
  const authCalls = { n: 0 };
  const reader = lockReader(fakeHttp(), authCalls);
  assert.equal(authCalls.n, 0);
  await reader.readJson('acme-backend', BACKEND_SHA, 'composer.json');
  await reader.branchHead('acme-shared', 'develop');
  assert.equal(authCalls.n, 1);
});

test('lock reader: a failed read rejects (the caller reports it)', async () => {
  await assert.rejects(lockReader(fakeHttp()).readJson('acme-backend', 'f'.repeat(40), 'composer.json'), (err) => err.status === 404);
});

test('lock reader: branchHead is the branch target hash', async () => {
  const http = fakeHttp();
  assert.equal(await lockReader(http).branchHead('acme-shared', 'develop'), SHARED_DEVELOP_HEAD);
  assert.deepEqual(http.calls, [U.pkgRefDevelop]);
});

test('lock reader: mergedPrs lists the PRs merged since the window start (one query, all pages)', async () => {
  const http = fakeHttp();
  const merged = await lockReader(http).mergedPrs('acme-shared', Date.parse('2026-10-07T00:00:00Z'));
  assert.deepEqual(http.calls, [U.pkgMerged]);
  assert.deepEqual(merged.map((m) => m.number), [214, 213, 212, 211, 210, 208, 209, 207]);
  assert.deepEqual(merged[1], {
    number: 213, url: 'https://bitbucket.org/acme/acme-shared/pull-requests/213',
    title: 'SHOP-41: filter offered products on offer type (product/tool)', source: 'feature/SHOP-41-offer-type',
    description: null, mergeSha: '597950ed303b',
  });
});

test('lock reader: mergedPrs drops PRs without a merge commit, not merged, or updated before the window', async () => {
  const list = fixture('shared-merged.json');
  list.values[0].merge_commit = null;
  list.values[1].state = 'DECLINED';
  list.values[2].updated_on = '2026-10-06T23:59:59+00:00';
  const merged = await lockReader(fakeHttp({ [U.pkgMerged]: list })).mergedPrs('acme-shared', Date.parse('2026-10-07T00:00:00Z'));
  assert.deepEqual(merged.map((m) => m.number), [211, 210, 208, 209, 207]);
});

test('lock reader: commitsLacking lists the head commits the lock ref lacks', async () => {
  const http = fakeHttp();
  const shas = await lockReader(http).commitsLacking('acme-shared', LOCK_REF, SHARED_DEVELOP_HEAD);
  assert.deepEqual(shas, [SHARED_DEVELOP_HEAD, '47aad769eb40e9de53e2aef75727ae9a3a6e7142']);
  assert.deepEqual(http.calls, [U.pkgSinceLock]);
});

test('lock reader: prBySourceBranch is the base-PR lookup on the shared repo (open, merged, none)', async () => {
  const reader = lockReader(fakeHttp());
  assert.deepEqual(await reader.prBySourceBranch('acme-shared', 'feature/SHOP-42-checkout'), { number: 215, state: 'open', url: 'https://bitbucket.org/acme/acme-shared/pull-requests/215' });
  const byBranch = fixture('shared-by-branch-SHOP-42.json');
  byBranch.values[0].state = 'MERGED';
  assert.equal((await lockReader(fakeHttp({ [U.pkgByBranch]: byBranch })).prBySourceBranch('acme-shared', 'feature/SHOP-42-checkout')).state, 'merged');
  assert.equal(await lockReader(fakeHttp({ [U.pkgByBranch]: { values: [] } })).prBySourceBranch('acme-shared', 'feature/SHOP-42-checkout'), null);
});
