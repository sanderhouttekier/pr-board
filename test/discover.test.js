import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHttp, HttpError } from '../src/http.js';
import {
  discoverGithub,
  discoverBitbucket,
  repoSet,
  resolveRepoRef,
  createDiscovery,
  BITBUCKET_CAP,
  DISCOVERY_TTL_MS,
} from '../src/discover.js';

const FIX = new URL('./fixtures/', import.meta.url);
const fixture = (name) => JSON.parse(readFileSync(new URL(name, FIX), 'utf8'));
const AUTH = 'Bearer ghp_TESTONLY_not_a_real_token';
const auth = async () => AUTH;

const GH_ORG_1 = 'https://api.github.com/orgs/acme-corp/repos?type=sources&per_page=100';
const GH_ORG_2 = 'https://api.github.com/organizations/1/repos?type=sources&per_page=100&page=2';
const GH_USER = 'https://api.github.com/users/ada/repos?type=owner&per_page=100';
const GH_ADA_ORG = 'https://api.github.com/orgs/ada/repos?type=sources&per_page=100';
const GH_OWN_1 = 'https://api.github.com/user/repos?affiliation=owner&per_page=100';
const GH_OWN_2 = 'https://api.github.com/user/repos?affiliation=owner&per_page=100&page=2';
const BB_1 = 'https://api.bitbucket.org/2.0/repositories/acme?pagelen=100&sort=-updated_on&fields=values.slug,values.parent.full_name,values.updated_on,values.mainbranch.name,next';
const BB_2 = 'https://api.bitbucket.org/2.0/repositories/acme?pagelen=100&sort=-updated_on&fields=values.slug%2Cvalues.parent.full_name%2Cvalues.updated_on%2Cvalues.mainbranch.name%2Cnext&page=2';

// The real http.js over a fake fetch, so pagination (Link header, Bitbucket `next`) runs for real.
// `routes`: URL -> { file | body | status, link }.
function httpOver(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = routes[String(url)];
    if (!r) return new Response('{"message":"Not Found"}', { status: 404 });
    if (r.status && r.status !== 200) return new Response('{"message":"x"}', { status: r.status });
    const body = r.file ? fixture(r.file) : r.body;
    return new Response(JSON.stringify(body), { status: 200, headers: r.link ? { link: r.link } : {} });
  };
  const http = createHttp({ fetch });
  return { http, calls };
}

const GH_ROUTES = {
  [GH_ORG_1]: { file: 'github/discover-org-1.json', link: `<${GH_ORG_2}>; rel="next", <${GH_ORG_2}>; rel="last"` },
  [GH_ORG_2]: { file: 'github/discover-org-2.json' },
};
const BB_ROUTES = {
  [BB_1]: { file: 'bitbucket/discover-1.json' },
  [BB_2]: { file: 'bitbucket/discover-2.json' },
};

// --- discoverGithub ---

test('discoverGithub: all pages of the org listing, archived and disabled dropped, default branch kept', async () => {
  const { http, calls } = httpOver(GH_ROUTES);
  const repos = await discoverGithub({ http, auth, owner: 'acme-corp' });
  assert.deepEqual(repos, [
    { name: 'acme-api', defaultBranch: 'main' },
    { name: 'acme-app', defaultBranch: 'develop' },
    { name: 'acme-status', defaultBranch: 'main' },
  ]);
  assert.deepEqual(calls.map((c) => c.url), [GH_ORG_1, GH_ORG_2], 'an org never calls /user/repos');
  for (const c of calls) {
    assert.equal(c.init.method, 'GET');
    assert.equal(c.init.headers.Authorization, AUTH);
    assert.equal(c.init.headers.Accept, 'application/vnd.github+json');
  }
});

