import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSharedPackageCheck } from '../src/sharedPackages.js';
import { enrich } from '../src/derive.js';
import { repoSet } from '../src/discover.js';
import { collectBitbucket } from '../src/sources/bitbucket.js';
import { HttpError } from '../src/http.js';

const NOW = Date.parse('2026-11-06T22:00:00Z');
const EXAMPLE = JSON.parse(readFileSync(new URL('../projects/example.json', import.meta.url), 'utf8'));
const MATCHERS = EXAMPLE.tickets;

const SHA = '5eefa8141168f3c3eafaf20df2d410819fd97aa7';
const LOCK = '597950ed303b893b4db8dd05ae30232070b828f2';
const HEAD = '1a9ce1309b560fee740a8e5fe211c733ece40786';
const M7 = '47aad769eb40e9de53e2aef75727ae9a3a6e7142';

const repo = (host, name, repoShort, defaultBranch) => ({
  host,
  repo: name,
  repoShort,
  repoUrl: host === 'github' ? `https://github.com/acme-corp/${name}/pulls` : `https://bitbucket.org/acme/${name}/pull-requests/`,
  defaultBranch,
});
// Every repo of the example project, as repoSet gives them (all on Bitbucket).
const REPOS = [
  repo('bitbucket', 'acme-shared', 'shared', 'develop'),
  repo('bitbucket', 'acme-backend', 'backend', 'develop'),
  repo('bitbucket', 'acme-worker', 'worker', 'develop'),
  repo('bitbucket', 'acme-web', 'web', 'develop'),
];
const SHARED = { host: 'bitbucket', repo: 'acme-shared', repoShort: 'shared', defaultBranch: 'develop' };

let seq = 100;
function makePr(name, over = {}) {
  const r = [...REPOS, repo('github', name, name, 'main')].find((x) => x.repo === name && x.host === (over.host ?? 'bitbucket'));
  const number = over.number ?? ++seq;
  return {
    id: `${r.host}:${name}#${number}`,
    host: r.host,
    owner: r.host === 'github' ? 'acme-corp' : 'acme',
    repo: name,
    repoShort: r.repoShort,
    repoUrl: r.repoUrl,
    defaultBranch: r.defaultBranch,
    number,
    title: 'feat(checkout): send the order - SHOP-42',
    url: `https://bitbucket.org/acme/${name}/pull-requests/${number}`,
    description: null,
    source: 'feature/SHOP-42-checkout',
    target: 'develop',
    headSha: SHA,
    locks: [],
    ...over,
  };
}

const composer = (require) => ({ require: { php: '>=8.3', ...require } });
const composerLock = (refs, dev = {}) => ({
  packages: Object.entries(refs).map(([name, reference]) => ({ name, source: { type: 'git', reference } })),
  'packages-dev': Object.entries(dev).map(([name, reference]) => ({ name, source: { type: 'git', reference } })),
});
const merged = (number, source, mergeSha, extra = {}) => ({
  number, url: `https://example.test/acme-shared/${number}`, title: `shared ${number}`, source, description: null, mergeSha, ...extra,
});

// Fake host readers over a table per host. A value that is an Error is thrown. Every read is logged in
// `calls` as "<host> <what> <key>", and each factory call records its owner. Like the real readers, a
// reader asks its auth once, on its first read.
function fakeReaders(world) {
  const calls = [];
  const owners = [];
  const make = (host) => ({ owner, auth }) => {
    owners.push(`${host}:${owner}`);
    const w = world[host] ?? {};
    let authValue;
    const serve = async (what, key, table) => {
      calls.push(`${host} ${what} ${key}`);
      await (authValue ??= auth());
      const v = table?.[key];
      if (v instanceof Error) throw v;
      if (v === undefined) throw new HttpError({ status: 404, url: key, message: `GET ${key} failed with 404` });
      return structuredClone(v);
    };
    return {
      readJson: (r, sha, path) => serve('read', `${r}@${sha}/${path}`, w.files),
      branchHead: (r, branch) => serve('head', `${r}:${branch}`, w.heads),
      mergedPrs: (r, since) => serve('merged', `${r}>=${new Date(since).toISOString()}`, w.merged),
      commitsLacking: (r, lockRef, head) => serve('lacking', `${r}:${lockRef}...${head}`, w.lacking),
      prBySourceBranch: (r, branch) => serve('pr', `${r}:${branch}`, w.prs),
    };
  };
  return { readers: { github: make('github'), bitbucket: make('bitbucket') }, calls, owners };
}

