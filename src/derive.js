// Pure: Ticket key, release detection, grouping, signals, worst problem, ready.
// No I/O, no clock, no imports: callers pass `ctx = { now, staleDays, behindWarn, matchers }`.
// Served to the page as /lib/derive.js.

const DAY_MS = 86_400_000;
const MAIN_BRANCHES = new Set(['develop', 'staging', 'main', 'master', 'acceptance']);
const RELEASE_TITLE_RE = /^(develop|staging|acceptance|main)\s*>\s*/i;
const SEVERITY_RANK = { danger: 0, warning: 1, neutral: 2, success: 3 };

// Highest first. `behind` only counts at warning severity (see isProblem).
const WORST_ORDER = [
  'conflict', 'ci-failed', 'base-retarget', 'lock-unpin', 'lock-missing',
  'base-no-pr', 'lock-pinned', 'stale', 'behind', 'ci-running',
];
const WORST_RANK = new Map(WORST_ORDER.map((k, i) => [k, i]));

export const ATTENTION = {
  ciFailed: ['ci-failed'],
  conflicts: ['conflict'],
  stacked: ['base-retarget', 'base-no-pr'],
  lock: ['lock-unpin', 'lock-pinned', 'lock-missing'],
  stale: ['stale'],
};

// A main branch is not stacked and counts for release PRs (SPEC "Normalized PR").
export function isMainBranch(branch, defaultBranch) {
  return MAIN_BRANCHES.has(branch) || (!!defaultBranch && branch === defaultBranch);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const prefixRe = (prefix) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(prefix)}[-_ ]?(\\d+)(?![0-9])`, 'i');
const browseUrl = (browse, key) => (typeof browse === 'string' ? browse.replaceAll('{key}', key) : null);
const URL_RE = /https?:\/\/[^\s<>()[\]"'`]+/g;

// Leftmost prefix match in `text` across all prefix matchers; ties go to file order.
function prefixMatch(text, prefixes) {
  if (!text) return null;
  let best = null;
  for (const m of prefixes) {
    const hit = prefixRe(m.prefix).exec(text);
    if (hit && (!best || hit.index < best.index)) best = { index: hit.index, m, digits: hit[1] };
  }
  if (!best) return null;
  const key = `${best.m.prefix.toUpperCase()}-${best.digits}`;
  return { key, label: key, url: browseUrl(best.m.browse, key), jiraSite: best.m.jira ?? null };
}