test("discoverGithub: a 404 on the org lists the token's own repos (private too), only the owner's, all pages", async () => {
  const { http, calls } = httpOver({
    [GH_OWN_1]: { file: 'github/discover-own-1.json', link: `<${GH_OWN_2}>; rel="next", <${GH_OWN_2}>; rel="last"` },
    [GH_OWN_2]: { file: 'github/discover-own-2.json' },
    [GH_USER]: { file: 'github/discover-user.json' },
  });
  const repos = await discoverGithub({ http, auth, owner: 'ada' });
  assert.deepEqual(repos, [
    { name: 'acme-notes', defaultBranch: 'main' },
    { name: 'acme-site', defaultBranch: 'gh-pages' },
    { name: 'acme-scratch', defaultBranch: 'main' },
  ], 'other owners dropped, owner matched case-insensitively, forks and archived dropped');
  assert.deepEqual(calls.map((c) => c.url), [GH_ADA_ORG, GH_OWN_1, GH_OWN_2], 'no public user listing needed');
  assert.ok(calls.every((c) => c.init.method === 'GET' && c.init.headers.Authorization === AUTH));
});

test("discoverGithub: a 404 on the org and nothing of the owner's in /user/repos falls back to the public user listing", async () => {
  const { http, calls } = httpOver({
    [GH_OWN_1]: { body: [{ name: 'acme-api', owner: { login: 'acme-corp' }, fork: false, archived: false, disabled: false, default_branch: 'main' }] },
    [GH_USER]: { file: 'github/discover-user.json' },
  });
  const repos = await discoverGithub({ http, auth, owner: 'ada' });
  assert.deepEqual(repos, [{ name: 'acme-tools', defaultBranch: 'main' }], 'forks dropped');
  assert.deepEqual(calls.map((c) => c.url), [GH_ADA_ORG, GH_OWN_1, GH_USER]);
});

test('discoverGithub: a failing /user/repos (e.g. 403) still falls back to the public user listing', async () => {
  const { http, calls } = httpOver({
    [GH_OWN_1]: { status: 403 },
    [GH_USER]: { file: 'github/discover-user.json' },
  });
  const repos = await discoverGithub({ http, auth, owner: 'ada' });
  assert.deepEqual(repos, [{ name: 'acme-tools', defaultBranch: 'main' }]);
  assert.deepEqual(calls.map((c) => c.url), [GH_ADA_ORG, GH_OWN_1, GH_USER]);
});

test('discoverGithub: any other failure is thrown, without the user fallback', async () => {
  const { http, calls } = httpOver({ [GH_ORG_1]: { status: 403 } });
  await assert.rejects(discoverGithub({ http, auth, owner: 'acme-corp' }), (err) => err instanceof HttpError && err.status === 403);
  assert.equal(calls.length, 1);
});

// --- discoverBitbucket ---

test('discoverBitbucket: all pages, sorted by -updated_on, forks (with a parent) dropped, mainbranch kept', async () => {
  const { http, calls } = httpOver(BB_ROUTES);
  const repos = await discoverBitbucket({ http, auth, owner: 'acme' });
  assert.deepEqual(repos, [
    { name: 'acme-backend', defaultBranch: 'develop' },
    { name: 'acme-web', defaultBranch: 'develop' },
    { name: 'acme-shared', defaultBranch: 'develop' },
    { name: 'acme-worker', defaultBranch: 'main' },
  ]);
  assert.deepEqual(calls.map((c) => c.url), [BB_1, BB_2]);
  assert.ok(calls.every((c) => c.init.headers.Authorization === AUTH));
});

test('discoverBitbucket: most recently updated first even when a page comes back unsorted; no mainbranch → null', async () => {
  const values = [
    { slug: 'acme-old', updated_on: '2026-01-01T00:00:00+00:00' },
    { slug: 'acme-new', updated_on: '2026-11-01T00:00:00+00:00', mainbranch: { name: 'main' } },
  ];
  const { http } = httpOver({ [BB_1]: { body: { values } } });
  assert.deepEqual(await discoverBitbucket({ http, auth, owner: 'acme' }), [
    { name: 'acme-new', defaultBranch: 'main' },
    { name: 'acme-old', defaultBranch: null },
  ]);
});

