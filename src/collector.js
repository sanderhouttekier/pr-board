// One collector per project (SPEC "Collector and polling"): rounds, per-source caches and last good
// data, the project snapshot. No timers: src/board.js decides when a round runs.
import { collectGithub, githubViewer } from './sources/github.js';
import { collectBitbucket, bitbucketViewer } from './sources/bitbucket.js';
import { collectJira, jiraSites } from './sources/jira.js';
import { createDiscovery, repoSet, resolveRepoRef } from './discover.js';
import { describeError, describeWarning } from './config.js';
import * as derive from './derive.js';

const ERROR_MAX = 300;
const PR_HOSTS = ['github', 'bitbucket'];
const SOURCES = ['github', 'bitbucket', 'jira'];
const NO_CREDENTIAL = Object.freeze({ ref: '', override: false });

const code = (s) => `\`${s}\``;

// Log time: ISO without milliseconds, as in SPEC "Collector and polling".
export const stamp = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

// First line of the message only; secrets and http already keep auth out of messages.
function shortError(err) {
  return String(err?.message ?? err).split('\n')[0].slice(0, ERROR_MAX);
}

/** The default lock check until the shared package check is wired in: every PR gets a `locks` list. */
export async function passThroughLocks(prs) {
  return prs.map((pr) => ({ ...pr, locks: pr.locks ?? [] }));
}

/**
 * Viewer identities ("mine"), shared by every project: looked up once per (host, ref), because a
 * credential override can be another account. Cached after success; a failure is not cached and rethrows.
 */
export function createIdentities({ http, viewers = { github: githubViewer, bitbucket: bitbucketViewer } }) {
  const cache = new Map(); // `${host}\0${ref}` → in-flight lookup
  function lookup(host, credential, authValue) {
    const key = `${host}\0${credential?.ref ?? ''}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = viewers[host]({ http, auth: authValue });
      cache.set(key, pending);
      pending.catch(() => {
        if (cache.get(key) === pending) cache.delete(key);
      });
    }
    return pending;
  }
  return { lookup };
}

/**
 * The project's `sharedPackages` resolved against its repo set (all hosts), for the fix prompts.
 * → { sharedPackages: [{ repo, repoShort, host, package, defaultBranch, consumers: [{ repo, repoShort, host }] }], warnings }
 * A reference that isn't in the repo set, or is ambiguous, is ignored with a warning.
 */
export function resolveSharedPackages(project, repos) {
  const names = {};
  for (const r of repos) (names[r.host] ??= []).push(r.repo);
  const find = (hit) => repos.find((r) => r.host === hit.host && r.repo === hit.repo);
  const warnings = [];
  const resolve = (ref, missing) => {
    const hit = resolveRepoRef(ref, names);
    if (hit?.ambiguous) {
      warnings.push(`${code(ref)} is a repo on both hosts, so the shared package reference is ignored: write ${code(`github:${ref}`)} or ${code(`bitbucket:${ref}`)}`);
      return null;
    }
    if (!hit) {
      warnings.push(missing);
      return null;
    }
    return find(hit);
  };

  const sharedPackages = [];
  for (const sp of project?.sharedPackages ?? []) {
    const repo = resolve(sp.repo, `Shared package repo ${code(sp.repo)} isn't in the project, ignored`);
    if (!repo) continue;
    const consumers = [];
    for (const ref of sp.consumers ?? []) {
      const c = resolve(ref, `Consumer ${code(ref)} of ${code(sp.package)} isn't in the project, ignored`);
      if (c) consumers.push({ repo: c.repo, repoShort: c.repoShort, host: c.host });
    }
    sharedPackages.push({ repo: repo.repo, repoShort: repo.repoShort, host: repo.host, package: sp.package, defaultBranch: repo.defaultBranch ?? null, consumers });
  }
  return { sharedPackages, warnings };
}

/**
 * createCollector({ project, settings, boardWarnings, secrets, http, sources, lockCheck, discovery, identities, now, log })
 * `project` is a loadBoard entry ({ id, title, ok, error, warnings, project, credentials }).
 * → { id, ok, refresh, busy, lastDoneAt, needsFollowUp, snapshot({ rate }) }
 */
