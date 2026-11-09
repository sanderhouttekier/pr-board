import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCollector, createIdentities, passThroughLocks, resolveSharedPackages } from '../src/collector.js';
import { createDiscovery } from '../src/discover.js';

const NOW = Date.parse('2026-11-06T10:00:00Z');

// Made-up project (see projects/example.json). SHOP and OPS prefix matchers so Ticket keys derive.
const PROJECT = {
  title: 'Acme',
  hosts: { github: { owner: 'acme-corp' }, bitbucket: { workspace: 'acme' } },
  aliases: { 'acme-api': 'api', 'acme-app': 'app', 'acme-backend': 'backend', 'acme-worker': 'worker' },
  tickets: [
    { prefix: 'SHOP', browse: 'https://jira.example.com/browse/{key}', jira: 'main' },
    { prefix: 'OPS', browse: null },
  ],
  jira: { main: { cloudId: '00000000-0000-4000-8000-000000000000' } },
};

// Merged credentials as loadBoard returns them: global GitHub, a Bitbucket override, global Jira.
const CREDENTIALS = {
  github: { ref: '', override: false },
  bitbucket: { ref: 'acme-bitbucket', email: 'you@acme.example', override: true },
  jira: { ref: 'pr-board-jira', email: 'you@example.com', override: false },
};

// A loadBoard project entry.
const entry = (extra = {}) => ({
  id: 'acme',
  title: 'Acme',
  file: '/cfg/projects/acme.json',
  ok: true,
  error: null,
  warnings: [],
  project: PROJECT,
  credentials: CREDENTIALS,
  ...extra,
});

const SETTINGS = {
  port: 7419,
  intervalSec: 300,
  idleAfterSec: 900,
  idleIntervalSec: 3600,
  staleDays: 14,
  behindWarn: 20,
  ghPath: 'gh',
  mine: {},
  fixNotes: {},
};

const REPOS = [
  { host: 'github', repo: 'acme-api', repoShort: 'api', repoUrl: 'https://github.com/acme-corp/acme-api/pulls', defaultBranch: 'main' },
  { host: 'github', repo: 'acme-app', repoShort: 'app', repoUrl: 'https://github.com/acme-corp/acme-app/pulls', defaultBranch: 'main' },
  { host: 'bitbucket', repo: 'acme-backend', repoShort: 'backend', repoUrl: 'https://bitbucket.org/acme/acme-backend/pull-requests/', defaultBranch: 'develop' },
  { host: 'bitbucket', repo: 'acme-worker', repoShort: 'worker', repoUrl: 'https://bitbucket.org/acme/acme-worker/pull-requests/', defaultBranch: 'develop' },
];

// Stub discoverers: what the token can see per host. `calls` records each discovery.
function stubDiscoverers(lists = {
  github: [{ name: 'acme-api', defaultBranch: 'main' }, { name: 'acme-app', defaultBranch: 'main' }],
  bitbucket: [{ name: 'acme-backend', defaultBranch: 'develop' }, { name: 'acme-worker', defaultBranch: 'develop' }],
}) {
  const calls = [];
  const make = (host) => async (args) => {
    calls.push({ host, ...args });
    const r = lists[host];
    if (r instanceof Error) throw r;
    return r;
  };
  return { github: make('github'), bitbucket: make('bitbucket'), calls };
}

function pr(host, repo, number, extra = {}) {
  return {
    id: `${host}:${repo}#${number}`,
    host,
    repo,
    repoShort: repo,
    number,
    title: `PR ${number}`,
    url: `https://x/${number}`,
    author: { name: 'a', id: 'a' },
    mine: false,
    source: `feature/SHOP-${number}-x`,
    target: 'develop',
    headSha: 'abc',
    draft: false,
    createdAt: '2026-11-05T10:00:00Z',
    updatedAt: '2026-11-05T10:00:00Z',
    ci: 'ok',
    mergeable: 'clean',
    behindBy: 0,
    ...extra,
  };
}

// secrets.auth(host, credential) stub: a header per host (or an Error to throw); records every call.
function stubSecrets(headers = { github: 'Bearer gh-secret', bitbucket: 'Basic bb-secret', jira: 'Basic jira-secret' }) {
  const calls = [];
  return {
    calls,
    auth: async (host, credential) => {
      calls.push({ host, credential });
      const h = headers[host];
      if (h instanceof Error) throw h;
      return h;
    },
  };
}

const GH_USER = 'https://api.github.com/user';
const BB_USER = 'https://api.bitbucket.org/2.0/user?fields=uuid';