const SINCE = '2026-10-07T00:00:00.000Z';
// A Bitbucket world where backend #SHA locks acme/shared at LOCK, and shared develop is at HEAD.
// `constraint: null` leaves acme/shared out of composer.json, `lockRef: null` out of composer.lock.
function bbWorld({ constraint = 'dev-develop', lockRef = LOCK, mergedList = [], lacking = [HEAD], prs = {}, files = {} } = {}) {
  return {
    bitbucket: {
      files: {
        [`acme-backend@${SHA}/composer.json`]: composer(constraint === null ? {} : { 'acme/shared': constraint }),
        [`acme-backend@${SHA}/composer.lock`]: composerLock(lockRef ? { 'acme/shared': lockRef } : {}),
        ...files,
      },
      heads: { 'acme-shared:develop': HEAD, 'acme-shared:main': HEAD },
      merged: { [`acme-shared>=${SINCE}`]: mergedList },
      lacking: { [`acme-shared:${lockRef}...${HEAD}`]: lacking },
      prs,
    },
  };
}

function authCounter() {
  const n = { github: 0, bitbucket: 0 };
  return {
    n,
    auth: {
      github: async () => { n.github += 1; return 'Bearer gh-test'; },
      bitbucket: async () => { n.bitbucket += 1; return 'Basic bb-test'; },
    },
  };
}

async function check({ world, prs, project = EXAMPLE, repos = REPOS, lockCheck, fakes = fakeReaders(world), counter = authCounter() }) {
  const logs = [];
  const run = lockCheck ?? createSharedPackageCheck({ http: {}, readers: fakes.readers });
  const out = await run(prs, { project, repos, auth: counter.auth, now: NOW, matchers: MATCHERS, log: (l) => logs.push(l) });
  return { out, logs, calls: fakes.calls, owners: fakes.owners, auth: counter.n };
}

describe('lockCheck: consumers', () => {
  test('non-consumer PRs get locks: [] with no reads and no auth', async () => {
    const prs = [makePr('acme-web'), makePr('acme-shared')];
    const { out, calls, auth } = await check({ world: bbWorld(), prs });
    assert.deepEqual(out.map((p) => p.locks), [[], []]);
    assert.deepEqual(out.map(({ locks, ...p }) => p), prs.map(({ locks, ...p }) => p), 'the rest of each PR is unchanged');
    assert.deepEqual(calls, []);
    assert.deepEqual(auth, { github: 0, bitbucket: 0 });
  });

  test('no sharedPackages → every PR gets locks: []', async () => {
    const { out, calls } = await check({ world: bbWorld(), prs: [makePr('acme-backend')], project: { ...EXAMPLE, sharedPackages: undefined } });
    assert.deepEqual(out[0].locks, []);
    assert.deepEqual(calls, []);
  });

  test('a consumer PR on the shared default branch: the full lock entry, not pinned, nothing missing', async () => {
    const { out, calls, logs, owners } = await check({ world: bbWorld(), prs: [makePr('acme-backend')] });
    assert.deepEqual(out[0].locks, [{
      package: 'acme/shared',
      sharedRepo: SHARED,
      constraint: 'dev-develop',
      lockRef: LOCK,
      pinnedPr: null,
      missingPrs: [],
    }]);
    assert.deepEqual(calls, [
      `bitbucket read acme-backend@${SHA}/composer.json`,
      `bitbucket read acme-backend@${SHA}/composer.lock`,
      `bitbucket merged acme-shared>=${SINCE}`,
    ]);
    assert.deepEqual(owners, ['bitbucket:acme']);
    assert.deepEqual(logs, []);
  });

  test('the lock ref is found in packages-dev too', async () => {
    const files = { [`acme-backend@${SHA}/composer.lock`]: composerLock({}, { 'acme/shared': LOCK }) };
    const { out } = await check({ world: bbWorld({ files }), prs: [makePr('acme-backend')] });
    assert.equal(out[0].locks[0].lockRef, LOCK);
  });

  test('a constraint missing from require → null; no lock entry for the package → null', async () => {
    const { out } = await check({ world: bbWorld({ constraint: null, lockRef: null }), prs: [makePr('acme-backend')] });
    assert.equal(out[0].locks[0].constraint, null);
    assert.equal(out[0].locks[0].lockRef, null);
  });

  test('a PR without a head sha gets an entry with nulls and no reads', async () => {
    const { out, calls } = await check({ world: bbWorld(), prs: [makePr('acme-backend', { headSha: null })] });
    assert.deepEqual(out[0].locks, [{ package: 'acme/shared', sharedRepo: SHARED, constraint: null, lockRef: null, pinnedPr: null, missingPrs: [] }]);
    assert.deepEqual(calls, []);
  });
});

