// Jira: Ticket key to {status, summary, url}. GET only via http.get; never logs auth.
// Status comes through the Atlassian gateway per site; links only from the project's `browse` templates.
import { mapLimit } from '../limit.js';

const TTL_MS = 10 * 60 * 1000;
const CONCURRENCY = 5;

const code = (s) => `\`${s}\``;
const prefixOf = (key) => String(key).replace(/-\d+$/, '').toUpperCase();

/**
 * The Jira sites of a project: `{ [site]: { cloudId, browse: { [PREFIX]: template | null } } }`,
 * with the browse template of every prefix matcher that names the site.
 */
export function jiraSites(project) {
  const sites = {};
  for (const [name, site] of Object.entries(project?.jira ?? {})) sites[name] = { cloudId: site.cloudId, browse: {} };
  for (const m of project?.tickets ?? []) {
    if (typeof m?.prefix === 'string' && typeof m.jira === 'string' && sites[m.jira]) {
      sites[m.jira].browse[m.prefix.toUpperCase()] = m.browse ?? null;
    }
  }
  return sites;
}

/**
 * `keysBySite` is `{ [site]: [key] }`; `sites` comes from `jiraSites(project)`. `auth` is
 * `() => Promise<string>`, only called when there is a key to fetch.
 * → { tickets: { [key]: { status, summary, url } }, errors?: [string] }. A 404 is `{ status: null }`, not an error.
 */
export async function collectJira(keysBySite, { sites = {}, http, auth, cache, now, log = () => {} }) {
  const tickets = {};
  const errors = [];
  const fail = (msg) => {
    log(msg);
    errors.push(msg);
  };

  const jobs = [];
  const seen = new Set();
  for (const [siteName, keys] of Object.entries(keysBySite ?? {})) {
    const site = sites[siteName];
    for (const key of keys ?? []) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (!site) fail(`jira ${key}: no Jira site ${code(siteName)}`);
      else jobs.push({ key, site });
    }
  }
  if (jobs.length === 0) return errors.length ? { tickets, errors } : { tickets };

  const opts = { auth: await auth(), headers: { Accept: 'application/json' } };
  await mapLimit(jobs, CONCURRENCY, async ({ key, site }) => {
    const template = site.browse?.[prefixOf(key)];
    const url = typeof template === 'string' ? template.replaceAll('{key}', key) : null;
    const cacheKey = `jira:${site.cloudId}:${key}`;
    const cached = cache.get(cacheKey);
    if (cached && now - cached.at < TTL_MS) {
      tickets[key] = cached.value;
      return;
    }
    const base = `https://api.atlassian.com/ex/jira/${site.cloudId}/rest/api/3/issue/`;
    try {
      const body = await http.get(`${base}${encodeURIComponent(key)}?fields=status,summary`, opts);
      const value = { status: body?.fields?.status?.name ?? null, summary: body?.fields?.summary ?? null, url };
      cache.set(cacheKey, { value, at: now });
      tickets[key] = value;
    } catch (err) {
      if (err?.status === 404) {
        const value = { status: null, summary: null, url };
        cache.set(cacheKey, { value, at: now });
        tickets[key] = value;
        return;
      }
      if (cached) tickets[key] = cached.value;
      fail(`jira ${key}: ${err?.status ? `HTTP ${err.status}` : 'request failed'}`);
    }
  });

  return errors.length ? { tickets, errors } : { tickets };
}