// Fake http for the identity lookups: `routes` maps URL -> body, Error, or a queue (array) of those.
function makeHttp(routes = { [GH_USER]: { login: 'octo' }, [BB_USER]: { uuid: '{me}' } }) {
  const calls = [];
  return {
    calls,
    stats: () => ({ 'api.github.com': { rateLimitRemaining: 4321 } }),
    get: async (url, opts) => {
      calls.push({ url, opts });
      let r = routes[url];
      if (Array.isArray(r)) r = r.length > 1 ? r.shift() : r[0];
      if (r === undefined) throw new Error(`no route for ${url}`);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

// Sources driven by a queue of results per call; each entry is a value, a function, or an Error to throw.
function scripted(results) {
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    const r = results.length > 1 ? results.shift() : results[0];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(...args) : r;
  };
  fn.calls = calls;
  return fn;
}

function clock(start = NOW) {
  let t = start;
  const fn = () => t;
  fn.advance = (sec) => {
    t += sec * 1000;
  };
  return fn;
}

function make({
  github, bitbucket, jira, secrets = stubSecrets(), logs = [], now = () => NOW, http = makeHttp(),
  project = entry(), settings = SETTINGS, discoverers = stubDiscoverers(), lockCheck, identities, boardWarnings,
} = {}) {
  const sources = {
    github: github ?? scripted([{ prs: [] }]),
    bitbucket: bitbucket ?? scripted([{ prs: [] }]),
    jira: jira ?? scripted([{ tickets: {} }]),
  };
  const collector = createCollector({
    project,
    settings,
    boardWarnings,
    secrets,
    http,
    sources,
    lockCheck,
    discovery: createDiscovery({ http, discoverers }),
    identities,
    now,
    log: (line) => logs.push(line),
  });
  return { collector, sources, logs, http, discoverers, secrets };
}

// --- snapshot shape ---

test('snapshot before the first round has the full SPEC shape with no PRs', () => {
  const { collector } = make();
  const s = collector.snapshot({ rate: 'viewed' });
  assert.deepEqual(Object.keys(s), ['project', 'generatedAt', 'refreshing', 'rate', 'intervalSec', 'sources', 'prs', 'tickets', 'repos', 'fix', 'rateLimit']);
  assert.deepEqual(s.project, {
    id: 'acme',
    title: 'Acme',
    hosts: { github: { owner: 'acme-corp' }, bitbucket: { workspace: 'acme' } },
    error: null,
    warnings: [],
  });
  assert.equal(s.generatedAt, null);
  assert.equal(s.refreshing, false);
  assert.equal(s.rate, 'viewed');
  assert.equal(s.intervalSec, 300);
  assert.deepEqual(s.prs, []);
  assert.deepEqual(s.tickets, {});
  assert.deepEqual(Object.keys(s.sources).sort(), ['bitbucket', 'github', 'jira']);
  for (const src of Object.values(s.sources)) assert.deepEqual(Object.keys(src).sort(), ['error', 'fetchedAt', 'ok']);
  assert.deepEqual(s.repos, [], 'repos are known after the first discovery');
  assert.deepEqual(s.fix, { sharedPackages: [], fixPrompts: {}, fixNotes: {} });
  assert.deepEqual(s.rateLimit, { github: 4321 });
  assert.equal(collector.lastDoneAt(), null);
  assert.equal(collector.ok, true);
  assert.equal(collector.id, 'acme');
});

test('snapshot after a round: enriched PRs, tickets, ok sources, generatedAt', async () => {
  const { collector } = make({
    github: scripted([{ prs: [pr('github', 'acme-api', 1)] }]),
    bitbucket: scripted([{ prs: [pr('bitbucket', 'acme-worker', 2)] }]),
    jira: scripted([{ tickets: { 'SHOP-1': { status: 'Done', summary: 's', url: 'u' } } }]),
  });
  await collector.refresh();
  const s = collector.snapshot();
  assert.equal(s.generatedAt, new Date(NOW).toISOString());
  assert.equal(s.refreshing, false);
  assert.equal(s.prs.length, 2);
  assert.equal(s.prs[0].ticketKey, 'SHOP-1');
  assert.ok(Array.isArray(s.prs[0].signals));
  assert.equal(typeof s.prs[0].ready, 'boolean');
  assert.deepEqual(s.tickets, {
    'SHOP-1': { label: 'SHOP-1', status: 'Done', summary: 's', url: 'u' },
    'SHOP-2': { label: 'SHOP-2', status: null, summary: null, url: 'https://jira.example.com/browse/SHOP-2' },
  });
  assert.deepEqual(s.repos, REPOS.map(({ host, repo, repoShort, repoUrl }) => ({ host, repo, repoShort, repoUrl })));
  for (const name of ['github', 'bitbucket', 'jira']) {
    assert.deepEqual(s.sources[name], { ok: true, error: null, fetchedAt: new Date(NOW).toISOString() });
  }
  assert.equal(collector.lastDoneAt(), NOW);
});

test('snapshot PRs carry no description', async () => {
  const { collector } = make({ github: scripted([{ prs: [pr('github', 'acme-api', 1, { description: 'secret plans' })] }]) });
  await collector.refresh();
  assert.equal('description' in collector.snapshot().prs[0], false);
});

test('snapshot never carries a token or auth header', async () => {
  const { collector } = make({ github: scripted([{ prs: [pr('github', 'acme-api', 1)] }]) });
  await collector.refresh();
  assert.doesNotMatch(JSON.stringify(collector.snapshot()), /secret/);
});

// --- credentials and sources ---

test('credentials per host come from the project entry; a host without one gets the empty global credential', async () => {
  const project = entry({ credentials: { bitbucket: CREDENTIALS.bitbucket } });
  const { collector, secrets, sources } = make({ project, github: scripted([{ prs: [pr('github', 'acme-api', 1)] }]) });
  await collector.refresh();
  const [jiraCtx] = sources.jira.calls.map((c) => c[1]);
  await jiraCtx.auth();
  assert.deepEqual(secrets.calls.map((c) => [c.host, c.credential]), [
    ['github', { ref: '', override: false }],
    ['bitbucket', CREDENTIALS.bitbucket],
    ['jira', { ref: '', override: false }],
  ]);
});

test('sources get the project, their repo set, an auth function, their own persistent cache and a numeric now', async () => {
  const { collector, sources, http, secrets } = make();
  await collector.refresh();
  await collector.refresh();
  const [gh1] = sources.github.calls[0];
  const [gh2] = sources.github.calls[1];
  const [bb1] = sources.bitbucket.calls[0];
  assert.equal(await gh1.auth(), 'Bearer gh-secret');
  assert.equal(await bb1.auth(), 'Basic bb-secret');
  assert.equal(gh1.project, PROJECT);
  assert.deepEqual(gh1.repos, REPOS.filter((r) => r.host === 'github'));
  assert.deepEqual(bb1.repos, REPOS.filter((r) => r.host === 'bitbucket'));
  assert.ok(gh1.cache instanceof Map);
  assert.equal(gh1.cache, gh2.cache);
  assert.notEqual(gh1.cache, bb1.cache);
  assert.equal(gh1.now, NOW);
  assert.equal(gh1.http, http);
  const [, jiraCtx] = sources.jira.calls[0];
  assert.equal(await jiraCtx.auth(), 'Basic jira-secret');
  assert.deepEqual(secrets.calls.at(-1), { host: 'jira', credential: CREDENTIALS.jira });
  assert.deepEqual(jiraCtx.sites, { main: { cloudId: '00000000-0000-4000-8000-000000000000', browse: { SHOP: 'https://jira.example.com/browse/{key}' } } });
  assert.ok(jiraCtx.cache instanceof Map);
  assert.notEqual(jiraCtx.cache, gh1.cache);
});

test('refresh during a round returns the same promise and does not overlap', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const github = scripted([async () => { await gate; return { prs: [] }; }]);
  const { collector, sources } = make({ github });
  const p1 = collector.refresh();
  assert.equal(collector.busy(), true);
  assert.equal(collector.snapshot().refreshing, true);
  const p2 = collector.refresh();
  assert.equal(p1, p2);
  release();
  await p1;
  assert.equal(sources.github.calls.length, 1);
  assert.equal(collector.busy(), false);
  assert.equal(collector.snapshot().refreshing, false);
});

test('one source throwing keeps the others and keeps its previous PRs', async () => {
  const { collector } = make({
    github: scripted([{ prs: [pr('github', 'acme-api', 1)] }, new Error('GitHub: every repo failed (boom)')]),
    bitbucket: scripted([{ prs: [pr('bitbucket', 'acme-worker', 2)] }, { prs: [pr('bitbucket', 'acme-worker', 3)] }]),
  });
  await collector.refresh();
  await collector.refresh();
  const s = collector.snapshot();
  assert.deepEqual(s.prs.map((p) => p.number).sort(), [1, 3]);
  assert.equal(s.sources.github.ok, false);
  assert.match(s.sources.github.error, /every repo failed/);
  assert.equal(s.sources.github.fetchedAt, new Date(NOW).toISOString(), 'fetchedAt stays the last good time');
  assert.equal(s.sources.bitbucket.ok, true);
});

test('partial repo errors keep that repo previous PRs (GitHub repo-name prefix)', async () => {
  const { collector } = make({
    github: scripted([
      { prs: [pr('github', 'acme-api', 1), pr('github', 'acme-app', 2)] },
      { prs: [pr('github', 'acme-app', 4)], errors: ['acme-api: HTTP 502'] },
    ]),
  });
  await collector.refresh();
  await collector.refresh();
  const s = collector.snapshot();
  assert.deepEqual(s.prs.map((p) => p.number).sort(), [1, 4]);
  assert.equal(s.sources.github.ok, false);
  assert.equal(s.sources.github.error, 'acme-api: HTTP 502');
});

test('partial repo errors keep that repo previous PRs (Bitbucket repoShort prefix)', async () => {
  const { collector } = make({
    bitbucket: scripted([
      { prs: [pr('bitbucket', 'acme-backend', 10), pr('bitbucket', 'acme-worker', 11)] },
      { prs: [pr('bitbucket', 'acme-worker', 12)], errors: ['backend: HTTP 500', 'other: x'] },
    ]),
  });
  await collector.refresh();
  await collector.refresh();
  const s = collector.snapshot();
  assert.deepEqual(s.prs.map((p) => p.number).sort((a, b) => a - b), [10, 12]);
  assert.equal(s.sources.bitbucket.error, 'backend: HTTP 500; other: x');
});

test('auth failure is that source error and keeps the others', async () => {
  const secrets = stubSecrets({ github: 'Bearer gh-secret', bitbucket: new Error('No Bitbucket token for `acme-bitbucket`: tried Keychain entry `acme-bitbucket`, env var `ACME_BITBUCKET`.'), jira: 'Basic jira-secret' });
  const { collector, sources } = make({ secrets, github: scripted([{ prs: [pr('github', 'acme-api', 1)] }]) });
  await collector.refresh();
  const s = collector.snapshot();
  assert.equal(sources.bitbucket.calls.length, 0);
  assert.equal(s.sources.bitbucket.ok, false);
  assert.match(s.sources.bitbucket.error, /No Bitbucket token for `acme-bitbucket`/);
  assert.equal(s.sources.github.ok, true);
  assert.equal(s.prs.length, 1);
});

test('jira gets the distinct ticket keys of all PRs per site; tickets merge over previous', async () => {
  const jira = scripted([
    { tickets: { 'SHOP-1': { status: 'A', summary: 'one', url: 'u1' }, 'SHOP-2': { status: 'B', summary: 'two', url: 'u2' } } },
    { tickets: { 'SHOP-2': { status: 'C', summary: 'two', url: 'u2' } }, errors: ['jira SHOP-1: HTTP 500'] },
  ]);
  const { collector, sources } = make({
    github: scripted([{ prs: [pr('github', 'acme-api', 1), pr('github', 'acme-app', 2, { source: 'feature/SHOP-1-y' })] }]),
    bitbucket: scripted([{ prs: [pr('bitbucket', 'acme-worker', 2), pr('bitbucket', 'acme-worker', 3, { source: 'release', title: 'develop > staging' })] }]),
    jira,
  });
  await collector.refresh();
  assert.deepEqual(sources.jira.calls[0][0], { main: ['SHOP-1', 'SHOP-2'] });
  await collector.refresh();
  const s = collector.snapshot();
  assert.deepEqual(s.tickets, {
    'SHOP-1': { label: 'SHOP-1', status: 'A', summary: 'one', url: 'u1' },
    'SHOP-2': { label: 'SHOP-2', status: 'C', summary: 'two', url: 'u2' },
  });
  assert.equal(s.sources.jira.ok, false);
  assert.equal(s.sources.jira.error, 'jira SHOP-1: HTTP 500');
});

test('tickets: no Jira site → no Jira call; keys still get a skeleton entry with the browse url', async () => {
  const project = entry({ project: { ...PROJECT, tickets: [{ prefix: 'SHOP', browse: 'https://tickets.example.com/{key}' }], jira: undefined } });
  const { collector, sources, secrets } = make({ project, github: scripted([{ prs: [pr('github', 'acme-api', 1)] }]) });
  await collector.refresh();
  assert.equal(sources.jira.calls.length, 0);
  assert.equal(secrets.calls.filter((c) => c.host === 'jira').length, 0);
  const s = collector.snapshot();
  assert.deepEqual(s.tickets, { 'SHOP-1': { label: 'SHOP-1', url: 'https://tickets.example.com/SHOP-1', status: null, summary: null } });
  assert.equal(s.sources.jira.ok, true);
});

// --- log lines ---

test('logs one line per round, prefixed with the time and the project id, never auth', async () => {
  const logs = [];
  const { collector } = make({
    logs,
    github: scripted([{ prs: [pr('github', 'acme-api', 1)], errors: ['acme-app: HTTP 502'] }]),
  });
  await collector.refresh();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^2026-11-06T10:00:00Z acme round github=1 bitbucket=0 tickets=1 \d+ms rate=4321 errors: github: acme-app: HTTP 502$/);
  assert.doesNotMatch(logs[0], /secret/);
});