function linkMatch(description, links) {
  if (!description) return null;
  const urls = description.match(URL_RE) ?? [];
  for (const m of links) {
    const needle = m.link.toLowerCase();
    for (const u of urls) {
      const at = u.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      const rest = u.slice(at + needle.length);
      const id = /^[^/?#]+/.exec(rest)?.[0];
      if (!id) continue;
      const key = u.slice(0, at + needle.length + id.length);
      const digits = /^\/(\d+)/.exec(rest.slice(id.length))?.[1];
      return { key, label: digits ? `#${digits}` : id, url: key, jiraSite: null };
    }
  }
  return null;
}

// SPEC "Tickets": prefix matchers (branch, then title), else link matchers on the description.
export function ticketKey(pr, matchers) {
  const list = Array.isArray(matchers) ? matchers : [];
  const prefixes = list.filter((m) => typeof m?.prefix === 'string' && m.prefix !== '');
  const links = list.filter((m) => typeof m?.link === 'string' && m.link !== '');
  return prefixMatch(pr.source, prefixes)
    ?? prefixMatch(pr.title, prefixes)
    ?? linkMatch(pr.description, links);
}

// From raw PRs (with description): the snapshot's `tickets` skeleton that Jira fills in, and
// the Jira keys per site (`jiraKeys: { [site]: [key] }`, first-seen order).
export function ticketsFor(prs, matchers) {
  const tickets = {};
  const jiraKeys = {};
  for (const pr of prs) {
    const t = ticketKey(pr, matchers);
    if (!t || Object.hasOwn(tickets, t.key)) continue;
    tickets[t.key] = { label: t.label, url: t.url, status: null, summary: null };
    if (t.jiraSite) (jiraKeys[t.jiraSite] ??= []).push(t.key);
  }
  return { tickets, jiraKeys };
}

export function isRelease(pr) {
  if (isMainBranch(pr.source, pr.defaultBranch) && isMainBranch(pr.target, pr.defaultBranch)) return true;
  return RELEASE_TITLE_RE.test(pr.title ?? '');
}

const sig = (kind, severity, label, href) => (href === undefined ? { kind, severity, label } : { kind, severity, label, href });

function ciSignals(pr) {
  if (pr.ci === 'failed') return [sig('ci-failed', 'danger', 'CI failed')];
  if (pr.ci === 'running') return [sig('ci-running', 'neutral', 'CI running')];
  if (pr.ci === 'ok') return [sig('ci-ok', 'success', 'CI ok')];
  return [];
}

function mergeSignals(pr) {
  if (pr.mergeable === 'conflict') return [sig('conflict', 'danger', 'conflict')];
  if (pr.mergeable === 'clean') return [sig('mergeable', 'success', 'mergeable')];
  return [];
}

function stackSignals(pr) {
  const base = pr.basePr;
  if (base === undefined || isMainBranch(pr.target, pr.defaultBranch)) return [];
  if (base === null) return [sig('base-no-pr', 'warning', 'base has no PR')];
  if (base.state === 'open') return [sig('stacked', 'neutral', `stacked on #${base.number}`, base.url)];
  if (base.state === 'merged') {
    return pr.host === 'bitbucket'
      ? [sig('base-auto', 'neutral', 'base merged (auto-retarget)')]
      : [sig('base-retarget', 'danger', 'base merged: retarget')];
  }
  return [sig('base-retarget', 'danger', 'base closed: retarget')];
}

// SPEC "Shared package check": the shared package branch a `dev-<branch>` constraint pins, or null
// when it isn't a pin. The shared repo's default branch is no pin; when that default is unknown,
// no main branch is.
export function lockPin(constraint, defaultBranch) {
  const branch = /^dev-([^\s#]+)/.exec(typeof constraint === 'string' ? constraint : '')?.[1];
  if (!branch) return null;
  const isDefault = defaultBranch ? branch === defaultBranch : isMainBranch(branch, null);
  return isDefault ? null : branch;
}

// One set per entry in `pr.locks`, named by the shared package repo's short name.
function lockSignals(pr) {
  const out = [];
  for (const lock of Array.isArray(pr.locks) ? pr.locks.filter(Boolean) : []) {
    const shared = lock.sharedRepo ?? {};
    const name = shared.repoShort || shared.repo || lock.package;
    if (lockPin(lock.constraint, shared.defaultBranch)) {
      const p = lock.pinnedPr;
      if (p?.state === 'open') out.push(sig('lock-waits', 'neutral', `waits for ${name} #${p.number}`, p.url));
      else if (p?.state === 'merged') out.push(sig('lock-unpin', 'warning', 'lock bump due: unpin', p.url));
      else out.push(sig('lock-pinned', 'warning', `pinned to ${name} branch`));
    }
    for (const m of lock.missingPrs ?? []) {
      out.push(sig('lock-missing', 'warning', `lock bump due: ${name} #${m.number}`, m.url));
    }
  }
  return out;
}

function behindSignals(pr, ctx) {
  const n = pr.behindBy;
  if (typeof n !== 'number' || n <= 0) return [];
  const label = n >= 100 ? '99+ behind' : `${n} behind`;
  return [sig('behind', n >= ctx.behindWarn ? 'warning' : 'neutral', label)];
}

function staleSignals(pr, ctx) {
  const updated = Date.parse(pr.updatedAt);
  if (Number.isNaN(updated)) return [];
  const age = ctx.now - updated;
  if (age <= ctx.staleDays * DAY_MS) return [];
  return [sig('stale', 'warning', `stale ${Math.floor(age / DAY_MS)}d`)];
}

export function signals(pr, ctx) {
  const all = [
    ...ciSignals(pr),
    ...mergeSignals(pr),
    ...(pr.draft ? [sig('draft', 'neutral', 'draft')] : []),
    ...stackSignals(pr),
    ...lockSignals(pr),
    ...behindSignals(pr, ctx),
    ...staleSignals(pr, ctx),
  ];
  return all.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

function isProblem(s) {
  if (!WORST_RANK.has(s.kind)) return false;
  return s.kind !== 'behind' || s.severity === 'warning';
}

const worstRank = (s) => (s ? WORST_RANK.get(s.kind) : Infinity);

export function worst(sigs) {
  let best = null;
  for (const s of sigs) {
    if (isProblem(s) && worstRank(s) < worstRank(best)) best = s;
  }
  return best;
}

export function isReady(pr, sigs) {
  return !pr.draft
    && (pr.ci === 'ok' || pr.ci === 'none')
    && pr.mergeable === 'clean'
    && !sigs.some((s) => s.severity === 'danger' || s.severity === 'warning');
}

export function enrich(prs, ctx) {
  return prs.map(({ description, ...pr }) => {
    const sigs = signals(pr, ctx);
    return {
      ...pr,
      ticketKey: ticketKey({ ...pr, description }, ctx.matchers)?.key ?? null,
      release: isRelease(pr),
      signals: sigs,
      worst: worst(sigs),
      ready: isReady(pr, sigs),
    };
  });
}

function comparePrs(a, b) {
  return worstRank(a.worst) - worstRank(b.worst)
    || a.repoShort.localeCompare(b.repoShort)
    || a.number - b.number;
}

function groupSeverity(prs) {
  let sev = null;
  for (const pr of prs) {
    for (const s of pr.signals) {
      if (s.severity === 'danger') return 'danger';
      if (s.severity === 'warning') sev = 'warning';
    }
  }
  return sev;
}

const TIER = { danger: 0, warning: 1 };
const tier = (sev) => TIER[sev] ?? 2;
const lastUpdate = (prs) => Math.max(...prs.map((p) => Date.parse(p.updatedAt) || 0));

export function groupByTicket(prs, tickets = {}) {
  const byKey = new Map();
  const noTicket = [];
  const releases = [];
  for (const pr of prs) {
    if (pr.release) releases.push(pr);
    else if (!pr.ticketKey) noTicket.push(pr);
    else {
      if (!byKey.has(pr.ticketKey)) byKey.set(pr.ticketKey, []);
      byKey.get(pr.ticketKey).push(pr);
    }
  }
  const groups = [...byKey].map(([key, list]) => {
    const f = tickets[key] ?? {};
    const sorted = [...list].sort(comparePrs);
    return {
      key,
      status: f.status ?? null,
      summary: f.summary ?? null,
      url: f.url ?? null,
      prs: sorted,
      ready: sorted.filter((p) => p.ready).length,
      total: sorted.length,
      allMine: sorted.every((p) => p.mine),
      severity: groupSeverity(sorted),
    };
  });
  const updated = new Map(groups.map((g) => [g, lastUpdate(g.prs)]));
  groups.sort((a, b) => tier(a.severity) - tier(b.severity) || updated.get(b) - updated.get(a));
  return { groups, noTicket: { prs: noTicket.sort(comparePrs) }, releases: { prs: releases } };
}

export function groupByRepo(prs, repos) {
  const out = [];
  for (const repo of repos) {
    const list = prs.filter((p) => !p.release && p.host === repo.host && p.repo === repo.repo);
    if (list.length === 0) continue;
    out.push({
      ...repo,
      open: list.length,
      mine: list.filter((p) => p.mine).length,
      worst: worst(list.map((p) => p.worst).filter(Boolean)),
      prs: [...list].sort(comparePrs),
    });
  }
  return out;
}

export function attentionCounts(prs) {
  const counts = {};
  for (const [name, kinds] of Object.entries(ATTENTION)) {
    counts[name] = prs.filter((p) => !p.release && p.signals.some((s) => kinds.includes(s.kind))).length;
  }
  return counts;
}
