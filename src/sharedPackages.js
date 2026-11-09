// Shared package check (SPEC "Shared package check"): per open PR in a consumer repo, the lock entry of
// every shared package it consumes. Host-agnostic: the reads go through one small reader per host
// (`githubLockReader`, `bitbucketLockReader`), each on its own repo's host and credential.
// Read-only: the readers only GET through `http`. Never logs an auth value.
import { mapLimit } from './limit.js';
import { ticketKey, lockPin } from './derive.js';
import { resolveRepoRef } from './discover.js';
import { githubLockReader } from './sources/github.js';
import { bitbucketLockReader } from './sources/bitbucket.js';

const DAY = 86_400_000;
export const MERGED_WINDOW_DAYS = 30;
const CONCURRENCY = 4;
const MAX_CACHE_ENTRIES = 2000;
const HOSTS = ['github', 'bitbucket'];

const errText = (err) => String(err?.message ?? err);
const ownerOf = (project, host) => (host === 'github' ? project?.hosts?.github?.owner : project?.hosts?.bitbucket?.workspace) ?? null;
const repoKey = (host, repo) => `${host}:${repo}`;
// A Bitbucket list gives 12-character merge hashes; the commit lists give full ones.
const sameSha = (a, b) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

// `require[P]` from composer.json; P's `source.reference` from composer.lock (packages or packages-dev).
const requireOf = (json) => (json && typeof json.require === 'object' && json.require) || {};
function refsOf(lock) {
  const refs = {};
  for (const p of [...(lock?.packages ?? []), ...(lock?.['packages-dev'] ?? [])]) {
    if (p?.name && !Object.hasOwn(refs, p.name)) refs[p.name] = p.source?.reference ?? null;
  }
  return refs;
}

function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_CACHE_ENTRIES) map.delete(map.keys().next().value);
}

/**
 * `createSharedPackageCheck({ http, readers? })` → `lockCheck(prs, { project, repos, auth, now, matchers, log })`
 * → `Promise<prs>`: new PR objects, each with `locks` (SPEC "Normalized PR"; `[]` for non-consumers).
 *
 * - `repos`: every repo of the project across hosts, `{ host, repo, repoShort, repoUrl, defaultBranch }`.
 *   `sharedPackages` references (`name` or `host:name`) resolve against them.
 * - `auth`: `{ github?, bitbucket? }`, each `() => Promise<string>`, asked only when that host is read.
 * - `prs` are raw PRs (with `description`), so the Ticket key is the one `enrich` will derive.
 * - `readers`: `{ github, bitbucket }` factories `({ http, owner, auth }) → reader` (see the sources).
 *
 * Caches live in the closure: composer files by (host, repo, headSha), only when both reads worked; the
 * commits a lock ref lacks by (shared repo, head, lock ref). Merged PRs, branch heads and pinned PR
 * lookups are read once per call. A failed read is one log line and a null (pinned lookup: undefined).
 */