test('sources, Jira and the lock check log through the project prefix', async () => {
  const logs = [];
  const github = scripted([(ctx) => (ctx.log('acme-api: slow'), { prs: [] })]);
  const lockCheck = async (prs, ctx) => (ctx.log('lock read failed'), prs);
  const { collector } = make({ logs, github, lockCheck });
  await collector.refresh();
  assert.ok(logs.includes('2026-11-06T10:00:00Z acme acme-api: slow'));
  assert.ok(logs.includes('2026-11-06T10:00:00Z acme lock read failed'));
});

// --- a project with an error ---

test('a project with an error never runs a round and reports its error in the snapshot', async () => {
  const project = {
    id: 'broken',
    title: 'broken',
    file: '/cfg/projects/broken.json',
    ok: false,
    error: { file: '/cfg/projects/broken.json', errors: [{ path: 'hosts', message: 'Missing required key `hosts`' }, { path: 'title', message: '`title` must be a string, got number' }] },
    warnings: [{ file: '/cfg/projects/broken.json', path: 'colour', message: 'Unknown key `colour`, ignored' }],
    project: null,
    credentials: null,
  };
  const { collector, sources, secrets, discoverers, http, logs } = make({ project });
  await collector.refresh();
  assert.equal(collector.ok, false);
  assert.equal(collector.busy(), false);
  assert.equal(collector.lastDoneAt(), null);
  assert.equal(secrets.calls.length, 0);
  assert.equal(discoverers.calls.length, 0);
  assert.equal(http.calls.length, 0);
  for (const name of ['github', 'bitbucket', 'jira']) assert.equal(sources[name].calls.length, 0);
  assert.deepEqual(logs, []);
  const s = collector.snapshot({ rate: 'hourly' });
  assert.deepEqual(s.project, {
    id: 'broken',
    title: 'broken',
    hosts: {},
    error: '/cfg/projects/broken.json: Missing required key `hosts`; `title` must be a string, got number',
    warnings: ['broken.json: Unknown key `colour`, ignored'],
  });
  assert.equal(s.generatedAt, null);
  assert.equal(s.rate, 'hourly');
  assert.deepEqual(s.prs, []);
  assert.deepEqual(s.repos, []);
  assert.deepEqual(s.fix, { sharedPackages: [], fixPrompts: {}, fixNotes: {} });
});

