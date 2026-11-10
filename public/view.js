// Pure view: snapshot + UI state → view model → HTML string.
// No imports and no clock: derive.js and fix-prompt.js are injected and `ui.now` is passed in,
// so node:test and the browser load the same file.

const DAY_MS = 86_400_000;
const DONE_RE = /done|closed|resolved|released|klaar/i;
const CI_KINDS = new Set(['ci-ok', 'ci-failed', 'ci-running']);
const MERGE_KINDS = new Set(['conflict', 'mergeable']);
const SEVERITIES = new Set(['success', 'danger', 'warning', 'neutral', 'muted']);
const TIER = { danger: 0, warning: 1 };
const ATTENTION_CHIPS = [
  ['ciFailed', 'CI failing', 'danger'],
  ['conflicts', 'Conflicts', 'danger'],
  ['stacked', 'Stacked trap', 'danger'],
  ['lock', 'Lock bump due', 'warning'],
  ['stale', 'Stale', 'warning'],
];
const SOURCE_NAMES = { github: 'GitHub', bitbucket: 'Bitbucket', jira: 'Jira' };

// Icons: Tabler-style outlines (MIT) and brand marks, all currentColor.
const stroke = (size, body, cls) => `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON_EXTERNAL = stroke(14, '<path d="M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6"/><path d="M11 13l9 -9"/><path d="M15 4h5v5"/>', 'icon-ext');
const ICON_CHEVRON = stroke(16, '<path d="M9 6l6 6l-6 6"/>', 'icon-chev');
const ICON_REFRESH = stroke(16, '<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>', 'icon-refresh');
// The refresh countdown (SPEC "Page", header). The border of the 30 px button as one path from top
// centre clockwise (1 px stroke on the half pixel, 8 px corners); app.js drains it. The icon as its
// six strokes in drawing order (top arc, its arrowhead's two legs from the corner out, bottom arc,
// its two legs) over a faint copy of the whole icon; app.js draws them in and out on a loop.
const BORDER_PATH = 'M15 .5H22.5A7 7 0 0 1 29.5 7.5V22.5A7 7 0 0 1 22.5 29.5H7.5A7 7 0 0 1 .5 22.5V7.5A7 7 0 0 1 7.5 .5Z';
const COUNTDOWN_BORDER = `<svg class="countdown-border" viewBox="0 0 30 30" aria-hidden="true"><path class="countdown-track" d="${BORDER_PATH}" pathLength="100"/><path class="countdown-fill" d="${BORDER_PATH}" pathLength="100"/></svg>`;
const REFRESH_STROKES = ['M20 11a8.1 8.1 0 0 0 -15.5 -2', 'M4 9V5', 'M4 9H8', 'M4 13a8.1 8.1 0 0 0 15.5 2', 'M20 15V19', 'M20 15H16'];
const ICON_REFRESH_COUNTDOWN = stroke(16, '<path class="ghost" d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path class="ghost" d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>'
  + REFRESH_STROKES.map((d) => `<path class="ink" d="${d}"/>`).join(''), 'icon-refresh');
const ICON_WAND = stroke(14, '<path d="M6 21l15 -15l-3 -3l-15 15l3 3"/><path d="M15 6l3 3"/><path d="M9 3a2 2 0 0 0 2 2a2 2 0 0 0 -2 2a2 2 0 0 0 -2 -2a2 2 0 0 0 2 -2"/><path d="M19 13a2 2 0 0 0 2 2a2 2 0 0 0 -2 2a2 2 0 0 0 -2 -2a2 2 0 0 0 2 -2"/>', 'icon-wand');
const ICON_ALERT = stroke(14, '<path d="M12 9v4"/><path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z"/><path d="M12 16h.01"/>', 'icon-alert');
const ICON_COPY = stroke(14, '<path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z"/><path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1"/>', 'icon-copy');
const ICON_CHECK = stroke(14, '<path d="M5 12l5 5l10 -10"/>', 'icon-check');
const ICON_GITHUB = '<svg class="logo" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" role="img"><title>GitHub</title><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';
const ICON_BITBUCKET = '<svg class="logo" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" role="img"><title>Bitbucket</title><path d="M.778 1.213a.768.768 0 0 0-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 0 0 .77-.646l3.27-20.03a.768.768 0 0 0-.768-.891zM14.52 15.53H9.522L8.17 8.466h7.561z"/></svg>';
const logo = (host) => (host === 'github' ? ICON_GITHUB : host === 'bitbucket' ? ICON_BITBUCKET : '');

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
export const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
// Inline code in config messages: escape first, then turn `x` into <code>x</code>.
const inlineCode = (s) => esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>');
const projectHref = (id) => `/p/${encodeURIComponent(String(id ?? ''))}`;
const pageTitle = (title) => (title ? `${title} pull requests` : 'Pull requests');
const hrefAttr = (u) => {
  const s = safeUrl(u);
  return s ? ` href="${esc(s)}" target="_blank" rel="noopener noreferrer"` : '';
};

function hhmm(isoString) {
  const d = new Date(isoString ?? NaN);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function severityOf(prs) {
  let sev = null;
  for (const pr of prs) {
    for (const s of pr.signals ?? []) {
      if (s.severity === 'danger') return 'danger';
      if (s.severity === 'warning') sev = 'warning';
    }
  }
  return sev;
}

const lastUpdate = (prs) => Math.max(0, ...prs.map((p) => Date.parse(p.updatedAt) || 0));
const tier = (sev) => TIER[sev] ?? 2;
const drawerIdOf = (key) => `fix-${String(key).replace(/[^A-Za-z0-9_-]/g, '-')}`;

// Project tabs from /api/projects: only with two or more projects.
function tabsOf(board, currentId) {
  const projects = board?.projects ?? [];
  if (projects.length < 2) return null;
  return projects.map((p) => ({
    id: p.id,
    title: p.title ?? p.id,
    href: projectHref(p.id),
    count: p.count ?? 0,
    age: p.rate === 'hourly' && Number.isFinite(p.ageMin) ? (p.ageMin < 1 ? '<1 min' : `${p.ageMin} min`) : null,
    error: !!p.error,
    current: p.id === currentId,
  }));
}

/** The page without a project: no projects at all, or an unknown id. `board` is /api/projects. */
export function stateModel(board, id) {
  const projects = board?.projects ?? [];
  const state = projects.length === 0
    ? { kind: 'none', configDir: board?.configDir ?? null }
    : { kind: 'unknown', id, projects: projects.map((p) => ({ title: p.title ?? p.id, href: projectHref(p.id) })) };
  return { title: pageTitle(null), state, boardError: board?.error ?? null };
}

export function createView(derive, fixPrompt) {
  // Shared fix state for one drawer: open flag, copy feedback, prompt only when open.
  function fixVm(key, ui, prompt) {
    const open = ui.fixOpen?.has(key) ?? false;
    const copied = open && ui.copied?.key === key ? (ui.copied.ok ? 'ok' : 'failed') : null;
    return { key, open, drawerId: drawerIdOf(key), copied, ...(open ? { prompt: prompt() } : {}) };
  }

  function rowFix(pr, ui) {
    const severity = fixPrompt.fixSeverity(pr);
    if (!severity) return null;
    return {
      severity,
      owner: pr.mine ? null : { name: pr.author?.name ?? null },
      ...fixVm(pr.id, ui, () => fixPrompt.promptFor(pr, ui.fixCtx ?? {})),
    };
  }

  function groupFix(id, label, prs, ui) {
    const fixable = prs.filter((p) => fixPrompt.fixSeverity(p));
    if (fixable.length < 2) return null;
    const notMine = fixable.filter((p) => !p.mine);
    const names = [...new Set(notMine.map((p) => p.author?.name).filter(Boolean))];
    return {
      count: fixable.length,
      severity: fixable.some((p) => fixPrompt.fixSeverity(p) === 'danger') ? 'danger' : 'warning',
      owners: notMine.length ? { notMine: notMine.length, total: fixable.length, names } : null,
      ...fixVm(id, ui, () => fixPrompt.bundlePrompt(fixable, label, ui.fixCtx ?? {})),
    };
  }

  function rowVm(pr, ui, showAuthor) {
    const now = ui.now;
    const sigs = pr.signals ?? [];
    const ordered = [
      ...sigs.filter((s) => CI_KINDS.has(s.kind)),
      ...sigs.filter((s) => MERGE_KINDS.has(s.kind)),
      ...sigs.filter((s) => !CI_KINDS.has(s.kind) && !MERGE_KINDS.has(s.kind)),
    ];
    // Quiet chips: success signals (CI ok, mergeable) never get their own chip. A row without a
    // danger or warning shows one "ok" chip instead; neutral signals stay next to it.
    const problems = ordered.filter((s) => s.severity !== 'success');
    const chips = problems.map((s) => ({ label: s.label, severity: s.severity }));
    if (!problems.some((s) => s.severity === 'danger' || s.severity === 'warning')) {
      chips.unshift({ label: 'ok', severity: 'success' });
    }
    const created = Date.parse(pr.createdAt);
    let age = null;
    if (Number.isFinite(created) && Number.isFinite(now)) {
      const days = Math.max(0, Math.floor((now - created) / DAY_MS));
      age = days === 0 ? 'today' : `${days}d`;
    }
    return {
      id: pr.id,
      host: pr.host,
      repoShort: pr.repoShort,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: showAuthor ? (pr.author?.name ?? null) : null,
      chips,
      age,
      fix: rowFix(pr, ui),
    };
  }

  function groupVm(base, prs, ui, filtering) {
    const ready = prs.filter((p) => p.ready).length;
    const collapsible = !filtering && prs.length > 3 && ready > 0;
    const expanded = ui.expandedGroups?.has(base.id) ?? false;
    const shown = collapsible && !expanded ? prs.filter((p) => !p.ready) : prs;
    return {
      ...base,
      ready,
      total: prs.length,
      severity: severityOf(prs),
      rows: shown.map((p) => rowVm(p, ui, base.kind === 'other')),
      fix: base.kind === 'other' ? null : groupFix(base.id, base.label ?? base.key, prs, ui),
      hiddenCount: collapsible ? ready : 0,
      toggle: collapsible ? (expanded ? 'less' : 'more') : null,
    };
  }

  function ticketGroups(visible, tickets, ui, filtering) {
    const byTicket = derive.groupByTicket(visible, tickets ?? {});
    // Jira summary and status only when the Jira source gave a status; no url means a plain label.
    const groups = byTicket.groups.map((g) => ({
      group: groupVm({
        id: `f:${g.key}`,
        kind: 'ticket',
        key: g.key,
        label: tickets?.[g.key]?.label ?? g.key,
        url: g.url ?? null,
        summary: g.status == null ? null : g.summary,
        status: g.status,
        statusSeverity: g.status == null ? null : DONE_RE.test(g.status) ? 'success' : 'neutral',
      }, g.prs, ui, filtering),
      updated: lastUpdate(g.prs),
    }));

    const byBranch = new Map();
    for (const pr of byTicket.noTicket.prs) {
      if (!byBranch.has(pr.source)) byBranch.set(pr.source, []);
      byBranch.get(pr.source).push(pr);
    }
    const singles = [];
    for (const [branch, prs] of byBranch) {
      if (prs.length < 2) {
        singles.push(...prs);
        continue;
      }
      groups.push({
        group: groupVm({ id: `b:${branch}`, kind: 'branch', key: branch }, prs, ui, filtering),
        updated: lastUpdate(prs),
      });
    }
    groups.sort((a, b) => tier(a.group.severity) - tier(b.group.severity) || b.updated - a.updated);
    const out = groups.map((g) => g.group);
    if (singles.length > 0) {
      const order = new Map(byTicket.noTicket.prs.map((p, i) => [p, i]));
      singles.sort((a, b) => order.get(a) - order.get(b));
      out.push(groupVm({ id: 'other', kind: 'other', key: 'Other PRs' }, singles, ui, filtering));
    }
    return { groups: out, releases: byTicket.releases.prs };
  }

  /** `board` is the /api/projects response (tabs, board error), or undefined before it arrives. */
  function viewModel(snapshot, uiState, board) {
    // The fix prompts' ctx is the snapshot's `fix` (SPEC "Fix prompts"), carried with the UI state.
    const ui = { ...uiState, fixCtx: snapshot.fix ?? {} };
    const all = snapshot.prs ?? [];
    const scoped = ui.mine ? all.filter((p) => p.mine) : all;
    const counts = derive.attentionCounts(scoped);
    const kinds = ui.attention ? (derive.ATTENTION[ui.attention] ?? []) : null;
    const filtering = kinds !== null;
    const visible = filtering ? scoped.filter((p) => (p.signals ?? []).some((s) => kinds.includes(s.kind))) : scoped;

    const banners = Object.entries(snapshot.sources ?? {})
      .filter(([, s]) => s?.ok === false)
      .map(([name, s]) => {
        const when = s.fetchedAt ? `last update ${hhmm(s.fetchedAt)}` : 'no data yet';
        return `${SOURCE_NAMES[name] ?? name}: ${when} · ${s.error ?? 'error'}`;
      });

    const { groups, releases } = ticketGroups(visible, snapshot.tickets, ui, filtering);
    const repos = ui.view === 'repo'
      ? derive.groupByRepo(visible, snapshot.repos ?? []).map((r) => {
        const id = `${r.host}:${r.repo}`;
        const expanded = ui.expandedRepos?.has(id) ?? false;
        return {
          id,
          host: r.host,
          repoShort: r.repoShort,
          repoUrl: r.repoUrl,
          open: r.open,
          mine: r.mine,
          worst: r.worst ? { label: r.worst.label, severity: r.worst.severity } : null,
          expanded,
          rows: expanded ? r.prs.map((p) => rowVm(p, ui, false)) : [],
        };
      })
      : [];

    const shownGroups = ui.view === 'repo' ? [] : groups;
    const releaseRows = releases.map((p) => rowVm(p, ui, false));
    // Single source for what the open drawers show and what Copy puts on the clipboard.
    const fixPrompts = {};
    const collect = (fix) => {
      if (fix?.open) fixPrompts[fix.key] = fix.prompt;
    };
    for (const g of shownGroups) {
      collect(g.fix);
      g.rows.forEach((r) => collect(r.fix));
    }
    for (const r of repos) r.rows.forEach((row) => collect(row.fix));
    releaseRows.forEach((r) => collect(r.fix));

    const project = snapshot.project ?? {};
    return {
      title: pageTitle(project.title),
      tabs: tabsOf(board, project.id),
      boardError: board?.error ?? null,
      projectError: project.error ?? null,
      warnings: project.warnings ?? [],
      loading: snapshot.generatedAt == null,
      view: ui.view === 'repo' ? 'repo' : 'ticket',
      mine: !!ui.mine,
      header: {
        title: pageTitle(project.title),
        rate: snapshot.rate ?? null,
        openCount: visible.filter((p) => !p.release).length,
        updated: hhmm(snapshot.generatedAt),
        refreshing: !!snapshot.refreshing,
        intervalMin: Math.round((snapshot.intervalSec ?? 300) / 60),
        next: snapshot.rate === 'viewed' ? hhmm(snapshot.nextAt) : null,
        countdown: snapshot.rate === 'viewed' && hhmm(snapshot.nextAt) ? { nextAt: snapshot.nextAt, periodSec: snapshot.intervalSec ?? 300 } : null,
      },
      attention: ATTENTION_CHIPS.map(([name, label, severity]) => ({
        name, label, severity, count: counts[name] ?? 0, active: ui.attention === name,
      })),
      banners,
      groups: shownGroups,
      repos,
      releases: {
        count: releases.length,
        open: !!ui.releasesOpen,
        rows: releaseRows,
      },
      empty: all.length === 0 ? 'No open PRs' : visible.length === 0 ? 'No PRs match' : null,
      fixPrompts,
    };
  }

  // Rendering. Every PR-controlled string goes through esc(); hrefs through hrefAttr().

  const chip = (c) => `<span class="chip ${SEVERITIES.has(c.severity) ? c.severity : 'neutral'}">${esc(c.label)}</span>`;

  function renderFixButton(fix, label) {
    return `<button type="button" class="fix-btn ${fix.severity === 'danger' ? 'danger' : 'warning'}" data-action="fix" data-value="${esc(fix.key)}" aria-expanded="${fix.open}" aria-controls="${esc(fix.drawerId)}" title="Show a fix prompt for Claude">${ICON_WAND}${label}</button>`;
  }

  function rowOwnerNote(owner) {
    if (!owner) return '';
    return owner.name
      ? `<strong>Not your PR.</strong> ${esc(owner.name)} owns it. Fixing it is an intrusive action: discuss it with ${esc(owner.name)} before you push anything.`
      : "<strong>Not your PR.</strong> Fixing someone else's PR is an intrusive action: discuss it with the owner before you push anything.";
  }

  function groupOwnerNote(owners) {
    if (!owners) return '';
    const one = owners.notMine === 1;
    const names = owners.names.length ? ` (${owners.names.map(esc).join(', ')})` : '';
    return `<strong>${owners.notMine} of these ${owners.total} PRs ${one ? "isn't" : "aren't"} yours</strong>${names}. `
      + `Fixing them is an intrusive action: discuss it with ${one ? 'the owner' : 'the owners'} before you push anything.`;
  }

  function renderDrawer(fix, ownerHtml) {
    const owner = ownerHtml ? `<div class="fix-owner" role="note">${ICON_ALERT}<span>${ownerHtml}</span></div>` : '';
    const copy = fix.copied === 'ok' ? ['fix-copy ok', ICON_CHECK, 'Copied']
      : fix.copied === 'failed' ? ['fix-copy failed', ICON_COPY, 'Copy failed']
        : ['fix-copy', ICON_COPY, 'Copy prompt'];
    return `<div class="fix-drawer" id="${esc(fix.drawerId)}">${owner}`
      + '<div class="fix-bar"><span class="fix-bar-label">Prompt for Claude</span>'
      + `<button type="button" class="${copy[0]}" data-action="fix-copy" data-value="${esc(fix.key)}">${copy[1]}${copy[2]}</button></div>`
      + `<pre class="fix-prompt">${esc(fix.prompt)}</pre></div>`;
  }

  function renderRow(r) {
    const author = r.author ? `<span class="author">${esc(r.author)}</span> ` : '';
    const fullTitle = r.author ? `${r.author}: ${r.title ?? ''}` : (r.title ?? '');
    const hostName = SOURCE_NAMES[r.host];
    const linkTitle = `Open ${r.repoShort ?? ''} #${r.number ?? ''}${hostName ? ` on ${hostName}` : ''}`;
    return '<div class="pr">'
      + `<a class="pr-link"${hrefAttr(r.url)} title="${esc(linkTitle)}">`
      + logo(r.host)
      + `<span class="ref"><span class="repo">${esc(r.repoShort)}</span> <span class="num">#${esc(r.number)}</span></span>`
      + '</a>'
      + `<span class="title" title="${esc(fullTitle)}">${author}${esc(r.title)}</span>`
      + `<span class="chips">${r.chips.map(chip).join('')}${r.age ? `<span class="age">${esc(r.age)}</span>` : ''}</span>`
      + `<span class="fixcol">${r.fix ? renderFixButton(r.fix, 'Fix') : ''}</span>`
      + '</div>'
      + (r.fix?.open ? renderDrawer(r.fix, rowOwnerNote(r.fix.owner)) : '');
  }

  function renderHeader(vm) {
    const h = vm.header;
    const seg = (action, value, label, pressed) => `<button type="button" data-action="${action}" data-value="${value}" aria-pressed="${pressed}">${label}</button>`;
    const when = h.refreshing ? 'updating…' : h.updated ? `updated ${h.updated}` : 'not updated yet';
    return '<header class="top">'
      + '<div class="heading">'
      + `<div class="title-line"><h1>${esc(h.title)}</h1>${vm.loading || vm.projectError ? '' : `<span class="open-count">${h.openCount} open</span>`}</div>`
      + `<p class="meta">${when} · ${h.rate === 'hourly' ? 'hourly' : h.next ? `next ${h.next}` : `every ${h.intervalMin} min`}</p>`
      + '</div>'
      + '<div class="controls">'
      + `<div class="seg" role="group" aria-label="Whose PRs">${seg('mine', '1', 'Mine', vm.mine)}${seg('mine', '0', 'All', !vm.mine)}</div>`
      + `<div class="seg" role="group" aria-label="Group by">${seg('view', 'ticket', 'By ticket', vm.view === 'ticket')}${seg('view', 'repo', 'By repo', vm.view === 'repo')}</div>`
      + renderRefreshButton(h)
      + '</div>'
      + '</header>';
  }

  function renderRefreshButton(h) {
    const cls = `icon-button${h.countdown ? ' countdown' : ''}${h.refreshing ? ' spinning' : ''}`;
    const data = h.countdown ? ` data-next="${esc(h.countdown.nextAt)}" data-period="${esc(h.countdown.periodSec)}"` : '';
    const body = h.countdown ? COUNTDOWN_BORDER + ICON_REFRESH_COUNTDOWN : ICON_REFRESH;
    return `<button type="button" class="${cls}" data-action="refresh"${data} aria-label="Refresh now" title="Refresh now">${body}</button>`;
  }

  function renderAttention(vm) {
    const chips = vm.attention.map((c) => {
      const cls = c.count === 0 ? 'muted' : c.severity;
      return `<button type="button" class="att ${cls}${c.active ? ' active' : ''}" data-action="attention" data-value="${c.name}" aria-pressed="${c.active}"${c.count === 0 && !c.active ? ' disabled' : ''}>${c.label} <span class="count">${c.count}</span></button>`;
    });
    return `<nav class="attention" aria-label="Needs attention">${chips.join('')}</nav>`;
  }

  function renderGroup(g) {
    let head;
    if (g.kind === 'ticket') {
      const key = safeUrl(g.url)
        ? `<a class="key"${hrefAttr(g.url)}>${esc(g.label)}${ICON_EXTERNAL}</a>`
        : `<span class="key">${esc(g.label)}</span>`;
      head = key
        + (g.summary ? `<span class="summary" title="${esc(g.summary)}">${esc(g.summary)}</span>` : '<span class="summary"></span>')
        + (g.status ? chip({ label: g.status, severity: g.statusSeverity }) : '');
    } else if (g.kind === 'branch') {
      head = `<span class="key branch" title="${esc(g.key)}">${esc(g.key)}</span><span class="summary"></span>`;
    } else {
      head = `<span class="group-title">Other PRs</span><span class="summary"><span class="muted">${g.total}</span></span>`;
    }
    const readyCount = g.kind === 'other' ? '' : `<span class="ready${g.ready === g.total ? ' all' : ''}">ready ${g.ready} of ${g.total}</span>`;
    const toggle = g.toggle
      ? `<button type="button" class="more" data-action="group" data-value="${esc(g.id)}" aria-expanded="${g.toggle === 'less'}">${g.toggle === 'less' ? 'Show less' : `Show ${g.hiddenCount} more · all mergeable`}</button>`
      : '';
    const fixBtn = g.fix ? renderFixButton(g.fix, `Fix all ${g.fix.count}`) : '';
    const drawer = g.fix?.open ? renderDrawer(g.fix, groupOwnerNote(g.fix.owners)) : '';
    return `<section class="card group"><div class="group-head">${head}${fixBtn}${readyCount}</div>`
      + `<div class="rows">${drawer}${g.rows.map(renderRow).join('')}${toggle}</div></section>`;
  }

  function renderRepos(vm) {
    const rows = vm.repos.map((r) => {
      const needs = r.worst ? chip(r.worst) : '<span class="chip muted">none</span>';
      return `<div class="repo${r.expanded ? ' expanded' : ''}">`
        + `<div class="repo-row" data-action="repo" data-value="${esc(r.id)}">`
        + logo(r.host)
        + `<span class="repo-name"><a class="repo-link"${hrefAttr(r.repoUrl)}>${esc(r.repoShort)}</a></span>`
        + `<span class="n">${r.open}</span><span class="n">${r.mine}</span>`
        + `<span class="needs">${needs}</span>`
        + `<button type="button" class="chev" data-action="repo" data-value="${esc(r.id)}" aria-expanded="${r.expanded}" aria-label="${r.expanded ? 'Hide' : 'Show'} PRs of ${esc(r.repoShort)}">${ICON_CHEVRON}</button>`
        + '</div>'
        + (r.expanded ? `<div class="rows repo-prs">${r.rows.map(renderRow).join('')}</div>` : '')
        + '</div>';
    });
    return '<section class="card repos">'
      + '<div class="repo-row repo-head" aria-hidden="true"><span></span><span>Repo</span><span class="n">Open</span><span class="n">Mine</span><span>Needs you</span><span></span></div>'
      + rows.join('')
      + '</section>';
  }

  function renderReleases(rel) {
    if (rel.count === 0) return '';
    return `<section class="card releases${rel.open ? ' expanded' : ''}">`
      + `<button type="button" class="disclosure" data-action="releases" aria-expanded="${rel.open}">${ICON_CHEVRON}Release PRs (${rel.count})</button>`
      + (rel.open ? `<div class="rows">${rel.rows.map(renderRow).join('')}</div>` : '')
      + '</section>';
  }

  function renderTabs(tabs) {
    if (!tabs) return '';
    const items = tabs.map((t) => `<a class="tab${t.error ? ' has-error' : ''}" href="${esc(t.href)}"${t.current ? ' aria-current="page"' : ''}>`
      + esc(t.title) + (t.count > 0 ? ` (${t.count})` : '')
      + (t.age ? `<span class="tab-age">· ${esc(t.age)}</span>` : '')
      + (t.error ? '<span class="tab-mark" aria-hidden="true">!</span><span class="visually-hidden"> (error)</span>' : '')
      + '</a>');
    return `<nav class="projects" aria-label="Projects">${items.join('')}</nav>`;
  }

  const errorBanner = (heading, text) => `<div class="banner error" role="status"><strong>${heading}</strong><div class="banner-text">${inlineCode(text)}</div></div>`;
  const boardBanner = (vm) => (vm.boardError ? errorBanner("The board can't run.", vm.boardError) : '');

  function renderWarnings(warnings) {
    if (!warnings.length) return '';
    return `<ul class="warnings">${warnings.map((w) => `<li>${inlineCode(w)}</li>`).join('')}</ul>`;
  }

  function renderState(vm) {
    const s = vm.state;
    if (s.kind === 'none') {
      if (vm.boardError) return boardBanner(vm);
      const dir = s.configDir ? s.configDir.replace(/[\\/]+$/, '') : null;
      const sep = dir && dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
      const file = dir ? `${dir}${sep}config.json` : 'config.json';
      return `<div class="card state">No projects yet.<br>Add one in <code>${esc(file)}</code>. The README shows how.</div>`;
    }
    const links = s.projects.map((p) => `<a href="${esc(p.href)}">${esc(p.title)}</a>`).join(', ');
    return boardBanner(vm) + `<div class="card state">Unknown project <code>${esc(s.id)}</code>.<br>${links}</div>`;
  }

  function render(vm) {
    if (vm.state) return renderState(vm);
    const top = renderTabs(vm.tabs) + renderHeader(vm) + boardBanner(vm);
    if (vm.projectError) return top + errorBanner("This project can't run.", vm.projectError);
    const banners = vm.banners.map((b) => `<div class="banner" role="status">${esc(b)}</div>`).join('');
    if (vm.loading) return top + banners + '<p class="state">Loading…</p>';
    let body;
    if (vm.empty) body = `<div class="card state">${esc(vm.empty)}</div>`;
    else if (vm.view === 'repo') body = (vm.repos.length ? renderRepos(vm) : '') + renderReleases(vm.releases);
    else body = vm.groups.map(renderGroup).join('') + renderReleases(vm.releases);
    return top + renderAttention(vm) + renderWarnings(vm.warnings) + banners + `<div class="board">${body}</div>`;
  }

  return { viewModel, stateModel, render };
}