// --- repoSet ---

const gh = (...names) => names.map((name) => ({ name, defaultBranch: 'main' }));
const bb = (...names) => names.map((name) => ({ name, defaultBranch: 'develop' }));
const project = (extra = {}) => ({
  hosts: { github: { owner: 'acme-corp' }, bitbucket: { workspace: 'acme' } },
  ...extra,
});

test('repoSet: with a whitelist, exactly those repos in whitelist order, with url and default branch', () => {
  const p = project({ repos: { bitbucket: ['acme-web', 'acme-backend'] } });
  const { repos, warnings } = repoSet({ bitbucket: bb('acme-backend', 'acme-shared', 'acme-web') }, p, 'bitbucket');
  assert.deepEqual(repos, [
    { host: 'bitbucket', repo: 'acme-web', repoShort: 'acme-web', repoUrl: 'https://bitbucket.org/acme/acme-web/pull-requests/', defaultBranch: 'develop' },
    { host: 'bitbucket', repo: 'acme-backend', repoShort: 'acme-backend', repoUrl: 'https://bitbucket.org/acme/acme-backend/pull-requests/', defaultBranch: 'develop' },
  ]);
  assert.deepEqual(warnings, []);
});

test('repoSet: a whitelisted repo discovery did not return is skipped with a warning', () => {
  const p = project({ repos: { bitbucket: ['acme-backend', 'acme-web'] } });
  const { repos, warnings } = repoSet({ bitbucket: bb('acme-backend') }, p, 'bitbucket');
  assert.deepEqual(repos.map((r) => r.repo), ['acme-backend']);
  assert.deepEqual(warnings, ["`acme-web` not found, or the token can't see it"]);
});

test('repoSet: whitelist names match discovery case-insensitively and keep the discovered spelling', () => {
  const p = project({ repos: { github: ['ACME-API'] } });
  const { repos, warnings } = repoSet({ github: gh('acme-api') }, p, 'github');
  assert.deepEqual(repos.map((r) => r.repo), ['acme-api']);
  assert.deepEqual(warnings, []);
});

test('repoSet: discovery unknown (failed, nothing cached) → the whitelist as is, default branch null, no warnings', () => {
  const p = project({ repos: { bitbucket: ['acme-backend'] } });
  const { repos, warnings } = repoSet({}, p, 'bitbucket');
  assert.deepEqual(repos, [
    { host: 'bitbucket', repo: 'acme-backend', repoShort: 'acme-backend', repoUrl: 'https://bitbucket.org/acme/acme-backend/pull-requests/', defaultBranch: null },
  ]);
  assert.deepEqual(warnings, []);
  assert.deepEqual(repoSet({}, project(), 'bitbucket'), { repos: [], warnings: [] });
});

test('repoSet: without a whitelist, every discovered repo in discovery order', () => {
  const { repos, warnings } = repoSet({ github: gh('acme-api', 'acme-app') }, project(), 'github');
  assert.deepEqual(repos, [
    { host: 'github', repo: 'acme-api', repoShort: 'acme-api', repoUrl: 'https://github.com/acme-corp/acme-api/pulls', defaultBranch: 'main' },
    { host: 'github', repo: 'acme-app', repoShort: 'acme-app', repoUrl: 'https://github.com/acme-corp/acme-app/pulls', defaultBranch: 'main' },
  ]);
  assert.deepEqual(warnings, []);
});

test('repoSet: Bitbucket without a whitelist is capped at 40, most recent first, with the SPEC warning', () => {
  assert.equal(BITBUCKET_CAP, 40);
  const many = bb(...Array.from({ length: 112 }, (_, i) => `acme-r${i}`));
  const { repos, warnings } = repoSet({ bitbucket: many }, project(), 'bitbucket');
  assert.equal(repos.length, 40);
  assert.deepEqual(repos.map((r) => r.repo), many.slice(0, 40).map((r) => r.name));
  assert.deepEqual(warnings, ['Showing 40 of 112 Bitbucket repos (rate limit). Add a repo list to choose which.']);

  const exact = repoSet({ bitbucket: many.slice(0, 40) }, project(), 'bitbucket');
  assert.equal(exact.repos.length, 40);
  assert.deepEqual(exact.warnings, []);
});

