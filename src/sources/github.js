// GitHub: list PRs plus per-PR detail, CI, behind, normalized to PRs; and the lock reader of the shared package check.
import { mapLimit } from '../limit.js';
import { isMainBranch } from '../derive.js';

const API = 'https://api.github.com';
const HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const PR_CONCURRENCY = 6;
const REPO_CONCURRENCY = 3;

const CLEAN_STATES = new Set(['clean', 'unstable', 'blocked', 'behind', 'has_hooks']);
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure']);
const RUNNING_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

// The token owner's login, for "mine". GET only, same auth and headers as the PR calls.
export async function githubViewer({ http, auth }) {
  const body = await http.get(`${API}/user`, { auth, headers: HEADERS });
  if (!body?.login) throw new Error('GitHub /user returned no login');
  return body.login;
}

export function mapMergeable(detail) {
  if (detail?.mergeable == null) return 'unknown';
  if (detail.mergeable_state === 'dirty') return 'conflict';
  return CLEAN_STATES.has(detail.mergeable_state) ? 'clean' : 'unknown';
}

// Latest run per workflow (by created_at), then: failed > running > ok; no runs -> none.
export function aggregateRuns(runs, headSha) {
  const latest = new Map();
  for (const run of runs) {
    if (run.head_sha !== headSha) continue;
    const prev = latest.get(run.workflow_id);
    if (!prev || run.created_at > prev.created_at) latest.set(run.workflow_id, run);
  }
  const picked = [...latest.values()];
  if (picked.length === 0) return 'none';
  if (picked.some((r) => FAILED_CONCLUSIONS.has(r.conclusion))) return 'failed';
  if (picked.some((r) => RUNNING_STATUSES.has(r.status))) return 'running';
  return 'ok';
}

// Prefer the open PR, then the newest merged, then the newest closed.
export function pickBasePr(list) {
  const newest = (prs) => [...prs].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
  const open = list.find((p) => p.state === 'open');
  const pr = open ?? newest(list.filter((p) => p.merged_at)) ?? newest(list);
  if (!pr) return null;
  const state = pr.state === 'open' ? 'open' : pr.merged_at ? 'merged' : 'closed';
  return { number: pr.number, state, url: pr.html_url };
}

const RAW_HEADERS = { ...HEADERS, Accept: 'application/vnd.github.raw+json' };

/**
 * The GitHub reads of the shared package check (SPEC "Shared package check"), for `src/sharedPackages.js`.
 * `owner` is the project's GitHub owner; `auth` is `() => Promise<string>`, asked once per reader on its
 * first read and never logged. Every read is a GET through `http` and rejects on failure (the caller
 * reports it). Shas are full 40-character shas.
 */
export function githubLockReader({ http, owner, auth }) {
  let authValue;
  const opts = async (headers = HEADERS) => ({ auth: await (authValue ??= auth()), headers });
  const get = async (path, headers) => http.get(`${API}/repos/${owner}/${path}`, await opts(headers));
  const enc = encodeURIComponent;

  return {
    // A JSON file at a commit, through the contents API in raw form.
    readJson: (repo, sha, path) => get(`${repo}/contents/${path}?ref=${enc(sha)}`, RAW_HEADERS),

    branchHead: async (repo, branch) => (await get(`${repo}/branches/${enc(branch)}`)).commit.sha,

    // Closed PRs (one page, most recently updated first) merged at or after `since` (ms) with a merge sha.
    async mergedPrs(repo, since) {
      const list = await get(`${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`);
      return list
        .filter((p) => p.merged_at && Date.parse(p.merged_at) >= since && p.merge_commit_sha)
        .map((p) => ({
          number: p.number,
          url: p.html_url,
          title: p.title,
          source: p.head?.ref ?? null,
          description: p.body || null,
          mergeSha: p.merge_commit_sha,
        }));
    },

    // The commits on `head` that `lockRef` lacks.
    commitsLacking: async (repo, lockRef, head) =>
      ((await get(`${repo}/compare/${lockRef}...${head}`)).commits ?? []).map((c) => c.sha),

    prBySourceBranch: async (repo, branch) =>
      pickBasePr(await get(`${repo}/pulls?state=all&head=${enc(`${owner}:${branch}`)}&per_page=20`)),
  };
}

function shortError(err) {
  const status = err?.status ? `${err.status} ` : '';
  const text = String(err?.body || err?.message || err).replace(/\s+/g, ' ').trim();
  return `${status}${text}`.slice(0, 160);
}