describe('lockCheck: pinned', () => {
  const onMain = REPOS.map((r) => (r.repo === 'acme-shared' ? { ...r, defaultBranch: 'main' } : r));

  test('dev-develop against a shared default main is pinned: the shared PR from develop is looked up', async () => {
    const { out, calls } = await check({ world: bbWorld({ prs: { 'acme-shared:develop': null } }), prs: [makePr('acme-backend')], repos: onMain });
    assert.equal(out[0].locks[0].sharedRepo.defaultBranch, 'main');
    assert.equal(out[0].locks[0].pinnedPr, null);
    assert.ok(calls.includes('bitbucket pr acme-shared:develop'));
  });

  test('dev-main against a shared default main is not pinned: no lookup', async () => {
    const { out, calls } = await check({ world: bbWorld({ constraint: 'dev-main' }), prs: [makePr('acme-backend')], repos: onMain });
    assert.equal(out[0].locks[0].pinnedPr, null);
    assert.ok(!calls.some((c) => c.includes(' pr ')));
  });

  const branch = 'feature/SHOP-42-checkout';
  const sharedPr = (state) => ({ number: 7, state, url: 'https://example.test/acme-shared/7' });
  for (const [name, found, expected] of [
    ['open', sharedPr('open'), sharedPr('open')],
    ['merged', sharedPr('merged'), sharedPr('merged')],
    ['missing (no PR for the branch)', null, null],
  ]) {
    test(`pinned to a shared branch whose PR is ${name}`, async () => {
      const world = bbWorld({ constraint: `dev-${branch}`, prs: { [`acme-shared:${branch}`]: found } });
      const { out } = await check({ world, prs: [makePr('acme-backend')] });
      assert.equal(out[0].locks[0].constraint, `dev-${branch}`);
      assert.deepEqual(out[0].locks[0].pinnedPr, expected);
    });
  }

  test('a failed pinned PR lookup → pinnedPr undefined (unknown) and one log line', async () => {
    const world = bbWorld({ constraint: `dev-${branch}`, prs: { [`acme-shared:${branch}`]: new HttpError({ status: 500, url: 'x', message: 'GET x failed with 500' }) } });
    const { out, logs } = await check({ world, prs: [makePr('acme-backend')] });
    assert.equal(out[0].locks[0].pinnedPr, undefined);
    assert.equal(out[0].locks[0].lockRef, LOCK);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /backend#\d+/);
  });

  test('two consumer PRs pinned to the same branch share one lookup per round', async () => {
    const world = bbWorld({ constraint: `dev-${branch}`, prs: { [`acme-shared:${branch}`]: sharedPr('open') } });
    const { calls } = await check({ world, prs: [makePr('acme-backend'), makePr('acme-backend')] });
    assert.equal(calls.filter((c) => c === `bitbucket pr acme-shared:${branch}`).length, 1);
  });
});

