// Bitbucket: list PRs plus conflicts, CI, behind, normalized to PRs; and the lock reader of the shared package check.
// Read-only: every call is http.get / http.getAll (GET only). Never log the auth value.
import { mapLimit } from '../limit.js';
import { isMainBranch } from '../derive.js';

const API = 'https://api.bitbucket.org/2.0/repositories';
const HTML = 'https://bitbucket.org';
const CONCURRENCY = 4;
// Bitbucket's diffstat statuses for an unresolved merge: content conflict and delete/modify conflicts.
const CONFLICT_STATUSES = new Set(['merge conflict', 'local deleted', 'remote deleted']);
const PR_FIELDS = [
  'id', 'title', 'state', 'draft', 'author.display_name', 'author.uuid', 'created_on', 'updated_on',
  'source.branch.name', 'source.commit.hash', 'destination.branch.name', 'links.html.href', 'merge_commit.hash',
].map((f) => `values.${f}`).concat('next').join(',');
// The open-PR list also carries the description (link matchers need it); summary.raw is the fallback.
const LIST_FIELDS = PR_FIELDS.replace(/,next$/, ',values.description,values.summary.raw,next');
// q= ignores the state= params (and the default OPEN filter); these stay for clarity and are harmless.
const ANY_STATE = 'state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED';
const STATE_MAP = { OPEN: 'open', MERGED: 'merged', DECLINED: 'declined', SUPERSEDED: 'declined' };

const enc = encodeURIComponent;
const errText = (err) => String(err?.message ?? err);

// Statuses → ci: any FAILED/STOPPED → failed; else any INPROGRESS → running; else ≥1 SUCCESSFUL → ok; none → none.
function ciFromStatuses(statuses) {
  const states = new Set(statuses.map((s) => s.state));
  if (states.has('FAILED') || states.has('STOPPED')) return 'failed';
  if (states.has('INPROGRESS')) return 'running';
  if (states.has('SUCCESSFUL')) return 'ok';
  return 'none';
}

// Prefer open; else newest merged; else newest declined/superseded. Empty → null.
function pickPr(values) {
  const newest = (state) => values
    .filter((v) => STATE_MAP[v.state] === state)
    .sort((a, b) => Date.parse(b.updated_on ?? 0) - Date.parse(a.updated_on ?? 0))[0];
  const pr = newest('open') ?? newest('merged') ?? newest('declined');
  return pr ? { number: pr.id, state: STATE_MAP[pr.state], url: pr.links?.html?.href } : null;
}

/**
 * The Bitbucket reads of the shared package check (SPEC "Shared package check"), for `src/sharedPackages.js`.
 * `owner` is the project's workspace; `auth` is `() => Promise<string>`, asked once per reader on its first
 * read and never logged. Every read is a GET through `http` and rejects on failure (the caller reports it).
 * Merge shas are the 12-character hashes the PR list gives.
 */
export function bitbucketLockReader({ http, owner, auth }) {
  let authValue;
  const get = async (url) => http.get(url, { auth: await (authValue ??= auth()) });
  const getAll = async (url) => http.getAll(url, { auth: await (authValue ??= auth()) });
  const base = (repo) => `${API}/${owner}/${repo}`;

  return {
    readJson: (repo, sha, path) => get(`${base(repo)}/src/${sha}/${path}`),

    branchHead: async (repo, branch) => (await get(`${base(repo)}/refs/branches/${enc(branch)}?fields=target.hash`)).target.hash,

    // PRs merged at or after `since` (ms). Bitbucket has no merge date, so `updated_on` stands in for it.
    async mergedPrs(repo, since) {
      const q = enc(`state="MERGED" AND updated_on > ${new Date(since).toISOString()}`);
      const values = await getAll(`${base(repo)}/pullrequests?q=${q}&pagelen=50&fields=${PR_FIELDS}`);
      return values
        .filter((v) => v.state === 'MERGED' && Date.parse(v.updated_on) >= since && v.merge_commit?.hash)
        .map((v) => ({
          number: v.id,
          url: v.links?.html?.href ?? null,
          title: v.title ?? null,
          source: v.source?.branch?.name ?? null,
          description: null,
          mergeSha: v.merge_commit.hash,
        }));
    },

    // The commits on `head` that `lockRef` lacks (first page of 100).
    commitsLacking: async (repo, lockRef, head) =>
      ((await get(`${base(repo)}/commits?include=${head}&exclude=${lockRef}&pagelen=100&fields=values.hash`)).values ?? []).map((c) => c.hash),

    async prBySourceBranch(repo, branch) {
      const q = enc(`source.branch.name="${branch}"`);
      return pickPr((await get(`${base(repo)}/pullrequests?q=${q}&${ANY_STATE}&pagelen=20&fields=${PR_FIELDS}`)).values ?? []);
    },
  };
}

// The token owner's account uuid, for "mine". GET only.
export async function bitbucketViewer({ http, auth }) {
  const body = await http.get('https://api.bitbucket.org/2.0/user?fields=uuid', { auth });
  if (!body?.uuid) throw new Error('Bitbucket /user returned no uuid');
  return body.uuid;
}

/**
 * Collect open PRs for the given Bitbucket repos, normalized per SPEC "Normalized PR".
 * `project.hosts.bitbucket.workspace` is the workspace; `repos` is this host's repo set from `repoSet`.
 * `auth` is `() => Promise<string>`, never logged. `locks` is always [] here: `src/sharedPackages.js` fills it.
 * @returns {Promise<{ prs: object[], errors?: string[] }>}
 */