// --- warnings ---

test('project warnings: board warnings, project warnings, then round warnings, all strings', async () => {
  const boardWarnings = [{ file: '/cfg/config.json', path: 'colour', message: 'Unknown key `colour`, ignored' }];
  const project = entry({
    warnings: [{ file: '/cfg/projects/acme.json', path: 'fixPrompts.lock-mising', message: 'Unknown key `fixPrompts.lock-mising`, ignored' }],
    project: { ...PROJECT, repos: { github: ['acme-api', 'acme-gone'] } },
  });
  const { collector } = make({ project, boardWarnings });
  const before = ['config.json: Unknown key `colour`, ignored', 'acme.json: Unknown key `fixPrompts.lock-mising`, ignored'];
  assert.deepEqual(collector.snapshot().project.warnings, before);
  await collector.refresh();
  assert.deepEqual(collector.snapshot().project.warnings, [...before, "`acme-gone` not found, or the token can't see it"]);
});

// --- lock check (group 6 plugs in here) ---

const LOCK = {
  package: 'acme/shared',
  sharedRepo: { host: 'bitbucket', repo: 'acme-backend', repoShort: 'backend', defaultBranch: 'develop' },
  constraint: 'dev-develop',
  lockRef: 'abc',
  missingPrs: [],
};

test('lockCheck runs after both sources and before Jira, with every repo, the host auths, now, matchers and a log', async () => {
  const order = [];
  let seen;
  const github = scripted([() => (order.push('github'), { prs: [pr('github', 'acme-api', 1)] })]);
  const bitbucket = scripted([() => (order.push('bitbucket'), { prs: [pr('bitbucket', 'acme-worker', 2)] })]);
  const jira = scripted([() => (order.push('jira'), { tickets: {} })]);
  const lockCheck = async (prs, ctx) => {
    order.push('locks');
    seen = { prs, ctx };
    return prs.map((p) => ({ ...p, locks: [LOCK] }));
  };
  const { collector } = make({ github, bitbucket, jira, lockCheck });
  await collector.refresh();
  assert.deepEqual(order.slice(2), ['locks', 'jira']);
  assert.deepEqual(order.slice(0, 2).sort(), ['bitbucket', 'github']);
  assert.deepEqual(seen.prs.map((p) => p.id), ['github:acme-api#1', 'bitbucket:acme-worker#2']);
  assert.equal(seen.ctx.project, PROJECT);
  assert.deepEqual(seen.ctx.repos, REPOS);
  assert.deepEqual(Object.keys(seen.ctx.auth).sort(), ['bitbucket', 'github']);
  assert.equal(await seen.ctx.auth.github(), 'Bearer gh-secret');
  assert.equal(await seen.ctx.auth.bitbucket(), 'Basic bb-secret');
  assert.equal(seen.ctx.now, NOW);
  assert.equal(seen.ctx.matchers, PROJECT.tickets);
  assert.equal(typeof seen.ctx.log, 'function');
  assert.deepEqual(collector.snapshot().prs.map((p) => p.locks), [[LOCK], [LOCK]]);
});