describe('lockCheck: missing', () => {
  test('only merged shared PRs with the same Ticket key whose merge the lock lacks', async () => {
    const mergedList = [
      merged(7, 'feature/SHOP-42-warehouses', '47aad769eb40'), // same key, lacking (short Bitbucket sha) → missing
      merged(6, 'feature/SHOP-42-language', LOCK), // same key, already in the lock
      merged(5, 'feature/SHOP-40-partner', HEAD.slice(0, 12)), // lacking, another key
      merged(4, 'docs/readme', HEAD), // no key
    ];
    const world = bbWorld({ mergedList, lacking: [HEAD, M7] });
    const { out, calls } = await check({ world, prs: [makePr('acme-backend')] });
    assert.deepEqual(out[0].locks[0].missingPrs, [{ number: 7, url: 'https://example.test/acme-shared/7' }]);
    assert.ok(calls.includes('bitbucket head acme-shared:develop'));
    assert.ok(calls.includes(`bitbucket lacking acme-shared:${LOCK}...${HEAD}`));
  });

  test('a lock ref that already contains the merge → nothing missing', async () => {
    const world = bbWorld({ mergedList: [merged(7, 'feature/SHOP-42-warehouses', M7)], lacking: [HEAD] });
    const { out } = await check({ world, prs: [makePr('acme-backend')] });
    assert.deepEqual(out[0].locks[0].missingPrs, []);
  });

  test('no same-key merged PR → no head or commit lookups', async () => {
    const world = bbWorld({ mergedList: [merged(5, 'feature/SHOP-40-partner', M7)] });
    const { out, calls } = await check({ world, prs: [makePr('acme-backend')] });
    assert.deepEqual(out[0].locks[0].missingPrs, []);
    assert.ok(!calls.some((c) => / (head|lacking) /.test(c)));
  });

  test('a consumer PR without a Ticket key, or without a lock ref, never looks up merged PRs', async () => {
    const noKey = makePr('acme-backend', { source: 'fix/typo', title: 'fix typo' });
    let r = await check({ world: bbWorld(), prs: [noKey] });
    assert.deepEqual(r.out[0].locks[0].missingPrs, []);
    assert.ok(!r.calls.some((c) => c.includes(' merged ')));
    r = await check({ world: bbWorld({ lockRef: null }), prs: [makePr('acme-backend')] });
    assert.ok(!r.calls.some((c) => c.includes(' merged ')));
  });

  test('Ticket keys from link matchers compare by key too', async () => {
    const card = 'https://trello.com/c/AbC123/95-checkout';
    const consumer = makePr('acme-backend', { source: 'fix/checkout', title: 'fix checkout', description: `Card: ${card}` });
    const mergedList = [merged(9, 'fix/mail', M7, { description: `See ${card}` }), merged(8, 'fix/other', M7, { description: 'https://trello.com/c/Zz999/1-x' })];
    const { out } = await check({ world: bbWorld({ mergedList, lacking: [M7] }), prs: [consumer] });
    assert.deepEqual(out[0].locks[0].missingPrs.map((m) => m.number), [9]);
  });

  test('a failed merged lookup → missingPrs [] and one log line', async () => {
    const world = bbWorld();
    world.bitbucket.merged[`acme-shared>=${SINCE}`] = new HttpError({ status: 500, url: 'x', message: 'GET x failed with 500' });
    const { out, logs } = await check({ world, prs: [makePr('acme-backend')] });
    assert.deepEqual(out[0].locks[0].missingPrs, []);
    assert.equal(logs.length, 1);
  });

  test('merged PRs once per round per shared repo; commits the lock lacks cached across rounds by (head, lock ref)', async () => {
    const world = bbWorld({ mergedList: [merged(7, 'feature/SHOP-42-warehouses', M7)], lacking: [M7] });
    const fakes = fakeReaders(world);
    const lockCheck = createSharedPackageCheck({ http: {}, readers: fakes.readers });
    const prs = [makePr('acme-backend'), makePr('acme-backend', { headSha: SHA })];
    await check({ world, prs, lockCheck, fakes });
    await check({ world, prs, lockCheck, fakes });
    const count = (what) => fakes.calls.filter((c) => c.startsWith(`bitbucket ${what} `)).length;
    assert.equal(count('merged'), 2, 'once per round');
    assert.equal(count('head'), 2, 'the branch head is read every round');
    assert.equal(count('lacking'), 1, 'cached by (head, lock ref)');
    assert.equal(count('read'), 2, 'composer files read once, cached by (repo, headSha)');
  });
});