export function createCollector({
  project: entry,
  settings,
  boardWarnings = [],
  secrets,
  http,
  sources = { github: collectGithub, bitbucket: collectBitbucket, jira: collectJira },
  lockCheck = passThroughLocks,
  discovery = createDiscovery({ http }),
  identities = createIdentities({ http }),
  now = Date.now,
  log = console.log,
}) {
  const id = entry.id;
  const project = entry.ok ? entry.project : null;
  const configWarnings = [...boardWarnings, ...(entry.warnings ?? [])].map(describeWarning);
  const projectError = entry.ok ? null : describeError(entry.error) ?? 'Project not loaded';
  const plog = (msg) => log(`${stamp(now())} ${id} ${msg}`);

  const caches = { github: new Map(), bitbucket: new Map(), jira: new Map() };
  const state = Object.fromEntries(SOURCES.map((n) => [n, { ok: null, error: null, fetchedAt: null }]));
  const prsBy = { github: [], bitbucket: [] };
  let tickets = {};
  let enriched = [];
  let generatedAt = null;
  let inFlight = null;
  let lastDoneAt = null; // last time a round finished, ok or not
  let roundWarnings = []; // repo and shared package warnings of the last round
  let sharedPackages = [];
  const warned = new Set(); // warnings already logged

  const matchers = project?.tickets ?? [];
  const sites = project ? jiraSites(project) : {};
  const ownerOf = (host) => (host === 'github' ? project?.hosts?.github?.owner : project?.hosts?.bitbucket?.workspace) ?? null;
  const credential = (host) => entry.credentials?.[host] ?? NO_CREDENTIAL;
  // Last repo set per host; until the first discovery, the whitelist (if any).
  const repoSets = Object.fromEntries(PR_HOSTS.map((h) => [h, project ? repoSet({}, project, h).repos : []]));
  const allRepos = () => PR_HOSTS.flatMap((h) => repoSets[h]);

  // Viewer identity per host: a mine.<host> setting, else the shared lookup per (host, ref).
  // A failure logs one line and gives null (no PR is mine); the next round retries.
  async function resolveMe(host, authValue) {
    const fixed = settings.mine?.[host];
    if (fixed) return fixed;
    try {
      return await identities.lookup(host, credential(host), authValue);
    } catch (err) {
      plog(`${host} identity lookup failed: ${shortError(err)}`);
      return null;
    }
  }

  // Per PR host: auth, viewer identity and discovered repos. Never throws.
  // → { host, skip } (host not in the project) | { host, error } | { host, auth, me, discovered?, discoveryError? }
  async function prepare(host, at) {
    const owner = ownerOf(host);
    if (!owner) return { host, skip: true };
    let authValue;
    try {
      authValue = await secrets.auth(host, credential(host));
    } catch (err) {
      return { host, error: shortError(err) };
    }
    const auth = async () => authValue;
    const me = await resolveMe(host, authValue);
    try {
      return { host, auth, me, discovered: await discovery.repos(host, { owner, auth, now: at }) };
    } catch (err) {
      return { host, auth, me, discoveryError: shortError(err) };
    }
  }

  // Repo sets per host from what discovery found; a failed discovery without a whitelist is a source error.
  // → the warnings of this round (repo sets, then shared packages once every host has a repo set).
  function applyRepoSets(prepared) {
    const discovered = {};
    for (const p of prepared) if (p.discovered) discovered[p.host] = p.discovered;
    const all = new Set();
    let everyHostKnown = true;
    for (const p of prepared) {
      if (p.skip) continue;
      if (p.error) {
        everyHostKnown = false;
        continue;
      }
      if (p.discoveryError && !project.repos?.[p.host]) {
        p.error = `repo discovery failed: ${p.discoveryError}`;
        everyHostKnown = false;
        continue;
      }
      if (p.discoveryError) plog(`${p.host} repo discovery failed, using the repo list: ${p.discoveryError}`);
      const set = repoSet(discovered, project, p.host);
      repoSets[p.host] = set.repos;
      for (const w of set.warnings) all.add(w);
    }
    const shared = resolveSharedPackages(project, allRepos());
    sharedPackages = shared.sharedPackages;
    if (everyHostKnown) for (const w of shared.warnings) all.add(w);
    return [...all];
  }

  function noteWarnings(list) {
    roundWarnings = list;
    for (const w of list) {
      if (!warned.has(w)) plog(`warning: ${w}`);
      warned.add(w);
    }
  }

  // Returns { result } or { error }; never throws.
  async function callPrs(p, at, run) {
    if (p.skip) return { result: { prs: [] } };
    if (p.error) return { error: p.error };
    const ctx = { project, repos: repoSets[p.host], http, auth: p.auth, cache: caches[p.host], now: at, log: plog, me: p.me };
    try {
      return { result: await run(ctx) };
    } catch (err) {
      return { error: shortError(err) };
    }
  }

  async function callJira(keysBySite, at) {
    const ctx = { sites, http, auth: () => secrets.auth('jira', credential('jira')), cache: caches.jira, now: at, log: plog };
    try {
      return { result: await sources.jira(keysBySite, ctx) };
    } catch (err) {
      return { error: shortError(err) };
    }
  }

  // The shared package check (group 6) over every PR; a failure keeps the PRs with no lock info.
  async function checkLocks(prs, prepared, at) {
    const auth = {};
    for (const p of prepared) if (p.auth) auth[p.host] = p.auth;
    try {
      return await lockCheck(prs, { project, repos: allRepos(), auth, now: at, matchers, log: plog });
    } catch (err) {
      plog(`lock check failed: ${shortError(err)}`);
      return passThroughLocks(prs);
    }
  }

  function markOk(name, at) {
    state[name] = { ok: true, error: null, fetchedAt: at };
  }

  function markError(name, error) {
    state[name] = { ...state[name], ok: false, error };
  }

  // Merge a PR source outcome into prsBy[host] and its state.
  function applyPrs(host, outcome, at) {
    if (outcome.error) return markError(host, outcome.error);
    const { prs = [], errors } = outcome.result ?? {};
    if (!errors?.length) {
      prsBy[host] = prs;
      return markOk(host, at);
    }
    const prefixes = new Set(errors.map((e) => String(e).split(':')[0]));
    const kept = [];
    for (const r of repoSets[host]) {
      if (prs.some((p) => p.repo === r.repo)) continue;
      if (!prefixes.has(r.repo) && !prefixes.has(r.repoShort)) continue;
      kept.push(...prsBy[host].filter((p) => p.repo === r.repo));
    }
    prsBy[host] = [...prs, ...kept];
    state[host] = { ok: false, error: errors.join('; '), fetchedAt: at };
  }

  function rateRemaining() {
    return http.stats?.()['api.github.com']?.rateLimitRemaining ?? null;
  }

  async function round() {
    const started = now();
    const at = new Date(started).toISOString();
    const prepared = await Promise.all(PR_HOSTS.map((host) => prepare(host, started)));
    noteWarnings(applyRepoSets(prepared));
    const [gh, bb] = await Promise.all([
      callPrs(prepared[0], started, (ctx) => sources.github(ctx)),
      callPrs(prepared[1], started, (ctx) => sources.bitbucket(ctx)),
    ]);
    applyPrs('github', gh, at);
    applyPrs('bitbucket', bb, at);

    const all = await checkLocks([...prsBy.github, ...prsBy.bitbucket], prepared, started);
    const { tickets: skeleton, jiraKeys } = derive.ticketsFor(all, matchers);
    const keys = Object.keys(skeleton);
    const next = { ...tickets };
    for (const [k, v] of Object.entries(skeleton)) if (!next[k]) next[k] = v;
    if (Object.keys(sites).length === 0) markOk('jira', at);
    else {
      const jr = await callJira(jiraKeys, started);
      if (jr.error) markError('jira', jr.error);
      else {
        for (const [k, v] of Object.entries(jr.result?.tickets ?? {})) next[k] = { ...(skeleton[k] ?? next[k]), ...v };
        if (jr.result?.errors?.length) state.jira = { ok: false, error: jr.result.errors.join('; '), fetchedAt: at };
        else markOk('jira', at);
      }
    }
    tickets = next;

    const end = now();
    // enrich drops `description`: it only feeds the Ticket key and never reaches the snapshot.
    enriched = derive.enrich(all, { now: end, staleDays: settings.staleDays, behindWarn: settings.behindWarn, matchers });
    generatedAt = new Date(end).toISOString();

    const errs = SOURCES.filter((n) => state[n].error).map((n) => `${n}: ${state[n].error}`);
    log(
      `${stamp(end)} ${id} round github=${prsBy.github.length} bitbucket=${prsBy.bitbucket.length} ` +
        `tickets=${keys.length} ${end - started}ms rate=${rateRemaining() ?? '?'}` +
        (errs.length ? ` errors: ${errs.join(' | ')}` : ''),
    );
  }

  // Starts a round unless one is running (then returns that one). A project with an error never runs one.
  function refresh() {
    if (!project) return Promise.resolve();
    if (!inFlight) {
      inFlight = round()
        .catch((err) => plog(`round failed: ${shortError(err)}`))
        .finally(() => {
          inFlight = null;
          lastDoneAt = now();
        });
    }
    return inFlight;
  }

  function hosts() {
    const out = {};
    if (project?.hosts?.github) out.github = { owner: project.hosts.github.owner };
    if (project?.hosts?.bitbucket) out.bitbucket = { workspace: project.hosts.bitbucket.workspace };
    return out;
  }

  function snapshot({ rate = null } = {}) {
    return {
      project: { id, title: entry.title ?? id, hosts: hosts(), error: projectError, warnings: [...configWarnings, ...roundWarnings] },
      generatedAt,
      refreshing: inFlight !== null,
      rate,
      intervalSec: settings.intervalSec,
      sources: Object.fromEntries(SOURCES.map((n) => [n, { ...state[n] }])),
      prs: enriched,
      tickets,
      repos: allRepos().map(({ host, repo, repoShort, repoUrl }) => ({ host, repo, repoShort, repoUrl })),
      fix: { sharedPackages, fixPrompts: { ...(project?.fixPrompts ?? {}) }, fixNotes: { ...(settings.fixNotes ?? {}) } },
      rateLimit: { github: rateRemaining() },
    };
  }

  return {
    id,
    ok: project !== null,
    refresh,
    busy: () => inFlight !== null,
    lastDoneAt: () => lastDoneAt,
    needsFollowUp: () => enriched.some((p) => !p.draft && p.mergeable === 'unknown'),
    snapshot,
  };
}
