// Dev stub: the real server and board over two made-up projects, with stub sources, secrets and http.
// No network, no secrets, no OS tools. For checking the page in a browser:
//   PORT=7431 node scripts/dev-stub.js [--broken]
// `--broken` adds a third project with a config error. PRs are fixture-shaped (SPEC "Normalized PR").
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBoard } from '../src/board.js';
import { createServer } from '../src/server.js';
import { DEFAULT_SETTINGS } from '../src/config.js';

const HOUR = 3_600_000;
const DIR = '/dev-stub';

const ACME = JSON.parse(readFileSync(new URL('../projects/example.json', import.meta.url), 'utf8'));
const NOVA = {
  title: 'Nova Labs',
  hosts: { github: { owner: 'nova-labs' } },
  tickets: [{ prefix: 'NOVA', browse: 'https://tracker.example.com/browse/{key}' }],
};

const entry = (id, project, warnings = []) => ({
  id,
  title: project.title,
  file: `${DIR}/projects/${id}.json`,
  ok: true,
  error: null,
  warnings,
  project,
  credentials: {},
});

const BROKEN = {
  id: 'broken',
  title: 'broken',
  file: `${DIR}/projects/broken.json`,
  ok: false,
  error: { file: `${DIR}/projects/broken.json`, errors: [{ path: 'hosts', message: 'Missing required key `hosts`' }] },
  warnings: [],
  project: null,
  credentials: null,
};

// What discovery "finds" per owner.
const REPOS = {
  'acme-corp': [{ name: 'acme-api', defaultBranch: 'main' }, { name: 'acme-status', defaultBranch: 'main' }],
  acme: ['acme-shared', 'acme-backend', 'acme-worker', 'acme-web'].map((name) => ({ name, defaultBranch: 'develop' })),
  'nova-labs': [{ name: 'nova-app', defaultBranch: 'main' }, { name: 'nova-docs', defaultBranch: 'main' }],
};

const ADA = { name: 'Ada Example', id: 'ada' };
const GRACE = { name: 'Grace Example', id: 'grace' };
const LINUS = { name: 'Linus Example', id: 'linus' };
const BOT = { name: 'dependabot', id: 'dependabot' };

const LOCK_MISSING = {
  package: 'acme/shared',
  sharedRepo: { host: 'bitbucket', repo: 'acme-shared', repoShort: 'shared', defaultBranch: 'develop' },
  constraint: 'dev-develop',
  lockRef: '1111111111111111111111111111111111111111',
  missingPrs: [{ number: 7, url: 'https://bitbucket.org/acme/acme-shared/pull-requests/7' }],
};

// PRs per repo; ages in hours before the round.
const PRS = {
  'bitbucket:acme-backend': [
    { number: 12, title: 'SHOP-42 Invoice export endpoint', author: ADA, mine: true, source: 'feature/SHOP-42-invoice-export', ci: 'failed', ageH: 30, updatedH: 2, locks: [LOCK_MISSING] },
    { number: 13, title: 'develop > staging', author: GRACE, source: 'develop', target: 'staging', ageH: 5, updatedH: 5 },
    { number: 14, title: 'Bump PHP to 8.3', author: LINUS, source: 'chore/bump-php', ageH: 48, updatedH: 20 },
  ],
  'bitbucket:acme-shared': [
    { number: 7, title: 'SHOP-42 Invoice model', author: ADA, mine: true, source: 'feature/SHOP-42-invoice-export', ci: 'running', ageH: 26, updatedH: 1 },
  ],
  'bitbucket:acme-worker': [
    { number: 31, title: 'SHOP-42 Invoice export job', author: GRACE, source: 'feature/SHOP-42-invoice-export', mergeable: 'conflict', ageH: 28, updatedH: 6, locks: [] },
    { number: 32, title: 'Bump PHP to 8.3', author: LINUS, source: 'chore/bump-php', behindBy: 25, ageH: 47, updatedH: 21, locks: [] },
  ],
  'bitbucket:acme-web': [
    { number: 5, title: 'OPS-7 Fix the cookie banner', author: ADA, mine: true, source: 'fix/OPS-7-cookie-banner', ageH: 10, updatedH: 3 },
  ],
  'github:acme-api': [
    { number: 101, title: 'Fix login redirect', author: GRACE, source: 'feature/trello-login', description: 'Card: https://trello.com/c/AbC123/95-fix-login', ageH: 70, updatedH: 4 },
    { number: 102, title: 'Login copy tweaks', author: LINUS, source: 'feature/login-copy', target: 'feature/trello-login', basePr: { number: 101, state: 'open', url: 'https://github.com/acme-corp/acme-api/pull/101' }, ageH: 20, updatedH: 4 },
  ],
  'github:acme-status': [
    { number: 3, title: 'Update dependencies', author: BOT, source: 'dependabot/npm/all', ageH: 24 * 25, updatedH: 24 * 20 },
  ],
  'github:nova-app': [
    { number: 21, title: 'NOVA-3 Sign-up form', author: ADA, mine: true, source: 'feature/NOVA-3-signup', ci: 'failed', ageH: 8, updatedH: 1 },
    { number: 22, title: 'NOVA-3 Sign-up API', author: GRACE, source: 'feature/NOVA-3-signup-api', behindBy: 30, ageH: 50, updatedH: 12 },
  ],
  'github:nova-docs': [
    { number: 4, title: 'Docs: setup guide', author: ADA, mine: true, source: 'docs/setup', draft: true, ci: 'none', mergeable: 'unknown', ageH: 3, updatedH: 3 },
  ],
};