export function createSharedPackageCheck({ http, readers = { github: githubLockReader, bitbucket: bitbucketLockReader } } = {}) {
  const files = new Map();
  const lacking = new Map();
  const warned = new Set();

  return async function lockCheck(prs, { project, repos = [], auth = {}, now, matchers = [], log = () => {} } = {}) {
    const warnOnce = (text) => {
      if (warned.has(text)) return;
      warned.add(text);
      log(text);
    };
    const entries = resolveEntries(project, repos, warnOnce);
    const consumed = (pr) => entries.filter((e) => e.consumers.has(repoKey(pr.host, pr.repo)));
    if (!prs.some((pr) => consumed(pr).length > 0)) return prs.map((pr) => ({ ...pr, locks: [] }));

    // One reader per host per call; its auth is asked on its first read.
    const hostReaders = new Map();
    const readerFor = (host) => {
      if (!hostReaders.has(host)) {
        const hostAuth = auth[host] ?? (async () => { throw new Error(`no ${host} credential`); });
        hostReaders.set(host, readers[host]({ http, owner: ownerOf(project, host), auth: hostAuth }));
      }
      return hostReaders.get(host);
    };

    // Call-local memo of in-flight promises, so concurrent PRs share one request.
    const memo = new Map();
    const once = (key, fn) => {
      if (!memo.has(key)) memo.set(key, fn());
      return memo.get(key);
    };

    // The window start is truncated to the UTC day, so a host's query is the same all day.
    const since = Math.floor((now - MERGED_WINDOW_DAYS * DAY) / DAY) * DAY;

    // { require, refs } of a consumer at a sha; a failed file is undefined there, and nothing is cached.
    const composerAt = (pr) => {
      const key = `${repoKey(pr.host, pr.repo)}@${pr.headSha}`;
      if (files.has(key)) return files.get(key);
      return once(`files:${key}`, async () => {
        const reader = readerFor(pr.host);
        const read = (path, pick) => reader.readJson(pr.repo, pr.headSha, path).then(pick, (err) => {
          log(`locks ${pr.repoShort}#${pr.number} ${path}: ${errText(err)}`);
          return undefined;
        });
        const [require, refs] = await Promise.all([read('composer.json', requireOf), read('composer.lock', refsOf)]);
        const value = { require, refs };
        if (require !== undefined && refs !== undefined) remember(files, key, value);
        return value;
      });
    };

    const mergedPrs = (shared) => once(`merged:${repoKey(shared.host, shared.repo)}`, () => readerFor(shared.host).mergedPrs(shared.repo, since));
    const branchHead = (shared) => once(`head:${repoKey(shared.host, shared.repo)}`, () => readerFor(shared.host).branchHead(shared.repo, shared.defaultBranch));
    const prFrom = (shared, branch) => once(`pr:${repoKey(shared.host, shared.repo)}:${branch}`, () => readerFor(shared.host).prBySourceBranch(shared.repo, branch));
    const commitsLacking = async (shared, lockRef) => {
      const head = await branchHead(shared);
      const key = `${repoKey(shared.host, shared.repo)}:${head}...${lockRef}`;
      if (lacking.has(key)) return lacking.get(key);
      return once(`lacking:${key}`, async () => {
        const shas = await readerFor(shared.host).commitsLacking(shared.repo, lockRef, head);
        remember(lacking, key, shas);
        return shas;
      });
    };

    async function detail(pr, what, fallback, fn) {
      try {
        return await fn();
      } catch (err) {
        log(`locks ${pr.repoShort}#${pr.number} ${what}: ${errText(err)}`);
        return fallback;
      }
    }

    async function lockInfo(pr, entry) {
      const { shared } = entry;
      const lock = {
        package: entry.package,
        sharedRepo: { host: shared.host, repo: shared.repo, repoShort: shared.repoShort, defaultBranch: shared.defaultBranch },
        constraint: null,
        lockRef: null,
        pinnedPr: null,
        missingPrs: [],
      };
      if (!pr.headSha) return lock;

      const { require, refs } = await composerAt(pr);
      lock.constraint = require?.[entry.package] ?? null;
      lock.lockRef = refs?.[entry.package] ?? null;

      // Pinned: dev-<branch> where <branch> isn't the shared default. undefined = the lookup failed.
      const branch = lockPin(lock.constraint, shared.defaultBranch);
      if (branch) lock.pinnedPr = await detail(pr, `pinned ${shared.repoShort} PR`, undefined, () => prFrom(shared, branch));

      // Missing: shared PRs merged in the window with the same Ticket key, whose merge the lock ref lacks.
      const key = ticketKey(pr, matchers)?.key ?? null;
      if (key && lock.lockRef) {
        lock.missingPrs = await detail(pr, `missing ${shared.repoShort} PRs`, [], async () => {
          const sameKey = (await mergedPrs(shared))
            .filter((m) => m.mergeSha && ticketKey({ source: m.source, title: m.title, description: m.description }, matchers)?.key === key);
          if (sameKey.length === 0) return [];
          if (!shared.defaultBranch) {
            warnOnce(`locks: the default branch of ${shared.repo} is unknown, so missing ${shared.repoShort} PRs aren't checked`);
            return [];
          }
          const shas = await commitsLacking(shared, lock.lockRef);
          return sameKey
            .filter((m) => shas.some((sha) => sameSha(sha, m.mergeSha)))
            .map((m) => ({ number: m.number, url: m.url }));
        });
      }
      return lock;
    }

    return mapLimit(prs, CONCURRENCY, async (pr) => {
      const locks = [];
      for (const entry of consumed(pr)) locks.push(await lockInfo(pr, entry));
      return { ...pr, locks };
    });
  };
}

// The project's composer `sharedPackages`, resolved against `repos`: [{ package, shared, consumers: Set }].
// An unknown or ambiguous reference skips its entry (shared repo) or that consumer, with one warning.
function resolveEntries(project, repos, warn) {
  const names = {};
  for (const host of HOSTS) names[host] = repos.filter((r) => r.host === host).map((r) => r.repo);
  const resolve = (ref) => {
    const hit = resolveRepoRef(ref, names);
    if (hit?.ambiguous) warn(`locks: \`${ref}\` is a repo on both hosts: write \`github:${hit.repo}\` or \`bitbucket:${hit.repo}\``);
    else if (!hit) warn(`locks: \`${ref}\` is not a repo of this project, or the token can't see it`);
    return hit && !hit.ambiguous ? repos.find((r) => r.host === hit.host && r.repo === hit.repo) : null;
  };

  const out = [];
  for (const entry of project?.sharedPackages ?? []) {
    if (entry?.kind !== 'composer' || !entry.package) continue;
    const shared = resolve(entry.repo);
    if (!shared) continue;
    const consumers = new Set();
    for (const ref of entry.consumers ?? []) {
      const r = resolve(ref);
      if (r) consumers.add(repoKey(r.host, r.repo));
    }
    out.push({ package: entry.package, shared, consumers });
  }
  return out;
}
