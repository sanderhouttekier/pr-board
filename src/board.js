// The board (SPEC "Collector and polling"): one collector per project, the open and viewed state,
// the tiered rates and the touches. Collectors run rounds; the board decides when.
import { createCollector, createIdentities, stamp } from './collector.js';
import { createDiscovery } from './discover.js';
import { describeError, describeWarning } from './config.js';
import { ATTENTION } from './derive.js';

const FOLLOW_UP_MS = 15_000;
const ATTENTION_KINDS = new Set(Object.values(ATTENTION).flat());

/**
 * The tab data of one project from its snapshot (SPEC "Server", `/api/projects`).
 * count: my PRs, not release, with an attention signal. ageMin: minutes since the last round's data, or null.
 */
export function projectSummary(snapshot, now) {
  const { project, generatedAt, rate, prs } = snapshot;
  const count = prs.filter((p) => p.mine && !p.release && p.signals.some((s) => ATTENTION_KINDS.has(s.kind))).length;
  const ageMin = generatedAt ? Math.max(0, Math.floor((now - Date.parse(generatedAt)) / 60_000)) : null;
  return { id: project.id, title: project.title, count, ageMin, rate, error: project.error, warnings: project.warnings };
}

/**
 * createBoard({ projects, settings, warnings, error, configDir, secrets, http, sources, lockCheck, discoverers, now, timers, log })
 * `projects`, `warnings` and `error` come from loadBoard. One `http` and one `secrets` serve every project.
 * → { start, stop, ids, has, rateOf, list, snapshot, refresh }
 */
export function createBoard({
  projects = [],
  settings,
  warnings = [],
  error = null,
  configDir = null,
  secrets,
  http,
  sources,
  lockCheck,
  discoverers,
  now = Date.now,
  timers = { setTimer: setTimeout, clearTimer: clearTimeout },
  log = console.log,
}) {
  const identities = createIdentities({ http });
  const entries = projects.map((p) => ({
    id: p.id,
    collector: createCollector({
      project: p,
      settings,
      boardWarnings: warnings,
      secrets,
      http,
      ...(sources && { sources }),
      ...(lockCheck && { lockCheck }),
      discovery: createDiscovery({ http, ...(discoverers && { discoverers }) }),
      identities,
      now,
      log,
    }),
    lastSnapshotAt: null, // last snapshot request: viewed
    timer: null,
    followUp: null,
    inFlight: null,
  }));
  const byId = new Map(entries.map((e) => [e.id, e]));
  let lastRequestAt = null; // last API request: open
  let logged = 'closed'; // what the log last said; the board is closed at start
  let stopped = true;

  const within = (t, sec) => t !== null && now() - t <= sec * 1000;
  const isOpen = () => within(lastRequestAt, settings.idleAfterSec);
  const isViewed = (e) => within(e.lastSnapshotAt, settings.idleAfterSec);
  const rate = (e) => (isViewed(e) ? 'viewed' : isOpen() ? 'hourly' : 'paused');
  const age = (e) => (e.collector.lastDoneAt() === null ? Infinity : now() - e.collector.lastDoneAt());

  // The next tick, intervalSec after the last round or skipped tick.
  function arm(e) {
    timers.clearTimer(e.timer);
    e.timer = stopped || !e.collector.ok ? null : timers.setTimer(() => tick(e), settings.intervalSec * 1000);
  }

  // A round for the project unless one is running (then that one). Re-arms the tick when it ends.
  function run(e, { followUp = false } = {}) {
    if (!e.collector.ok) return Promise.resolve();
    if (!e.inFlight) {
      e.inFlight = e.collector.refresh().then(() => {
        e.inFlight = null;
        if (stopped) return;
        arm(e);
        if (!followUp) scheduleFollowUp(e);
      });
    }
    return e.inFlight;
  }

  // One quick round 15 s later while GitHub mergeability is unknown, for a viewed project only.
  function scheduleFollowUp(e) {
    if (e.followUp || !isViewed(e) || !e.collector.needsFollowUp()) return;
    e.followUp = timers.setTimer(() => {
      e.followUp = null;
      return isViewed(e) && !stopped ? run(e, { followUp: true }) : undefined;
    }, FOLLOW_UP_MS);
  }

  // Viewed: a round. Open: a round once the data is idleIntervalSec old. Closed: skip, no calls.
  function tick(e) {
    e.timer = null;
    if (stopped) return undefined;
    if (!isOpen()) {
      if (logged === 'open') {
        logged = 'closed';
        log(`${stamp(now())} board closed: no request for ${Math.round(settings.idleAfterSec / 60)} min`);
      }
      return arm(e);
    }
    if (isViewed(e) || age(e) >= settings.idleIntervalSec * 1000) return run(e);
    return arm(e);
  }

  // Any API request keeps the board open. After it was closed: a round for every project with
  // no data or data older than idleIntervalSec.
  function request() {
    const wasOpen = isOpen();
    lastRequestAt = now();
    if (wasOpen) return;
    if (logged === 'closed') log(`${stamp(now())} board open`);
    logged = 'open';
    for (const e of entries) if (age(e) > settings.idleIntervalSec * 1000) run(e);
  }

  function start() {
    stopped = false;
    for (const e of entries) arm(e);
  }

  function stop() {
    stopped = true;
    for (const e of entries) {
      timers.clearTimer(e.timer);
      timers.clearTimer(e.followUp);
      e.timer = null;
      e.followUp = null;
    }
  }

  // GET /api/projects: marks the board open, no project viewed.
  function list() {
    request();
    return {
      projects: entries.map((e) => projectSummary(e.collector.snapshot({ rate: rate(e) }), now())),
      error: describeError(error),
      warnings: warnings.map(describeWarning),
      configDir,
    };
  }

  // GET /api/p/<id>/snapshot: marks the board open and the project viewed; a round when the data is
  // missing or older than intervalSec (not awaited). null for an unknown id.
  function snapshot(id) {
    const e = byId.get(id);
    if (!e) return null;
    request();
    e.lastSnapshotAt = now();
    if (age(e) > settings.intervalSec * 1000) run(e);
    return e.collector.snapshot({ rate: rate(e) });
  }

  // POST /api/p/<id>/refresh: a round unless one is running. null for an unknown id.
  function refresh(id) {
    const e = byId.get(id);
    if (!e) return null;
    const started = e.collector.ok && !e.inFlight;
    if (started) run(e);
    return { started };
  }

  return {
    start,
    stop,
    ids: () => entries.map((e) => e.id),
    has: (id) => byId.has(id),
    rateOf: (id) => (byId.has(id) ? rate(byId.get(id)) : null),
    list,
    snapshot,
    refresh,
  };
}