describe('lockCheck: reads and cache', () => {
  test('a failed read → null, one log line without auth, and retried next round; a good read is cached', async () => {
    const world = bbWorld();
    const lockUrl = `acme-backend@${SHA}/composer.lock`;
    const good = world.bitbucket.files[lockUrl];
    world.bitbucket.files[lockUrl] = new HttpError({ status: 500, url: lockUrl, message: `GET ${lockUrl} failed with 500` });
    const fakes = fakeReaders(world);
    const lockCheck = createSharedPackageCheck({ http: {}, readers: fakes.readers });
    const prs = [makePr('acme-backend')];

    let r = await check({ world, prs, lockCheck, fakes });
    assert.equal(r.out[0].locks[0].constraint, 'dev-develop');
    assert.equal(r.out[0].locks[0].lockRef, null);
    assert.equal(r.logs.length, 1);
    assert.ok(!r.logs[0].includes('bb-test') && !r.logs[0].includes('Basic'));

    world.bitbucket.files[lockUrl] = good;
    r = await check({ world, prs, lockCheck, fakes });
    assert.equal(r.out[0].locks[0].lockRef, LOCK, 'retried next round');

    await check({ world, prs, lockCheck, fakes });
    const reads = fakes.calls.filter((c) => c.includes(' read '));
    assert.equal(reads.filter((c) => c.endsWith('composer.lock')).length, 2, 'read until it worked, then cached');
    assert.equal(reads.filter((c) => c.endsWith('composer.json')).length, 2, 'both files are read again after a failure');
  });

  test('a new head sha is read again', async () => {
    const other = 'b'.repeat(40);
    const world = bbWorld({ files: { [`acme-backend@${other}/composer.json`]: composer({ 'acme/shared': 'dev-develop' }), [`acme-backend@${other}/composer.lock`]: composerLock({ 'acme/shared': HEAD }) } });
    world.bitbucket.lacking[`acme-shared:${HEAD}...${HEAD}`] = [];
    const fakes = fakeReaders(world);
    const lockCheck = createSharedPackageCheck({ http: {}, readers: fakes.readers });
    await check({ world, prs: [makePr('acme-backend')], lockCheck, fakes });
    const { out } = await check({ world, prs: [makePr('acme-backend', { headSha: other })], lockCheck, fakes });
    assert.equal(out[0].locks[0].lockRef, HEAD);
  });
});