test('repoSet: no cap on GitHub, and no cap with a Bitbucket whitelist', () => {
  const names = Array.from({ length: 60 }, (_, i) => `acme-r${i}`);
  const ghSet = repoSet({ github: gh(...names) }, project(), 'github');
  assert.equal(ghSet.repos.length, 60);
  assert.deepEqual(ghSet.warnings, []);
  const bbSet = repoSet({ bitbucket: bb(...names) }, project({ repos: { bitbucket: names } }), 'bitbucket');
  assert.equal(bbSet.repos.length, 60);
  assert.deepEqual(bbSet.warnings, []);
});

test('repoSet: aliases give repoShort; host:name references apply to that host only', () => {
  const p = project({
    aliases: { 'acme-backend': 'backend', 'github:acme-api': 'api', 'bitbucket:acme-web': 'web', 'github:acme-web': 'gh-web' },
  });
  const discovered = { github: gh('acme-api', 'acme-web'), bitbucket: bb('acme-backend', 'acme-web') };
  assert.deepEqual(repoSet(discovered, p, 'bitbucket').repos.map((r) => r.repoShort), ['backend', 'web']);
  assert.deepEqual(repoSet(discovered, p, 'github').repos.map((r) => r.repoShort), ['api', 'gh-web']);
});

test('repoSet: a plain alias matching a repo on both hosts is ignored with a warning', () => {
  const p = project({ aliases: { 'acme-web': 'web', 'acme-api': 'api' } });
  const discovered = { github: gh('acme-api', 'acme-web'), bitbucket: bb('acme-web') };
  const ghSet = repoSet(discovered, p, 'github');
  assert.deepEqual(ghSet.repos.map((r) => r.repoShort), ['api', 'acme-web']);
  assert.deepEqual(ghSet.warnings, ['`acme-web` is a repo on both hosts, so its alias is ignored: write `github:acme-web` or `bitbucket:acme-web`']);
  const bbSet = repoSet(discovered, p, 'bitbucket');
  assert.deepEqual(bbSet.repos.map((r) => r.repoShort), ['acme-web']);
  assert.deepEqual(bbSet.warnings, ghSet.warnings);
});

test('repoSet: duplicate alias values keep the first in file order; later ones are ignored with a warning', () => {
  const p = project({ aliases: { 'acme-backend': 'core', 'github:acme-api': 'core', 'acme-web': 'web', 'acme-shared': 'core' } });
  const discovered = { github: gh('acme-api'), bitbucket: bb('acme-backend', 'acme-web', 'acme-shared') };
  const warnings = [
    'The alias `core` is used more than once, so the alias of `github:acme-api` is ignored',
    'The alias `core` is used more than once, so the alias of `acme-shared` is ignored',
  ];
  const bbSet = repoSet(discovered, p, 'bitbucket');
  assert.deepEqual(bbSet.repos.map((r) => r.repoShort), ['core', 'web', 'acme-shared']);
  assert.deepEqual(bbSet.warnings, warnings);
  const ghSet = repoSet(discovered, p, 'github');
  assert.deepEqual(ghSet.repos.map((r) => r.repoShort), ['acme-api']);
  assert.deepEqual(ghSet.warnings, warnings, 'the same text from both hosts, so the collector dedupes it');
});

test('repoSet: a host the project does not use gives nothing', () => {
  const p = { hosts: { bitbucket: { workspace: 'acme' } } };
  assert.deepEqual(repoSet({ github: gh('acme-api') }, p, 'github'), { repos: [], warnings: [] });
});