test('lockCheck auth leaves out a host whose auth failed', async () => {
  let seen;
  const secrets = stubSecrets({ github: new Error('No GitHub token'), bitbucket: 'Basic bb-secret', jira: 'Basic jira-secret' });
  const lockCheck = async (prs, ctx) => ((seen = ctx), prs);
  const { collector } = make({ secrets, lockCheck });
  await collector.refresh();
  assert.deepEqual(Object.keys(seen.auth), ['bitbucket']);
});

test('the default lock check is a pass-through that gives every PR a locks list', async () => {
  const { collector } = make({
    github: scripted([{ prs: [pr('github', 'acme-api', 1)] }]),
    bitbucket: scripted([{ prs: [pr('bitbucket', 'acme-worker', 2, { locks: [LOCK] })] }]),
  });
  await collector.refresh();
  assert.deepEqual(collector.snapshot().prs.map((p) => p.locks), [[], [LOCK]]);
  assert.deepEqual(await passThroughLocks([{ id: 'x' }]), [{ id: 'x', locks: [] }]);
});

test('a throwing lock check logs one line and keeps the PRs with an empty locks list', async () => {
  const logs = [];
  const lockCheck = async () => { throw new Error('boom'); };
  const { collector } = make({ logs, lockCheck, github: scripted([{ prs: [pr('github', 'acme-api', 1)] }]) });
  await collector.refresh();
  assert.deepEqual(collector.snapshot().prs.map((p) => [p.number, p.locks]), [[1, []]]);
  assert.equal(logs.filter((l) => l === '2026-11-06T10:00:00Z acme lock check failed: boom').length, 1);
});