describe('lockCheck: hosts and entries', () => {
  test('a consumer on Bitbucket with the shared package on GitHub: each read on its own host and credential', async () => {
    const project = {
      ...EXAMPLE,
      sharedPackages: [{ repo: 'github:acme-shared', kind: 'composer', package: 'acme/shared', consumers: ['acme-backend'] }],
    };
    const repos = [...REPOS, repo('github', 'acme-shared', 'shared-gh', 'main')];
    const ghLock = 'e091054718b2bc350c5b704b7e18e6bdc0443b88';
    const ghHead = '12925e26f48b04d0c804a9eae8251ca47ecf537e';
    const ghM7 = '2566fb2c8633321d45ed13b859a3a5056dab242b';
    const world = {
      bitbucket: {
        files: {
          [`acme-backend@${SHA}/composer.json`]: composer({ 'acme/shared': 'dev-main' }),
          [`acme-backend@${SHA}/composer.lock`]: composerLock({ 'acme/shared': ghLock }),
        },
      },
      github: {
        heads: { 'acme-shared:main': ghHead },
        merged: { [`acme-shared>=${SINCE}`]: [merged(7, 'feature/SHOP-42-checkout', ghM7)] },
        lacking: { [`acme-shared:${ghLock}...${ghHead}`]: [ghM7, ghHead] },
      },
    };
    const { out, calls, owners, auth } = await check({ world, prs: [makePr('acme-backend')], project, repos });
    assert.deepEqual(out[0].locks, [{
      package: 'acme/shared',
      sharedRepo: { host: 'github', repo: 'acme-shared', repoShort: 'shared-gh', defaultBranch: 'main' },
      constraint: 'dev-main',
      lockRef: ghLock,
      pinnedPr: null,
      missingPrs: [{ number: 7, url: 'https://example.test/acme-shared/7' }],
    }]);
    assert.deepEqual(calls.map((c) => c.split(' ').slice(0, 2).join(' ')), [
      'bitbucket read', 'bitbucket read', 'github merged', 'github head', 'github lacking',
    ]);
    assert.deepEqual(owners.sort(), ['bitbucket:acme', 'github:acme-corp']);
    assert.deepEqual(auth, { github: 1, bitbucket: 1 }, 'one reader per host per round, each with its own credential');
  });

  test('two entries consumed by one repo → two locks, in sharedPackages order, from one read of each file', async () => {
    const project = {
      ...EXAMPLE,
      sharedPackages: [
        ...EXAMPLE.sharedPackages,
        { repo: 'acme-tools', kind: 'composer', package: 'acme/tools', consumers: ['acme-backend'] },
      ],
    };
    const repos = [...REPOS, repo('bitbucket', 'acme-tools', 'tools', 'main')];
    const toolsRef = 'c'.repeat(40);
    const world = bbWorld({
      files: {
        [`acme-backend@${SHA}/composer.json`]: composer({ 'acme/shared': 'dev-develop', 'acme/tools': '^2.1' }),
        [`acme-backend@${SHA}/composer.lock`]: composerLock({ 'acme/shared': LOCK, 'acme/tools': toolsRef }),
      },
    });
    world.bitbucket.merged[`acme-tools>=${SINCE}`] = [];
    const { out, calls } = await check({ world, prs: [makePr('acme-backend'), makePr('acme-worker', { headSha: null })], project, repos });
    assert.deepEqual(out[0].locks.map((l) => [l.package, l.sharedRepo.repoShort, l.constraint, l.lockRef]), [
      ['acme/shared', 'shared', 'dev-develop', LOCK],
      ['acme/tools', 'tools', '^2.1', toolsRef],
    ]);
    assert.deepEqual(out[1].locks.map((l) => l.package), ['acme/shared'], 'worker consumes only acme/shared');
    assert.equal(calls.filter((c) => c.includes(' read ')).length, 2);
  });

  test('host:name references resolve against the repos of both hosts', async () => {
    const project = {
      ...EXAMPLE,
      sharedPackages: [{ repo: 'bitbucket:acme-shared', kind: 'composer', package: 'acme/shared', consumers: ['bitbucket:acme-backend', 'github:acme-backend'] }],
    };
    const repos = [...REPOS, repo('github', 'acme-shared', 'shared-gh', 'main'), repo('github', 'acme-backend', 'backend-gh', 'main')];
    const ghBackend = makePr('acme-backend', { host: 'github', headSha: null });
    const { out } = await check({ world: bbWorld(), prs: [makePr('acme-backend'), ghBackend, makePr('acme-worker')], project, repos });
    assert.deepEqual(out[0].locks[0].sharedRepo, SHARED);
    assert.equal(out[1].locks.length, 1, 'github:acme-backend is a consumer');
    assert.deepEqual(out[2].locks, [], 'worker is not listed in this project');
  });

  test('an unknown or ambiguous repo reference is skipped, logged once per check', async () => {
    const project = {
      ...EXAMPLE,
      sharedPackages: [
        { repo: 'acme-nope', kind: 'composer', package: 'acme/nope', consumers: ['acme-backend'] },
        { repo: 'acme-shared', kind: 'composer', package: 'acme/shared', consumers: ['acme-backend'] },
      ],
    };
    const repos = [...REPOS, repo('github', 'acme-shared', 'shared-gh', 'main')];
    const fakes = fakeReaders(bbWorld());
    const lockCheck = createSharedPackageCheck({ http: {}, readers: fakes.readers });
    const first = await check({ world: bbWorld(), prs: [makePr('acme-backend')], project, repos, lockCheck, fakes });
    const second = await check({ world: bbWorld(), prs: [makePr('acme-backend')], project, repos, lockCheck, fakes });
    assert.deepEqual(first.out[0].locks, []);
    assert.equal(first.logs.length, 2);
    assert.ok(first.logs.some((l) => l.includes('acme-nope')));
    assert.ok(first.logs.some((l) => l.includes('acme-shared') && /both hosts/.test(l)));
    assert.deepEqual(second.logs, [], 'not logged again');
  });
});

