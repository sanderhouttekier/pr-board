import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBoard, describeError, describeWarning } from './config.js';
import { configDir, ensureConfigDir } from './configdir.js';
import { createSecrets } from './secrets.js';
import { createHttp } from './http.js';
import { createBoard } from './board.js';
import { createSharedPackageCheck } from './sharedPackages.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const PROJECT_PAGE = /^\/p\/[a-z0-9][a-z0-9-]*$/;
const PROJECT_API = /^\/api\/p\/([^/]+)\/(snapshot|refresh)$/;

const DERIVE_FILE = fileURLToPath(new URL('./derive.js', import.meta.url));

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

// Routes (SPEC "Server"). `board` is createBoard's: ids, has, list, snapshot, refresh.
export function createServer({ publicDir, board }) {
  const root = path.resolve(publicDir);
  const server = http.createServer(async (req, res) => {
    const notFound = () => {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    };
    const forbidden = () => {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
    };
    const serveFile = async (file) => {
      const type = TYPES[path.extname(file)];
      if (!type) return notFound();
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': type });
        return res.end(req.method === 'HEAD' ? undefined : body);
      } catch {
        return notFound();
      }
    };

    // DNS-rebinding guard: only our own host:port, and no cross-origin POSTs.
    const port = server.address()?.port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host)) return forbidden();
    if (req.method === 'POST' && req.headers.origin !== undefined && !hosts.map((h) => `http://${h}`).includes(req.headers.origin)) {
      return forbidden();
    }

    const urlPath = req.url.split('?')[0];
    if (urlPath.startsWith('/api/')) return api(req, res, urlPath);
    if (urlPath === '/lib/derive.js' && req.method === 'GET') return serveFile(DERIVE_FILE);
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound();

    const index = path.join(root, 'index.html');
    if (urlPath === '/') {
      const first = board.ids()[0];
      if (first === undefined) return serveFile(index); // the page shows the "no projects" state
      res.writeHead(302, { location: `/p/${first}` });
      return res.end();
    }
    if (PROJECT_PAGE.test(urlPath)) return serveFile(index); // the page reads the id from the URL
    if (urlPath.startsWith('/p/')) return notFound();

    let rel;
    try {
      rel = decodeURIComponent(urlPath);
    } catch {
      return notFound();
    }
    if (rel.split('/').includes('..') || rel.includes('\0')) return notFound();
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep)) return notFound();
    return serveFile(file);
  });

  function api(req, res, urlPath) {
    if (urlPath === '/api/projects' && req.method === 'GET') {
      return sendJson(res, 200, board.list(), { 'cache-control': 'no-store' });
    }
    const m = PROJECT_API.exec(urlPath);
    const route = m && ((m[2] === 'snapshot' && req.method === 'GET') || (m[2] === 'refresh' && req.method === 'POST'));
    if (!route) return sendJson(res, 404, { error: 'Not found' });
    const id = m[1];
    if (!board.has(id)) return sendJson(res, 404, { error: `Unknown project \`${id}\`` });
    if (m[2] === 'snapshot') return sendJson(res, 200, board.snapshot(id), { 'cache-control': 'no-store' });
    return sendJson(res, 202, board.refresh(id));
  }

  return server;
}

// --- Boot ---

/**
 * Resolves the config dir, loads the board and builds (does not start) it. Tests inject stub
 * upstream (`secrets`, `http`, `sources`, `discoverers`); by default it is the real thing.
 */
export function bootstrap({ env = process.env, log = console.log, secrets, http: httpClient, sources, discoverers } = {}) {
  const dir = configDir({ env });
  try {
    ensureConfigDir(dir);
  } catch (err) {
    log(`config dir ${dir} could not be created (${err?.code ?? 'error'})`);
  }
  const loaded = loadBoard({ dir, env });
  const { settings } = loaded;
  log(`config dir ${dir}`);
  if (loaded.error) log(`config error: ${describeError(loaded.error)}`);
  for (const w of loaded.warnings) log(`config warning: ${describeWarning(w)}`);
  for (const p of loaded.projects) {
    if (!p.ok) log(`project ${p.id} stopped: ${describeError(p.error)}`);
    for (const w of p.warnings) log(`project ${p.id} warning: ${describeWarning(w)}`);
  }
  if (!loaded.error && loaded.projects.length === 0) log(`no projects in ${path.join(dir, 'config.json')}`);

  const shared = httpClient ?? createHttp({});
  const lockCheck = createSharedPackageCheck({ http: shared });
  const board = createBoard({
    projects: loaded.projects,
    settings,
    warnings: loaded.warnings,
    error: loaded.error,
    configDir: dir,
    secrets: secrets ?? createSecrets({ env, settings }),
    http: shared,
    lockCheck,
    ...(sources && { sources }),
    ...(discoverers && { discoverers }),
    log,
  });
  return { port: settings.port, board, loaded };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { port, board } = bootstrap();
  const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
  const server = createServer({ publicDir, board });
  server.listen(port, '127.0.0.1', () => {
    console.log(`pr-board listening on http://127.0.0.1:${port}`);
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