// --- fix context ---

test('resolveSharedPackages: entries resolved against the repo set; missing and ambiguous references ignored with warnings', () => {
  const repos = [...REPOS, { host: 'github', repo: 'acme-twin', repoShort: 'acme-twin', defaultBranch: 'main' }, { host: 'bitbucket', repo: 'acme-twin', repoShort: 'acme-twin', defaultBranch: 'develop' }];
  const project = {
    ...PROJECT,
    sharedPackages: [
      { repo: 'acme-backend', kind: 'composer', package: 'acme/kit', consumers: ['acme-worker', 'github:acme-api', 'acme-gone', 'acme-twin'] },
      { repo: 'acme-nowhere', kind: 'composer', package: 'acme/x', consumers: ['acme-worker'] },
      { repo: 'acme-twin', kind: 'composer', package: 'acme/y', consumers: ['acme-worker'] },
    ],
  };
  assert.deepEqual(resolveSharedPackages(project, repos), {
    sharedPackages: [{
      repo: 'acme-backend',
      repoShort: 'backend',
      host: 'bitbucket',
      package: 'acme/kit',
      defaultBranch: 'develop',
      consumers: [
        { repo: 'acme-worker', repoShort: 'worker', host: 'bitbucket' },
        { repo: 'acme-api', repoShort: 'api', host: 'github' },
      ],
    }],
    warnings: [
      "Consumer `acme-gone` of `acme/kit` isn't in the project, ignored",
      '`acme-twin` is a repo on both hosts, so the shared package reference is ignored: write `github:acme-twin` or `bitbucket:acme-twin`',
      "Shared package repo `acme-nowhere` isn't in the project, ignored",
      '`acme-twin` is a repo on both hosts, so the shared package reference is ignored: write `github:acme-twin` or `bitbucket:acme-twin`',
    ],
  });
  assert.deepEqual(resolveSharedPackages(PROJECT, REPOS), { sharedPackages: [], warnings: [] });
});

test('fix: shared packages resolved after a round, project fix prompts and personal fix notes', async () => {
  const project = entry({
    project: {
      ...PROJECT,
      sharedPackages: [{ repo: 'acme-backend', kind: 'composer', package: 'acme/kit', consumers: ['acme-worker', 'acme-gone'] }],
      fixPrompts: { group: 'Wait for CI.' },
    },
  });
  const settings = { ...SETTINGS, fixNotes: { all: 'Use git only.' } };
  const { collector } = make({ project, settings });
  assert.deepEqual(collector.snapshot().fix, { sharedPackages: [], fixPrompts: { group: 'Wait for CI.' }, fixNotes: { all: 'Use git only.' } });
  await collector.refresh();
  const s = collector.snapshot();
  assert.deepEqual(s.fix.sharedPackages, [{
    repo: 'acme-backend',
    repoShort: 'backend',
    host: 'bitbucket',
    package: 'acme/kit',
    defaultBranch: 'develop',
    consumers: [{ repo: 'acme-worker', repoShort: 'worker', host: 'bitbucket' }],
  }]);
  assert.deepEqual(s.project.warnings, ["Consumer `acme-gone` of `acme/kit` isn't in the project, ignored"]);
});

test('fix: shared package warnings wait until every host of the project has a repo set', async () => {
  const secrets = stubSecrets({ github: new Error('No GitHub token'), bitbucket: 'Basic bb-secret', jira: 'Basic jira-secret' });
  const project = entry({
    project: { ...PROJECT, sharedPackages: [{ repo: 'acme-backend', kind: 'composer', package: 'acme/kit', consumers: ['acme-worker', 'github:acme-api'] }] },
  });
  const { collector } = make({ project, secrets });
  await collector.refresh();
  const s = collector.snapshot();
  assert.deepEqual(s.project.warnings, []);
  assert.deepEqual(s.fix.sharedPackages.map((p) => p.consumers.map((c) => c.repo)), [['acme-worker']]);
});

