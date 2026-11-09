// Repos per project and host (SPEC "Repos"): discovery, the whitelist, aliases and the Bitbucket cap.
// Read-only: discovery goes through http.getAll (GET only). `auth` is `() => Promise<string>`, never logged.

const GITHUB_API = 'https://api.github.com';
const GITHUB_HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const BITBUCKET_API = 'https://api.bitbucket.org/2.0/repositories';
const BITBUCKET_FIELDS = 'values.slug,values.parent.full_name,values.updated_on,values.mainbranch.name,next';
const HOSTS = ['github', 'bitbucket'];

export const BITBUCKET_CAP = 40;
export const DISCOVERY_TTL_MS = 60 * 60 * 1000;

const enc = encodeURIComponent;
const code = (s) => `\`${s}\``;
const lower = (s) => String(s).toLowerCase();

/**
 * GitHub repos of an org → [{ name, defaultBranch }], no forks, archived or disabled.
 * On a 404 the owner is a user: the token's own repos (`/user/repos`, private ones too) that this owner
 * owns, else (the token is someone else's) the user's public repos.
 */
export async function discoverGithub({ http, auth, owner }) {
  const opts = { auth: await auth(), headers: GITHUB_HEADERS };
  let list;
  try {
    list = await http.getAll(`${GITHUB_API}/orgs/${enc(owner)}/repos?type=sources&per_page=100`, opts);
  } catch (err) {
    if (err?.status !== 404) throw err;
    // A token without user context (or any failure here) falls back to the public listing below.
    const own = await http.getAll(`${GITHUB_API}/user/repos?affiliation=owner&per_page=100`, opts).catch(() => []);
    list = own.filter((r) => lower(r.owner?.login ?? '') === lower(owner));
    if (!list.length) list = await http.getAll(`${GITHUB_API}/users/${enc(owner)}/repos?type=owner&per_page=100`, opts);
  }
  return list
    .filter((r) => !r.fork && !r.archived && !r.disabled)
    .map((r) => ({ name: r.name, defaultBranch: r.default_branch ?? null }));
}