// SPEC "Shared package check", Done-when of group 6: real readers over recorded fixtures, then enrich.
describe('lockCheck + enrich on the example project', () => {
  const FIX = new URL('./fixtures/bitbucket/', import.meta.url);
  const fixture = (name) => JSON.parse(readFileSync(new URL(name, FIX), 'utf8'));
  const ROUTES = fixture('routes.json');
  const MERGED_URL = Object.keys(ROUTES).find((u) => ROUTES[u] === 'shared-merged.json');
  const AUTH = 'Basic dGVzdDp0ZXN0LXNlY3JldA==';

  function fakeHttp(overrides) {
    const calls = [];
    const resolve = (url, opts) => {
      calls.push(url);
      assert.equal(opts?.auth, AUTH);
      const file = overrides[url] ?? ROUTES[url];
      if (!file) throw new HttpError({ status: 404, url, message: `GET ${url} failed with 404 (no fixture)` });
      return fixture(file);
    };
    return { calls, get: async (url, opts) => resolve(url, opts), getAll: async (url, opts) => resolve(url, opts).values ?? [] };
  }

  test('acme-backend shows "lock bump due: shared #7"', async () => {
    const discovered = { bitbucket: ['acme-shared', 'acme-backend', 'acme-worker', 'acme-web'].map((name) => ({ name, defaultBranch: 'develop' })) };
    const repos = [...repoSet(discovered, EXAMPLE, 'github').repos, ...repoSet(discovered, EXAMPLE, 'bitbucket').repos];
    const http = fakeHttp({ [MERGED_URL]: 'shared-merged-shop-42.json' });
    const auth = { bitbucket: async () => AUTH };

    const { prs } = await collectBitbucket({
      project: EXAMPLE, repos: repos.filter((r) => r.repo === 'acme-backend'), http, auth: auth.bitbucket, cache: new Map(), now: NOW,
    });
    const lockCheck = createSharedPackageCheck({ http });
    const logs = [];
    const checked = await lockCheck(prs, { project: EXAMPLE, repos, auth, now: NOW, matchers: MATCHERS, log: (l) => logs.push(l) });
    const [backend] = enrich(checked, { now: NOW, staleDays: 14, behindWarn: 20, matchers: MATCHERS });

    assert.equal(backend.id, 'bitbucket:acme-backend#2504');
    assert.deepEqual(backend.locks[0].missingPrs, [{ number: 7, url: 'https://bitbucket.org/acme/acme-shared/pull-requests/7' }]);
    assert.deepEqual(backend.signals.find((s) => s.kind === 'lock-missing'), {
      kind: 'lock-missing', severity: 'warning', label: 'lock bump due: shared #7', href: 'https://bitbucket.org/acme/acme-shared/pull-requests/7',
    });
    assert.deepEqual(logs, []);
  });
});