// --- follow-up input for the board ---

test('needsFollowUp: true while a non-draft PR has unknown mergeability', async () => {
  const { collector } = make({
    github: scripted([
      { prs: [pr('github', 'acme-api', 1, { mergeable: 'unknown' })] },
      { prs: [pr('github', 'acme-api', 1, { mergeable: 'unknown', draft: true })] },
    ]),
  });
  assert.equal(collector.needsFollowUp(), false);
  await collector.refresh();
  assert.equal(collector.needsFollowUp(), true);
  await collector.refresh();
  assert.equal(collector.needsFollowUp(), false);
});

test('lastDoneAt is the end of the last round, also when the round failed', async () => {
  const now = clock();
  const { collector } = make({ now });
  await collector.refresh();
  assert.equal(collector.lastDoneAt(), NOW);
  now.advance(60);
  await collector.refresh();
  assert.equal(collector.lastDoneAt(), NOW + 60_000);
});

// --- viewer identity ("mine") ---

test('identity: first round looks up the viewer per host with that host auth and passes it as me', async () => {
  const { collector, sources, http } = make();
  await collector.refresh();
  const gh = http.calls.find((c) => c.url === GH_USER);
  const bb = http.calls.find((c) => c.url === BB_USER);
  assert.equal(gh.opts.auth, 'Bearer gh-secret');
  assert.equal(gh.opts.headers.Accept, 'application/vnd.github+json');
  assert.equal(bb.opts.auth, 'Basic bb-secret');
  for (const c of http.calls) assert.equal(c.opts.method, undefined);
  assert.equal(sources.github.calls[0][0].me, 'octo');
  assert.equal(sources.bitbucket.calls[0][0].me, '{me}');
});

test('identity: a successful lookup is cached across rounds', async () => {
  const { collector, sources, http } = make();
  await collector.refresh();
  await collector.refresh();
  await collector.refresh();
  assert.equal(http.calls.filter((c) => c.url === GH_USER).length, 1);
  assert.equal(http.calls.filter((c) => c.url === BB_USER).length, 1);
  assert.equal(sources.github.calls[2][0].me, 'octo');
  assert.equal(sources.bitbucket.calls[2][0].me, '{me}');
});

test('identity: looked up once per (host, ref) across projects; another ref is its own lookup', async () => {
  const http = makeHttp({ [GH_USER]: { login: 'octo' }, [BB_USER]: [{ uuid: '{me}' }, { uuid: '{other}' }] });
  const identities = createIdentities({ http });
  const a = make({ http, identities });
  const b = make({ http, identities, project: entry({ id: 'beta' }) });
  const other = { ref: 'gamma-bitbucket', email: 'you@gamma.example', override: true };
  const c = make({ http, identities, project: entry({ id: 'gamma', credentials: { ...CREDENTIALS, bitbucket: other } }) });
  await a.collector.refresh();
  await b.collector.refresh();
  await c.collector.refresh();
  assert.equal(http.calls.filter((x) => x.url === GH_USER).length, 1);
  assert.equal(http.calls.filter((x) => x.url === BB_USER).length, 2);
  assert.equal(b.sources.bitbucket.calls[0][0].me, '{me}');
  assert.equal(c.sources.bitbucket.calls[0][0].me, '{other}');
});

test('identity: lookup failure → me null, one prefixed log line without auth, the source still runs; retried next round', async () => {
  const http = makeHttp({
    [GH_USER]: [new Error('GET https://api.github.com/user failed with 401'), { login: 'octo' }],
    [BB_USER]: { uuid: '{me}' },
  });
  const { collector, sources, logs } = make({ http });
  await collector.refresh();
  assert.equal(sources.github.calls.length, 1);
  assert.equal(sources.github.calls[0][0].me, null);
  assert.equal(sources.bitbucket.calls[0][0].me, '{me}');
  assert.equal(collector.snapshot().sources.github.ok, true);
  const failed = logs.filter((l) => /github identity lookup failed/.test(l));
  assert.equal(failed.length, 1);
  assert.match(failed[0], /^2026-11-06T10:00:00Z acme github identity lookup failed: .*401/);
  for (const l of logs) assert.doesNotMatch(l, /secret/);
  await collector.refresh();
  assert.equal(http.calls.filter((c) => c.url === GH_USER).length, 2);
  assert.equal(sources.github.calls[1][0].me, 'octo');
  await collector.refresh();
  assert.equal(http.calls.filter((c) => c.url === GH_USER).length, 2, 'cached after success');
});

test('identity: a mine.<host> setting replaces the lookup for that host only', async () => {
  const { collector, sources, http } = make({ settings: { ...SETTINGS, mine: { github: 'override-login' } } });
  await collector.refresh();
  assert.equal(http.calls.filter((c) => c.url === GH_USER).length, 0);
  assert.equal(http.calls.filter((c) => c.url === BB_USER).length, 1);
  assert.equal(sources.github.calls[0][0].me, 'override-login');
  assert.equal(sources.bitbucket.calls[0][0].me, '{me}');
});