/**
 * Collect open PRs for the given GitHub repos, normalized per SPEC "Normalized PR".
 *
 * `project.hosts.github.owner` is the owner; `repos` is this host's repo set from `repoSet`
 * (`{ host, repo, repoShort, repoUrl, defaultBranch }`). `auth` is `() => Promise<string>` (the
 * Authorization value), passed through to http and never logged. `me` is the viewer's login (null:
 * no PR is mine). Read-only: every call is `http.get` / `http.getAll` (GET). `cache` is a Map kept by
 * the caller across rounds (keys prefixed `gh:`): CI per head sha (only 'ok' is reused; failed/none/
 * running are re-fetched, cheap via ETag) and compare results per sha pair.
 *
 * Errors:
 * - A per-PR detail failure (mergeable, CI, branch, compare, base-PR lookup) never fails the repo:
 *   that field becomes 'unknown' / null (basePr: key omitted) and one line goes to `log`.
 * - A repo whose PR list fails is skipped; the other repos are still returned as
 *   `{ prs, errors: ['<repo>: 403 ...'] }`. `errors` is only present when a repo list failed.
 * - When every GitHub repo list fails, the function throws (the collector records a source error).
 *
 * @returns {Promise<{ prs: object[], errors?: string[] }>}
 */
export async function collectGithub({ project, repos = [], http, auth, cache, log = () => {}, me = null }) {
  if (repos.length === 0) return { prs: [] };
  const owner = project.hosts.github.owner;
  const opts = { auth: await auth(), headers: HEADERS };
  const get = (path) => http.get(API + path, opts);

  const results = await mapLimit(repos, REPO_CONCURRENCY, async (repoCfg) => {
    try {
      return { prs: await collectRepo(repoCfg) };
    } catch (err) {
      return { error: `${repoCfg.repo}: ${shortError(err)}` };
    }
  });

  const prs = results.flatMap((r) => r.prs ?? []);
  const errors = results.filter((r) => r.error).map((r) => r.error);
  if (errors.length === repos.length) throw new Error(`GitHub: every repo failed (${errors.join('; ')})`);
  return errors.length ? { prs, errors } : { prs };

  async function collectRepo(repoCfg) {
    const { repo, defaultBranch = null } = repoCfg;
    const base = `/repos/${owner}/${repo}`;
    const list = await http.getAll(`${API}${base}/pulls?state=open&per_page=100`, opts);
    const branchHeads = new Map(); // target -> Promise<sha>, memoized within this round

    // Run one detail lookup; on failure log a line and return the fallback.
    async function detail(pr, what, fallback, fn) {
      try {
        return await fn();
      } catch (err) {
        log(`github ${repo}#${pr.number} ${what} failed: ${shortError(err)}`);
        return fallback;
      }
    }

    function branchHead(target) {
      if (!branchHeads.has(target)) {
        branchHeads.set(target, get(`${base}/branches/${encodeURIComponent(target)}`).then((b) => b.commit.sha));
      }
      return branchHeads.get(target);
    }

    async function ci(headSha) {
      const key = `gh:ci:${repo}:${headSha}`;
      // Only 'ok' is final: failed runs can be re-run on the same sha, and 'none' may just be too early.
      if (cache.get(key) === 'ok') return 'ok';
      const body = await get(`${base}/actions/runs?head_sha=${headSha}&per_page=50`);
      const value = aggregateRuns(body.workflow_runs ?? [], headSha);
      cache.set(key, value);
      return value;
    }

    async function behind(target, headSha) {
      const baseHead = await branchHead(target);
      const key = `gh:cmp:${repo}:${baseHead}:${headSha}`;
      if (cache.has(key)) return cache.get(key);
      const body = await get(`${base}/compare/${baseHead}...${headSha}`);
      const value = typeof body.behind_by === 'number' ? body.behind_by : null;
      if (value !== null) cache.set(key, value);
      return value;
    }

    return mapLimit(list, PR_CONCURRENCY, async (pr) => {
      const headSha = pr.head.sha;
      const source = pr.head.ref;
      const target = pr.base.ref;
      const stacked = !isMainBranch(target, defaultBranch);

      const [mergeable, ciState, behindBy, basePr] = await Promise.all([
        detail(pr, 'mergeable', 'unknown', async () => mapMergeable(await get(`${base}/pulls/${pr.number}`))),
        detail(pr, 'ci', 'unknown', () => ci(headSha)),
        detail(pr, 'behind', null, () => behind(target, headSha)),
        stacked
          ? detail(pr, 'base pr', undefined, async () =>
            pickBasePr(await get(`${base}/pulls?state=all&head=${encodeURIComponent(`${owner}:${target}`)}&per_page=20`)))
          : undefined,
      ]);

      const out = {
        id: `github:${repo}#${pr.number}`,
        host: 'github',
        owner,
        repo,
        repoShort: repoCfg.repoShort,
        repoUrl: repoCfg.repoUrl,
        defaultBranch,
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        description: pr.body || null,
        author: { name: pr.user?.login ?? null, id: pr.user?.login ?? null },
        mine: me != null && pr.user?.login === me,
        source,
        target,
        headSha,
        draft: Boolean(pr.draft),
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        ci: ciState,
        mergeable,
        behindBy,
      };
      if (stacked && basePr !== undefined) out.basePr = basePr; // undefined = lookup failed
      out.locks = []; // src/sharedPackages.js fills it
      return out;
    });
  }
}
