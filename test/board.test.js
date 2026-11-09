import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBoard, projectSummary } from '../src/board.js';

const NOW = Date.parse('2026-11-06T10:00:00Z');

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

const titleOf = (id) => id[0].toUpperCase() + id.slice(1);

// A loadBoard entry for a made-up project `<id>` (owner `<id>-corp`, workspace `<id>`), no Jira site.
const entry = (id, extra = {}) => ({
  id,
  title: titleOf(id),
  file: `/cfg/projects/${id}.json`,
  ok: true,
  error: null,
  warnings: [],
  project: {
    title: titleOf(id),
    hosts: { github: { owner: `${id}-corp` }, bitbucket: { workspace: id } },
    tickets: [{ prefix: 'SHOP', browse: null }],
  },
  credentials: { github: { ref: '', override: false }, bitbucket: { ref: `${id}-bitbucket`, email: 'you@example.com', override: true } },
  ...extra,
});

const broken = {
  id: 'broken',
  title: 'broken',
  file: '/cfg/projects/broken.json',
  ok: false,
  error: { file: '/cfg/projects/broken.json', errors: [{ path: '', message: 'File not found' }] },
  warnings: [],
  project: null,
  credentials: null,
};

function pr(repo, number, extra = {}) {
  return {
    id: `github:${repo}#${number}`,
    host: 'github',
    repo,
    repoShort: repo,
    number,
    title: `PR ${number}`,
    url: `https://x/${number}`,
    author: { name: 'ada', id: 'ada' },
    mine: false,
    source: `feature/SHOP-${number}-x`,
    target: 'main',
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

// Stub sources: GitHub returns `prsByTitle[project title]`; every call is recorded by project title.
function stubSources(prsByTitle = {}, { gate } = {}) {
  const calls = { github: [], bitbucket: [], jira: [] };
  return {
    calls,
    github: async (ctx) => {
      calls.github.push(ctx.project.title);
      if (gate?.[ctx.project.title]) await gate[ctx.project.title];
      return { prs: prsByTitle[ctx.project.title] ?? [] };
    },
    bitbucket: async (ctx) => {
      calls.bitbucket.push(ctx.project.title);
      return { prs: [] };
    },
    jira: async () => {
      calls.jira.push(1);
      return { tickets: {} };
    },
  };
}

const rounds = (sources, title) => sources.calls.github.filter((t) => t === title).length;

function stubSecrets() {
  const calls = [];
  return { calls, auth: async (host) => (calls.push(host), `header-${host}`) };
}

const discoverers = {
  github: async ({ owner }) => [{ name: `${owner}-api`, defaultBranch: 'main' }],
  bitbucket: async ({ owner }) => [{ name: `${owner}-web`, defaultBranch: 'develop' }],
};

const stubHttp = () => ({
  stats: () => ({}),
  get: async (url) => (url.includes('github') ? { login: 'ada' } : { uuid: '{ada}' }),
});

function fakeTimers() {
  const timers = [];
  return {
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false, fired: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.cleared = true;
    },
    pending: () => timers.filter((t) => !t.cleared && !t.fired),
    fire: (t) => {
      t.fired = true;
      return t.fn();
    },
  };
}

function clock(start = NOW) {
  let t = start;
  const fn = () => t;
  fn.advance = (sec) => {
    t += sec * 1000;
  };
  return fn;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

// Fires every pending timer (optionally only those of `ms`) and waits for what they started.
async function fireAll(timers, ms) {
  for (const t of timers.pending().filter((x) => ms === undefined || x.ms === ms)) await timers.fire(t);
  await flush();
}

function make({ projects = [entry('acme'), entry('beta')], settings = SETTINGS, sources = stubSources(), warnings, error, configDir } = {}) {
  const now = clock();
  const timers = fakeTimers();
  const logs = [];
  const secrets = stubSecrets();
  const board = createBoard({
    projects,
    settings,
    warnings,
    error,
    configDir,
    secrets,
    http: stubHttp(),
    sources,
    discoverers,
    now,
    timers,
    log: (line) => logs.push(line),
  });
  return { board, sources, secrets, timers, now, logs };
}

// --- rates table ---

test('closed at start: one tick per project, ticks run no round and call no auth; stop clears them', async () => {
  const { board, sources, secrets, timers, now, logs } = make({ projects: [entry('acme'), entry('beta'), broken] });
  board.start();
  assert.deepEqual(timers.pending().map((t) => t.ms), [300_000, 300_000], 'no timer for a project with an error');
  for (let i = 0; i < 3; i++) {
    now.advance(300);
    await fireAll(timers);
  }
  assert.equal(sources.calls.github.length + sources.calls.bitbucket.length, 0);
  assert.equal(secrets.calls.length, 0);
  assert.equal(timers.pending().length, 2, 'ticks keep their schedule');
  assert.equal(board.rateOf('acme'), 'paused');
  assert.deepEqual(logs, [], 'no close line while it was never open');
  board.stop();
  assert.equal(timers.pending().length, 0);
});

test('viewed: a snapshot with no data starts a round at once, then one every intervalSec while viewed', async () => {
  const { board, sources, timers, now } = make();
  board.start();
  const s = board.snapshot('acme');
  assert.equal(s.refreshing, true, 'not awaited');
  assert.equal(s.rate, 'viewed');
  await flush();
  assert.equal(rounds(sources, 'Acme'), 1);
  assert.deepEqual(timers.pending().map((t) => t.ms), [300_000, 300_000]);
  for (let i = 0; i < 3; i++) {
    now.advance(300);
    board.snapshot('acme');
    await fireAll(timers);
  }
  assert.equal(rounds(sources, 'Acme'), 4);
  assert.equal(rounds(sources, 'Beta'), 1, 'beta is open but not viewed: hourly');
  assert.equal(board.rateOf('acme'), 'viewed');
  assert.equal(board.rateOf('beta'), 'hourly');
});

test('open but not viewed: a round every idleIntervalSec', async () => {
  const { board, sources, timers, now } = make();
  board.start();
  board.list();
  await flush();
  assert.equal(rounds(sources, 'Acme'), 1);
  assert.equal(rounds(sources, 'Beta'), 1);
  for (let i = 1; i <= 24; i++) {
    now.advance(300);
    board.list();
    await fireAll(timers);
    if (i === 11) assert.equal(rounds(sources, 'Acme'), 1, 'nothing before idleIntervalSec');
  }
  assert.equal(rounds(sources, 'Acme'), 3);
  assert.equal(rounds(sources, 'Beta'), 3);
  assert.deepEqual(board.list().projects.map((p) => p.rate), ['hourly', 'hourly']);
});

test('closed: after idleAfterSec without a request, ticks skip their round with no source or auth calls', async () => {
  const { board, sources, secrets, timers, now } = make();
  board.start();
  board.snapshot('acme');
  await flush();
  let authAtClose;
  for (let i = 1; i <= 6; i++) {
    now.advance(300);
    await fireAll(timers);
    if (i === 3) authAtClose = secrets.calls.length;
  }
  // ticks at +300, +600 and +900 are within idleAfterSec (900) of the request; +1200 and later are closed
  assert.equal(rounds(sources, 'Acme'), 4);
  assert.equal(rounds(sources, 'Beta'), 1);
  assert.equal(secrets.calls.length, authAtClose);
  assert.equal(board.rateOf('acme'), 'paused');
  assert.equal(board.rateOf('beta'), 'paused');
  assert.deepEqual(timers.pending().map((t) => t.ms), [300_000, 300_000], 'keeps its schedule');
});

test('one log line when the board closes and one when it opens again, not one per tick', async () => {
  const { board, timers, now, logs } = make();
  const opened = () => logs.filter((l) => /^2026-11-06T\d\d:\d\d:\d\dZ board open$/.test(l)).length;
  const closed = () => logs.filter((l) => /^2026-11-06T\d\d:\d\d:\d\dZ board closed: no request for 15 min$/.test(l)).length;
  board.start();
  board.list();
  await flush();
  assert.equal(opened(), 1);
  for (let i = 0; i < 8; i++) {
    now.advance(300);
    await fireAll(timers);
  }
  assert.equal(closed(), 1);
  board.list();
  board.snapshot('acme');
  await flush();
  assert.equal(opened(), 2);
  for (let i = 0; i < 8; i++) {
    now.advance(300);
    await fireAll(timers);
  }
  assert.equal(closed(), 2);
  board.list();
  await flush();
  assert.equal(opened(), 3);
  now.advance(1000); // closed by time, but no tick noticed it: no close line, so no open line either
  board.list();
  await flush();
  assert.equal(opened(), 3);
  assert.equal(closed(), 2);
});

// --- touches ---

test('a snapshot touch of a stale project starts a round at once; fresh data starts none', async () => {
  const { board, sources, now } = make();
  board.start();
  board.list();
  await flush();
  now.advance(299);
  assert.equal(board.snapshot('beta').refreshing, false);
  await flush();
  assert.equal(rounds(sources, 'Beta'), 1);
  now.advance(2);
  assert.equal(board.snapshot('beta').refreshing, true);
  await flush();
  assert.equal(rounds(sources, 'Beta'), 2);
});

test('an hourly project refreshes at once when it is opened', async () => {
  const { board, sources, now } = make();
  board.start();
  board.snapshot('acme');
  await flush();
  now.advance(600);
  board.snapshot('acme');
  await flush();
  assert.equal(rounds(sources, 'Beta'), 1);
  const s = board.snapshot('beta');
  assert.equal(s.refreshing, true);
  await flush();
  assert.equal(rounds(sources, 'Beta'), 2);
  assert.equal(board.rateOf('beta'), 'viewed');
});

test('the first request after the board closed starts a round for each project older than idleIntervalSec or without data', async () => {
  const { board, sources, now } = make({ projects: [entry('acme'), entry('beta'), broken] });
  board.start();
  board.list();
  await flush();
  assert.equal(rounds(sources, 'Acme'), 1, 'no data → round');
  assert.equal(rounds(sources, 'Beta'), 1, 'no data → round');
  now.advance(100);
  board.list();
  await flush();
  assert.equal(sources.calls.github.length, 2, 'a request while open starts nothing');
  now.advance(2900); // t = 3000: closed; nothing older than idleIntervalSec yet
  board.snapshot('acme'); // acme is stale for intervalSec → its own round
  await flush();
  assert.equal(rounds(sources, 'Acme'), 2);
  assert.equal(rounds(sources, 'Beta'), 1);
  now.advance(1000); // t = 4000: closed again; beta's data is 4000 s old, acme's 1000 s
  board.list();
  await flush();
  assert.equal(rounds(sources, 'Beta'), 2);
  assert.equal(rounds(sources, 'Acme'), 2);
});

// --- follow-up ---

test('the 15 s follow-up runs only for viewed projects, once per regular round', async () => {
  const unknown = [pr('x-api', 1, { mergeable: 'unknown' })];
  const { board, sources, timers, now } = make({ sources: stubSources({ Acme: unknown, Beta: unknown }) });
  board.start();
  board.snapshot('acme');
  await flush();
  let quick = timers.pending().filter((t) => t.ms === 15_000);
  assert.equal(quick.length, 1, 'beta was refreshed too but is not viewed');
  now.advance(15);
  await timers.fire(quick[0]);
  await flush();
  assert.equal(rounds(sources, 'Acme'), 2);
  assert.equal(rounds(sources, 'Beta'), 1);
  assert.equal(timers.pending().filter((t) => t.ms === 15_000).length, 0, 'no follow-up from a follow-up round');
  now.advance(300);
  await fireAll(timers, 300_000);
  assert.equal(rounds(sources, 'Acme'), 3);
  quick = timers.pending().filter((t) => t.ms === 15_000);
  assert.equal(quick.length, 1, 'the next regular round may schedule one again');
  now.advance(901);
  await timers.fire(quick[0]);
  await flush();
  assert.equal(rounds(sources, 'Acme'), 3, 'no follow-up round once the project is not viewed');
});

test('a draft with unknown mergeability gets no follow-up', async () => {
  const { board, timers } = make({ sources: stubSources({ Acme: [pr('x-api', 1, { mergeable: 'unknown', draft: true })] }) });
  board.start();
  board.snapshot('acme');
  await flush();
  assert.equal(timers.pending().filter((t) => t.ms === 15_000).length, 0);
});

// --- overlap ---

test('rounds of one project never overlap; other projects run independently', async () => {
  let release;
  const gate = { Acme: new Promise((r) => (release = r)) };
  const { board, sources, timers, now } = make({ sources: stubSources({}, { gate }) });
  board.start();
  board.snapshot('acme');
  await flush();
  assert.equal(rounds(sources, 'Acme'), 1);
  assert.equal(rounds(sources, 'Beta'), 1);
  assert.deepEqual(board.refresh('acme'), { started: false });
  now.advance(301);
  board.snapshot('acme');
  for (const t of timers.pending()) timers.fire(t);
  await flush();
  assert.equal(rounds(sources, 'Acme'), 1, 'touch, refresh and tick join the running round');
  assert.deepEqual(board.refresh('beta'), { started: true });
  await flush();
  assert.equal(rounds(sources, 'Beta'), 2);
  release();
  await flush();
  assert.deepEqual(board.refresh('acme'), { started: true });
  await flush();
  assert.equal(rounds(sources, 'Acme'), 2);
});

// --- refresh, list, snapshot ---

test('refresh: started true, false while busy; unknown id → null; a project with an error never starts', async () => {
  const { board, sources } = make({ projects: [entry('acme'), broken] });
  board.start();
  assert.deepEqual(board.refresh('acme'), { started: true });
  assert.deepEqual(board.refresh('acme'), { started: false });
  await flush();
  assert.equal(rounds(sources, 'Acme'), 1);
  assert.equal(board.refresh('nope'), null);
  assert.deepEqual(board.refresh('broken'), { started: false });
});

test('list: the tab data per project; marks the board open but no project viewed', async () => {
  const warnings = [{ file: '/cfg/config.json', path: 'colour', message: 'Unknown key `colour`, ignored' }];
  const { board, now } = make({ projects: [entry('acme'), broken], warnings, configDir: '/cfg' });
  board.start();
  const l = board.list();
  assert.deepEqual(Object.keys(l), ['projects', 'error', 'warnings', 'configDir']);
  assert.equal(l.error, null);
  assert.deepEqual(l.warnings, ['config.json: Unknown key `colour`, ignored']);
  assert.equal(l.configDir, '/cfg');
  assert.deepEqual(l.projects[1], {
    id: 'broken',
    title: 'broken',
    count: 0,
    ageMin: null,
    rate: 'hourly',
    error: '/cfg/projects/broken.json: File not found',
    warnings: ['config.json: Unknown key `colour`, ignored'],
  });
  assert.equal(l.projects[0].rate, 'hourly');
  assert.equal(board.rateOf('acme'), 'hourly');
  await flush();
  now.advance(40 * 60);
  const later = board.list();
  assert.equal(later.projects[0].ageMin, 40);
  assert.equal(later.projects[0].error, null);
  assert.deepEqual(board.ids(), ['acme', 'broken']);
  assert.equal(board.has('acme'), true);
  assert.equal(board.has('nope'), false);
});

test('a board error: no projects and the error in the list', () => {
  const error = { file: '/cfg/config.json', errors: [{ path: '', message: 'Invalid JSON: Unexpected token' }] };
  const { board } = make({ projects: [], error });
  board.start();
  assert.deepEqual(board.list(), { projects: [], error: '/cfg/config.json: Invalid JSON: Unexpected token', warnings: [], configDir: null });
  assert.deepEqual(board.ids(), []);
});

test('snapshot: unknown id → null; a project with an error answers with its error and runs nothing', async () => {
  const { board, sources, secrets } = make({ projects: [entry('acme'), broken] });
  board.start();
  assert.equal(board.snapshot('nope'), null);
  const s = board.snapshot('broken');
  assert.equal(s.project.error, '/cfg/projects/broken.json: File not found');
  assert.equal(s.rate, 'viewed');
  await flush();
  assert.equal(rounds(sources, 'Acme'), 1, 'the first request still refreshes the others');
  assert.equal(secrets.calls.filter((h) => h === 'jira').length, 0);
});

test('non-default timing: intervalSec 60, idleAfterSec 120, idleIntervalSec 600', async () => {
  const settings = { ...SETTINGS, intervalSec: 60, idleAfterSec: 120, idleIntervalSec: 600 };
  const { board, sources, timers, now, logs } = make({ settings });
  board.start();
  assert.deepEqual(timers.pending().map((t) => t.ms), [60_000, 60_000]);
  board.snapshot('acme');
  await flush();
  assert.equal(board.snapshot('acme').intervalSec, 60);
  for (let i = 0; i < 3; i++) {
    now.advance(60);
    await fireAll(timers);
  }
  // ticks at +60 and +120 are viewed; +180 is closed
  assert.equal(rounds(sources, 'Acme'), 3);
  assert.equal(logs.filter((l) => /board closed: no request for 2 min/.test(l)).length, 1);
  now.advance(61);
  board.snapshot('acme');
  await flush();
  assert.equal(rounds(sources, 'Acme'), 4, 'stale for intervalSec 60 → immediate round');
});

// --- projectSummary ---

test('projectSummary: count = my PRs, not release, with an attention signal; ageMin; rate; error; warnings', () => {
  const sig = (kind, severity = 'warning') => ({ kind, severity, label: kind });
  const snapshot = {
    project: { id: 'acme', title: 'Acme', hosts: {}, error: null, warnings: ['w'] },
    generatedAt: new Date(NOW - 40 * 60_000 - 59_000).toISOString(),
    rate: 'hourly',
    prs: [
      { mine: true, release: false, signals: [sig('ci-failed', 'danger')] },
      { mine: true, release: false, signals: [sig('stale')] },
      { mine: true, release: false, signals: [sig('lock-missing')] },
      { mine: true, release: true, signals: [sig('conflict', 'danger')] },
      { mine: false, release: false, signals: [sig('conflict', 'danger')] },
      { mine: true, release: false, signals: [sig('behind'), sig('ci-running', 'neutral')] },
      { mine: true, release: false, signals: [] },
    ],
  };
  assert.deepEqual(projectSummary(snapshot, NOW), { id: 'acme', title: 'Acme', count: 3, ageMin: 40, rate: 'hourly', error: null, warnings: ['w'] });
  assert.equal(projectSummary({ ...snapshot, generatedAt: null }, NOW).ageMin, null);
});