test('identity: an auth failure skips the lookup for that host', async () => {
  const secrets = stubSecrets({ github: new Error('No GitHub token'), bitbucket: 'Basic bb-secret', jira: 'Basic jira-secret' });
  const { collector, http } = make({ secrets });
  await collector.refresh();
  assert.equal(http.calls.filter((c) => c.url === GH_USER).length, 0);
});

// --- repos: discovery, repo sets, warnings ---

test('repos: before the first discovery the snapshot lists the whitelist', () => {
  const project = entry({ project: { ...PROJECT, repos: { bitbucket: ['acme-worker', 'acme-backend'] } } });
  const { collector } = make({ project });
  assert.deepEqual(collector.snapshot().repos.map((r) => r.repoShort), ['worker', 'backend']);
});

test('repos: discovery runs once an hour per host, with the host auth and the project owner', async () => {
  const now = clock();
  const { collector, discoverers } = make({ now });
  await collector.refresh();
  await collector.refresh();
  assert.deepEqual(discoverers.calls.map((c) => [c.host, c.owner]), [['github', 'acme-corp'], ['bitbucket', 'acme']]);
  assert.equal(await discoverers.calls[0].auth(), 'Bearer gh-secret');
  assert.equal(await discoverers.calls[1].auth(), 'Basic bb-secret');
  now.advance(3600);
  await collector.refresh();
  assert.equal(discoverers.calls.length, 4);
});

test('repos: whitelist misses and the Bitbucket cap become project warnings, logged once with the prefix', async () => {
  const many = Array.from({ length: 45 }, (_, i) => ({ name: `acme-r${i}`, defaultBranch: 'develop' }));
  const project = entry({ project: { ...PROJECT, repos: { github: ['acme-api', 'acme-gone'] } } });
  const logs = [];
  const { collector, sources } = make({
    logs,
    project,
    discoverers: stubDiscoverers({ github: [{ name: 'acme-api', defaultBranch: 'main' }], bitbucket: many }),
  });
  await collector.refresh();
  await collector.refresh();
  const s = collector.snapshot();
  assert.deepEqual(s.project.warnings, [
    "`acme-gone` not found, or the token can't see it",
    'Showing 40 of 45 Bitbucket repos (rate limit). Add a repo list to choose which.',
  ]);
  assert.deepEqual(sources.github.calls[0][0].repos.map((r) => r.repo), ['acme-api']);
  assert.equal(sources.bitbucket.calls[0][0].repos.length, 40);
  assert.equal(logs.filter((l) => /^2026-11-06T10:00:00Z acme warning: .*acme-gone/.test(l)).length, 1);
});

test('repos: a failed discovery without a whitelist is that source error; the source is not called', async () => {
  const { collector, sources } = make({ discoverers: stubDiscoverers({ github: [{ name: 'acme-api', defaultBranch: 'main' }], bitbucket: new Error('GET … failed with 403') }) });
  await collector.refresh();
  const s = collector.snapshot();
  assert.equal(sources.bitbucket.calls.length, 0);
  assert.equal(s.sources.bitbucket.ok, false);
  assert.match(s.sources.bitbucket.error, /repo discovery failed: .*403/);
  assert.equal(s.sources.github.ok, true);
});

test('repos: a failed discovery with a whitelist uses the whitelist and logs one line', async () => {
  const project = entry({ project: { ...PROJECT, repos: { bitbucket: ['acme-backend'] } } });
  const logs = [];
  const { collector, sources } = make({ logs, project, discoverers: stubDiscoverers({ github: [], bitbucket: new Error('503') }) });
  await collector.refresh();
  assert.deepEqual(sources.bitbucket.calls[0][0].repos, [
    { host: 'bitbucket', repo: 'acme-backend', repoShort: 'backend', repoUrl: 'https://bitbucket.org/acme/acme-backend/pull-requests/', defaultBranch: null },
  ]);
  assert.equal(collector.snapshot().sources.bitbucket.ok, true);
  assert.equal(logs.filter((l) => /acme bitbucket repo discovery failed, using the repo list: 503/.test(l)).length, 1);
});

test('repos: a host the project does not use gets no auth, discovery or source call', async () => {
  const project = entry({ project: { ...PROJECT, hosts: { bitbucket: { workspace: 'acme' } } } });
  const { collector, sources, discoverers, http, secrets } = make({ project });
  await collector.refresh();
  assert.equal(secrets.calls.filter((c) => c.host === 'github').length, 0);
  assert.equal(sources.github.calls.length, 0);
  assert.deepEqual(discoverers.calls.map((c) => c.host), ['bitbucket']);
  assert.equal(http.calls.filter((c) => c.url === GH_USER).length, 0);
  assert.equal(collector.snapshot().sources.github.ok, true);
  assert.deepEqual(collector.snapshot().project.hosts, { bitbucket: { workspace: 'acme' } });
});