test('resolveRepoRef: plain, host-qualified, ambiguous and unknown references', () => {
  const names = { github: ['acme-api', 'acme-web'], bitbucket: ['acme-web', 'acme-shared'] };
  assert.deepEqual(resolveRepoRef('acme-api', names), { host: 'github', repo: 'acme-api' });
  assert.deepEqual(resolveRepoRef('acme-shared', names), { host: 'bitbucket', repo: 'acme-shared' });
  assert.deepEqual(resolveRepoRef('bitbucket:acme-web', names), { host: 'bitbucket', repo: 'acme-web' });
  assert.deepEqual(resolveRepoRef('github:acme-web', names), { host: 'github', repo: 'acme-web' });
  assert.deepEqual(resolveRepoRef('acme-web', names), { ambiguous: true, repo: 'acme-web' });
  assert.equal(resolveRepoRef('acme-nope', names), null);
  assert.equal(resolveRepoRef('github:acme-shared', names), null);
});

// --- discovery cache ---

test('createDiscovery: at most once an hour per host and owner, with an injected now', async () => {
  assert.equal(DISCOVERY_TTL_MS, 3_600_000);
  const calls = [];
  const discoverers = {
    github: async (args) => (calls.push(['github', args.owner]), gh('acme-api')),
    bitbucket: async (args) => (calls.push(['bitbucket', args.owner]), bb('acme-web')),
  };
  const d = createDiscovery({ http: {}, discoverers });
  const T = Date.parse('2026-11-09T10:00:00Z');
  assert.deepEqual(await d.repos('github', { owner: 'acme-corp', auth, now: T }), gh('acme-api'));
  await d.repos('github', { owner: 'acme-corp', auth, now: T + DISCOVERY_TTL_MS - 1 });
  await d.repos('bitbucket', { owner: 'acme', auth, now: T });
  assert.deepEqual(calls, [['github', 'acme-corp'], ['bitbucket', 'acme']]);
  await d.repos('github', { owner: 'acme-corp', auth, now: T + DISCOVERY_TTL_MS });
  assert.equal(calls.length, 3);
  await d.repos('github', { owner: 'acme-other', auth, now: T + DISCOVERY_TTL_MS });
  assert.equal(calls.length, 4, 'another owner is another entry');
});

test('createDiscovery: passes http and auth through to the discoverer', async () => {
  const http = { marker: true };
  let seen;
  const d = createDiscovery({ http, discoverers: { github: async (args) => ((seen = args), []) } });
  await d.repos('github', { owner: 'acme-corp', auth, now: 0 });
  assert.equal(seen.http, http);
  assert.equal(seen.auth, auth);
  assert.equal(seen.owner, 'acme-corp');
});

test('createDiscovery: a failure keeps the last good list and retries next call; with nothing cached it throws', async () => {
  const results = [gh('acme-api'), new Error('503'), new Error('503'), gh('acme-app')];
  let n = 0;
  const d = createDiscovery({ http: {}, discoverers: { github: async () => { const r = results[n++]; if (r instanceof Error) throw r; return r; } } });
  const T = 0;
  await d.repos('github', { owner: 'acme-corp', auth, now: T });
  assert.deepEqual(await d.repos('github', { owner: 'acme-corp', auth, now: T + DISCOVERY_TTL_MS }), gh('acme-api'), 'stale list kept');
  assert.deepEqual(await d.repos('github', { owner: 'acme-corp', auth, now: T + DISCOVERY_TTL_MS + 1 }), gh('acme-api'), 'retried, still stale');
  assert.equal(n, 3);
  assert.deepEqual(await d.repos('github', { owner: 'acme-corp', auth, now: T + DISCOVERY_TTL_MS + 2 }), gh('acme-app'));

  const empty = createDiscovery({ http: {}, discoverers: { github: async () => { throw new Error('401'); } } });
  await assert.rejects(empty.repos('github', { owner: 'acme-corp', auth, now: T }), /401/);
});