const prUrl = (host, owner, repo, n) => (host === 'github' ? `https://github.com/${owner}/${repo}/pull/${n}` : `https://bitbucket.org/${owner}/${repo}/pull-requests/${n}`);

// A stub PR source for one host: the PRs of the repos in this round's repo set.
function stubSource(host) {
  return async ({ project, repos, now = Date.now() }) => {
    const owner = host === 'github' ? project.hosts.github.owner : project.hosts.bitbucket.workspace;
    const prs = repos.flatMap((r) => (PRS[`${host}:${r.repo}`] ?? []).map((p) => ({
      id: `${host}:${r.repo}#${p.number}`,
      host,
      owner,
      repo: r.repo,
      repoShort: r.repoShort,
      repoUrl: r.repoUrl,
      defaultBranch: r.defaultBranch,
      number: p.number,
      title: p.title,
      url: prUrl(host, owner, r.repo, p.number),
      description: p.description ?? null,
      author: p.author,
      mine: p.mine ?? false,
      source: p.source,
      target: p.target ?? r.defaultBranch,
      headSha: `${p.number}`.padStart(40, 'a'),
      draft: p.draft ?? false,
      createdAt: new Date(now - p.ageH * HOUR).toISOString(),
      updatedAt: new Date(now - p.updatedH * HOUR).toISOString(),
      ci: p.ci ?? 'ok',
      mergeable: p.mergeable ?? 'clean',
      behindBy: p.behindBy ?? 0,
      ...(p.basePr && { basePr: p.basePr }),
      ...(p.locks && { locks: p.locks }),
    })));
    return { prs };
  };
}

const JIRA = { 'SHOP-42': { status: 'In Progress', summary: 'Invoice export' } };

async function stubJira(keysBySite, { sites }) {
  const tickets = {};
  for (const [site, keys] of Object.entries(keysBySite)) {
    for (const key of keys) {
      const template = sites[site]?.browse?.[key.replace(/-\d+$/, '')];
      tickets[key] = { status: JIRA[key]?.status ?? 'To Do', summary: JIRA[key]?.summary ?? null, url: typeof template === 'string' ? template.replaceAll('{key}', key) : null };
    }
  }
  return { tickets };
}

/** The dev board: createBoard over the made-up projects with stub upstream. */
export function devStubBoard({ now = Date.now, timers, log = console.log, broken = false } = {}) {
  const projects = [
    entry('acme', ACME),
    entry('nova', NOVA, [{ file: `${DIR}/projects/nova.json`, path: 'colour', message: 'Unknown key `colour`, ignored' }]),
    ...(broken ? [BROKEN] : []),
  ];
  return createBoard({
    projects,
    settings: { ...DEFAULT_SETTINGS, mine: {}, fixNotes: { bitbucket: 'Read pipelines through the Atlassian MCP.' } },
    secrets: { auth: async (host) => `stub-${host}` },
    http: {
      stats: () => ({ 'api.github.com': { rateLimitRemaining: 4999 } }),
      get: async (url) => (url.startsWith('https://api.github.com/') ? { login: 'ada' } : { uuid: '{ada}' }),
    },
    sources: { github: stubSource('github'), bitbucket: stubSource('bitbucket'), jira: stubJira },
    discoverers: { github: async ({ owner }) => REPOS[owner] ?? [], bitbucket: async ({ owner }) => REPOS[owner] ?? [] },
    now,
    ...(timers && { timers }),
    log,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const raw = process.env.PORT;
  const port = /^\d+$/.test(raw ?? '') && Number(raw) >= 1 && Number(raw) <= 65535 ? Number(raw) : 7431;
  const board = devStubBoard({ broken: process.argv.includes('--broken') });
  const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
  const server = createServer({ publicDir, board });
  server.listen(port, '127.0.0.1', () => {
    console.log(`pr-board dev stub listening on http://127.0.0.1:${port} (stub sources, no network)`);
    board.start();
  });
  const shutdown = () => {
    board.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