export async function collectBitbucket({ project, repos = [], http, auth, cache, log = () => {}, me = null }) {
  if (repos.length === 0) return { prs: [] };
  const ws = project.hosts.bitbucket.workspace;
  const repoBase = (repo) => `${API}/${ws}/${repo}`;
  const opts = { auth: await auth() };

  // Round-local memo of in-flight promises, so concurrent PRs share one request.
  const memo = new Map();
  const once = (key, fn) => {
    if (!memo.has(key)) memo.set(key, fn());
    return memo.get(key);
  };

  // Cross-round cache of settled values; failures are never cached.
  async function cached(key, fn, keep = () => true) {
    if (cache.has(key)) return cache.get(key);
    const value = await fn();
    if (keep(value)) cache.set(key, value);
    return value;
  }

  // Each detail runs isolated: a failure becomes `fallback` plus one log line (URL only, never auth).
  async function detail(what, fn, fallback) {
    try {
      return await fn();
    } catch (err) {
      log(`bitbucket ${what}: ${errText(err)}`);
      return fallback;
    }
  }

  const branchHead = (repo, branch) => once(`head:${repo}:${branch}`, async () =>
    (await http.get(`${repoBase(repo)}/refs/branches/${enc(branch)}?fields=target.hash`, opts)).target.hash);

  const prsBySourceBranch = (repo, branch) => once(`bysrc:${repo}:${branch}`, async () => {
    const q = enc(`source.branch.name="${branch}"`);
    const body = await http.get(`${repoBase(repo)}/pullrequests?q=${q}&${ANY_STATE}&pagelen=20&fields=${PR_FIELDS}`, opts);
    return pickPr(body.values ?? []);
  });

  // The list gives a 12-char hash; resolve the full one once (immutable, cached across rounds).
  const fullSha = (repo, short) => cached(`bb:sha:${repo}:${short}`, async () =>
    (await http.get(`${repoBase(repo)}/commit/${short}?fields=hash`, opts)).hash);

  const commitsBetween = async (repo, include, exclude) =>
    (await http.get(`${repoBase(repo)}/commits?include=${include}&exclude=${exclude}&pagelen=100&fields=values.hash`, opts)).values ?? [];

  async function enrich(r, raw) {
    const repo = r.repo;
    const B = repoBase(repo);
    const tag = `${repo}#${raw.id}`;
    const shortSha = raw.source?.commit?.hash ?? null;
    const target = raw.destination?.branch?.name ?? null;
    const defaultBranch = r.defaultBranch ?? null;

    const pr = {
      id: `bitbucket:${repo}#${raw.id}`,
      host: 'bitbucket',
      owner: ws,
      repo,
      repoShort: r.repoShort,
      repoUrl: r.repoUrl,
      defaultBranch,
      number: raw.id,
      title: raw.title,
      url: raw.links?.html?.href ?? `${HTML}/${ws}/${repo}/pull-requests/${raw.id}`,
      description: raw.description || raw.summary?.raw || null,
      author: { name: raw.author?.display_name ?? null, id: raw.author?.uuid ?? null },
      mine: me != null && raw.author?.uuid === me,
      source: raw.source?.branch?.name ?? null,
      target,
      headSha: shortSha,
      draft: raw.draft ?? false,
      createdAt: raw.created_on,
      updatedAt: raw.updated_on,
      ci: 'unknown',
      mergeable: 'unknown',
      behindBy: null,
    };

    // Fall back to the short hash: the commit, statuses, src and commits endpoints accept it.
    if (shortSha) pr.headSha = await detail(`${tag} head sha`, () => fullSha(repo, shortSha), shortSha);
    const headSha = pr.headSha;
    const targetHead = target ? await detail(`${tag} target head`, () => branchHead(repo, target), null) : null;

    const [ci, mergeable, behindBy, basePr] = await Promise.all([
      headSha ? detail(`${tag} CI`, () => cached(`bb:ci:${repo}:${headSha}`, async () =>
        ciFromStatuses(await http.getAll(`${B}/commit/${headSha}/statuses?pagelen=100&fields=values.state,values.key,next`, opts)),
      (v) => v === 'ok'), 'unknown') : 'unknown',
      detail(`${tag} conflicts`, async () => {
        const fetch = async () => {
          const entries = await http.getAll(`${B}/pullrequests/${raw.id}/diffstat?pagelen=500&fields=values.status,next`, opts);
          return entries.some((e) => CONFLICT_STATUSES.has(e.status)) ? 'conflict' : 'clean';
        };
        return headSha && targetHead ? cached(`bb:cf:${repo}:${raw.id}:${headSha}:${targetHead}`, fetch) : fetch();
      }, 'unknown'),
      headSha && targetHead ? detail(`${tag} behind`, () => cached(`bb:bh:${repo}:${targetHead}:${headSha}`, async () =>
        (await commitsBetween(repo, targetHead, headSha)).length), null) : null,
      target && !isMainBranch(target, defaultBranch) ? detail(`${tag} base PR`, () => prsBySourceBranch(repo, target), undefined) : undefined,
    ]);

    Object.assign(pr, { ci, mergeable, behindBy });
    if (basePr !== undefined) pr.basePr = basePr;
    pr.locks = [];
    return pr;
  }

  // Lists in parallel (one request per repo), then details with at most CONCURRENCY PRs in flight overall.
  const errors = [];
  const lists = await Promise.all(repos.map(async (r) => {
    try {
      const list = await http.getAll(`${repoBase(r.repo)}/pullrequests?state=OPEN&pagelen=50&fields=${LIST_FIELDS}`, opts);
      return list.map((raw) => [r, raw]);
    } catch (err) {
      errors.push(`${r.repoShort}: ${errText(err)}`);
      return [];
    }
  }));
  const prs = await mapLimit(lists.flat(), CONCURRENCY, ([r, raw]) => enrich(r, raw));
  return errors.length ? { prs, errors } : { prs };
}