/** Bitbucket repos of a workspace → [{ name, defaultBranch }], most recently updated first, no forks. */
export async function discoverBitbucket({ http, auth, owner }) {
  const url = `${BITBUCKET_API}/${enc(owner)}?pagelen=100&sort=-updated_on&fields=${BITBUCKET_FIELDS}`;
  const list = await http.getAll(url, { auth: await auth() });
  return list
    .filter((r) => !r.parent)
    .map((r, i) => ({ r, i, t: Date.parse(r.updated_on) || 0 }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map(({ r }) => ({ name: r.slug, defaultBranch: r.mainbranch?.name ?? null }));
}

const ownerOf = (project, host) => (host === 'github' ? project?.hosts?.github?.owner : project?.hosts?.bitbucket?.workspace) ?? null;

function repoUrl(host, owner, repo) {
  return host === 'github' ? `https://github.com/${owner}/${repo}/pulls` : `https://bitbucket.org/${owner}/${repo}/pull-requests/`;
}

// The repo names a project has per host: its whitelist, else what discovery returned (when known).
function namesByHost(discovered, project) {
  const out = {};
  for (const host of HOSTS) {
    if (!ownerOf(project, host)) continue;
    const list = project.repos?.[host] ?? discovered?.[host]?.map((r) => r.name);
    if (list) out[host] = list;
  }
  return out;
}

/**
 * A repo reference (`name` or `host:name`) against the names per host.
 * → { host, repo } | { ambiguous: true, repo } (a plain name on both hosts) | null (no such repo).
 */
export function resolveRepoRef(ref, names) {
  const m = /^(github|bitbucket):(.+)$/.exec(String(ref));
  const hosts = m ? [m[1]] : HOSTS;
  const want = lower(m ? m[2] : ref);
  const hits = [];
  for (const host of hosts) {
    const repo = (names?.[host] ?? []).find((n) => lower(n) === want);
    if (repo !== undefined) hits.push({ host, repo });
  }
  if (hits.length > 1) return { ambiguous: true, repo: hits[0].repo };
  return hits[0] ?? null;
}

/**
 * The repo set of one project on one host (pure).
 * `discovered` is `{ github?, bitbucket? }`, each [{ name, defaultBranch }] or absent when discovery
 * is unknown (then the whitelist is used as is). → { repos: [{ host, repo, repoShort, repoUrl, defaultBranch }], warnings: [string] }
 */
export function repoSet(discovered, project, host) {
  const owner = ownerOf(project, host);
  if (!owner) return { repos: [], warnings: [] };
  const found = discovered?.[host] ?? null;
  const whitelist = project.repos?.[host] ?? null;
  const warnings = [];

  let picked;
  if (whitelist) {
    const byName = new Map((found ?? []).map((r) => [lower(r.name), r]));
    picked = [];
    for (const name of whitelist) {
      if (!found) picked.push({ name, defaultBranch: null });
      else if (byName.has(lower(name))) picked.push(byName.get(lower(name)));
      else warnings.push(`${code(name)} not found, or the token can't see it`);
    }
  } else {
    picked = found ?? [];
    if (host === 'bitbucket' && picked.length > BITBUCKET_CAP) {
      warnings.push(`Showing ${BITBUCKET_CAP} of ${picked.length} Bitbucket repos (rate limit). Add a repo list to choose which.`);
      picked = picked.slice(0, BITBUCKET_CAP);
    }
  }

  // Aliases: a duplicate value keeps the first in file order; a host:name key wins over a plain one;
  // a plain name on both hosts is ignored. Each ignored alias gives a warning.
  const names = namesByHost(discovered, project);
  const aliases = new Map();
  const plain = [];
  const used = new Set();
  const unique = [];
  for (const [ref, short] of Object.entries(project.aliases ?? {})) {
    if (used.has(short)) warnings.push(`The alias ${code(short)} is used more than once, so the alias of ${code(ref)} is ignored`);
    else unique.push([ref, short]);
    used.add(short);
  }
  for (const [ref, short] of unique) {
    if (/^(github|bitbucket):/.test(ref)) {
      const hit = resolveRepoRef(ref, names);
      if (hit?.host === host) aliases.set(lower(hit.repo), short);
    } else plain.push([ref, short]);
  }
  for (const [ref, short] of plain) {
    const hit = resolveRepoRef(ref, names);
    if (hit?.ambiguous) warnings.push(`${code(ref)} is a repo on both hosts, so its alias is ignored: write ${code(`github:${ref}`)} or ${code(`bitbucket:${ref}`)}`);
    else if (hit?.host === host && !aliases.has(lower(hit.repo))) aliases.set(lower(hit.repo), short);
  }

  const repos = picked.map(({ name, defaultBranch }) => ({
    host,
    repo: name,
    repoShort: aliases.get(lower(name)) ?? name,
    repoUrl: repoUrl(host, owner, name),
    defaultBranch: defaultBranch ?? null,
  }));
  return { repos, warnings };
}

/**
 * Discovery with a cache: at most once per `ttlMs` per host and owner (one instance per project).
 * A failed discovery keeps the last good list and is retried on the next call; with nothing cached it throws.
 */
export function createDiscovery({ http, discoverers = { github: discoverGithub, bitbucket: discoverBitbucket }, ttlMs = DISCOVERY_TTL_MS }) {
  const entries = new Map(); // `${host}:${owner}` -> { at, repos }

  async function repos(host, { owner, auth, now }) {
    const key = `${host}:${owner}`;
    const entry = entries.get(key);
    if (entry && now - entry.at < ttlMs) return entry.repos;
    try {
      const list = await discoverers[host]({ http, auth, owner });
      entries.set(key, { at: now, repos: list });
      return list;
    } catch (err) {
      if (entry) return entry.repos;
      throw err;
    }
  }

  return { repos };
}
