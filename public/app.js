// Browser glue: fetch the project snapshot and the tab data, keep UI state, render, poll.
import * as derive from '/lib/derive.js';
import * as fixPrompt from '/fix-prompt.js';
import {
  createView, togglePanel, panelTab, panelLoading, panelResult, panelOnSnapshot, panelModel, renderPanel,
  clampPanelWidth, parsePanelWidth, PANEL_DEFAULT_W,
} from '/view.js';

const view = createView(derive, fixPrompt);
const root = document.getElementById('app');
const panelEl = document.getElementById('pr-panel');
const STORE = 'pr-board:ui';
const WIDTH_STORE = 'pr-board:panel-width';
const WIDTH_STEP = 24;
// The page only lives at /p/<id> (the server redirects /), except with no projects at all.
const PROJECT_ID = /^\/p\/([a-z0-9][a-z0-9-]*)\/?$/.exec(location.pathname)?.[1] ?? null;
const POLL_MS = 30_000;
const POLL_REFRESHING_MS = 3_000;
const COPIED_MS = 1_600;
const ICON_LOOPS = 5; // refresh icon draw loops per countdown period (one a minute at 5 min)
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORE)) ?? {};
  } catch {
    return {};
  }
}

function savePrefs() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ mine: ui.mine, view: ui.view }));
  } catch {
    // Storage blocked: the toggles still work for this visit.
  }
}

const prefs = loadPrefs();
const ui = {
  mine: prefs.mine === true,
  view: prefs.view === 'repo' ? 'repo' : 'ticket',
  attention: null,
  expandedRepos: new Set(),
  expandedGroups: new Set(),
  releasesOpen: false,
  fixOpen: new Set(), // keys of open fix drawers: PR ids and group ids
  copied: null, // { key, ok } after a copy, cleared after COPIED_MS
};

let snapshot = null;
let board = null; // /api/projects
let unknown = false; // snapshot 404 (or no id): render the state page from `board`
let lastKey = null;
let timer = null;
let lastVm = null;
let copiedTimer = null;
let countdown = null; // the refresh button's countdown in the current render, see bindCountdown()
// The PR detail panel (SPEC "Page", "PR detail panel"): state transitions live in view.js.
let panel = null; // null while closed
let panelSeq = 0; // request counter: only the latest request's answer is applied
let panelHtml = '';
let panelView = null; // `${id}|${tab}` of the current render, to keep the body's scroll position
let preferredWidth = loadWidth(); // what the user chose (stored per browser)
let panelWidth = PANEL_DEFAULT_W; // what fits the window right now
let dragging = false;

function draw() {
  if (unknown || !PROJECT_ID) {
    if (!board) return;
    lastVm = view.stateModel(board, PROJECT_ID);
    document.title = lastVm.title;
    root.innerHTML = view.render(lastVm);
    bindCountdown();
    return;
  }
  if (!snapshot) return;
  // innerHTML replaces the buttons, so put keyboard focus back on the same control.
  const focused = document.activeElement?.closest?.('button[data-action]');
  const was = focused ? [focused.dataset.action, focused.dataset.value] : null;
  lastVm = view.viewModel(snapshot, { ...ui, now: Date.now(), panelId: panel?.id ?? null }, board);
  document.title = lastVm.title;
  root.innerHTML = view.render(lastVm);
  bindCountdown();
  if (!was) return;
  for (const el of root.querySelectorAll('button[data-action]')) {
    if (el.dataset.action === was[0] && el.dataset.value === was[1]) {
      el.focus();
      break;
    }
  }
}

async function getJson(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    return { status: res.status, body: res.ok ? await res.json() : null };
  } catch {
    return { status: 0, body: null }; // Server unreachable: keep the last page and try again.
  }
}

async function poll() {
  clearTimeout(timer);
  const [snap, projects] = await Promise.all([
    PROJECT_ID ? getJson(`/api/p/${PROJECT_ID}/snapshot`) : Promise.resolve(null),
    getJson('/api/projects'),
  ]);
  if (projects.body) board = projects.body;
  if (!PROJECT_ID && board?.projects?.length) {
    location.replace(`/p/${encodeURIComponent(board.projects[0].id)}`);
    return;
  }
  if (snap?.status === 404) unknown = true;
  else if (snap?.body) {
    unknown = false;
    snapshot = snap.body;
    const next = panelOnSnapshot(panel, snapshot.prs);
    panel = next.state;
    if (next.refetch) loadDetail(); // silent: the old content stays until the new arrives
  }
  paintPanel();
  const key = JSON.stringify([unknown, snapshot?.generatedAt, snapshot?.refreshing, snapshot?.nextAt, board]);
  if (key !== lastKey) {
    lastKey = key;
    draw();
  }
  // Hidden tab: no timer at all, so the server can go idle; visibilitychange resumes.
  if (document.visibilityState !== 'hidden') {
    let delay = snapshot?.refreshing && !unknown ? POLL_REFRESHING_MS : POLL_MS;
    // Catch the scheduled round as it starts: poll a second after nextAt rather than up to 30 s late.
    const untilNext = Date.parse(snapshot?.nextAt) + 1000 - Date.now();
    if (untilNext > 0 && untilNext < delay) delay = untilNext;
    timer = setTimeout(poll, delay);
  }
}

// The refresh countdown (SPEC "Page", header). The border drains from full after a round to empty
// at nextAt. The icon's six strokes loop ICON_LOOPS times per period, counted from the period's
// start: a head draws them in one after the other (70%, eased), all stay (10%), then a tail erases
// them in the same direction (20%, eased). While refreshing, CSS takes over (chase and spin).
function bindCountdown() {
  const btn = root.querySelector('.icon-button.countdown');
  if (!btn) {
    countdown = null;
    return;
  }
  let offset = 0;
  const strokes = [...btn.querySelectorAll('.ink')].map((el) => {
    const len = el.getTotalLength();
    const s = { el, len, offset };
    offset += len;
    return s;
  });
  countdown = {
    fill: btn.querySelector('.countdown-fill'),
    next: Date.parse(btn.dataset.next),
    periodMs: Number(btn.dataset.period) * 1000,
    busy: btn.classList.contains('spinning'),
    strokes,
    total: offset,
  };
  paintCountdown(Date.now());
}

const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);

function iconLoop(t) {
  if (t < 0.7) return { tail: 0, head: ease(t / 0.7) };
  if (t < 0.8) return { tail: 0, head: 1 };
  return { tail: ease((t - 0.8) / 0.2), head: 1 };
}

function paintCountdown(now) {
  const c = countdown;
  if (!c || !(c.periodMs > 0) || Number.isNaN(c.next)) return;
  const remain = Math.min(1, Math.max(0, (c.next - now) / c.periodMs));
  c.fill.style.strokeDasharray = `${remain * 100} 100`;
  const loopMs = c.periodMs / ICON_LOOPS;
  const t = ((((now - (c.next - c.periodMs)) % loopMs) + loopMs) % loopMs) / loopMs;
  const { tail, head } = c.busy || reducedMotion.matches ? { tail: 0, head: 1 } : iconLoop(t);
  for (const { el, len, offset } of c.strokes) {
    const a = Math.min(len, Math.max(0, tail * c.total - offset));
    const b = Math.min(len, Math.max(0, head * c.total - offset));
    el.style.strokeDasharray = `${b - a} ${len + 1}`;
    el.style.strokeDashoffset = String(-a);
    el.style.opacity = b - a > 0.05 ? '1' : '0'; // a 0-length dash with a round cap still shows a dot
  }
}

function frame() {
  paintCountdown(Date.now());
  requestAnimationFrame(frame);
}

async function refresh() {
  try {
    if (PROJECT_ID) await fetch(`/api/p/${PROJECT_ID}/refresh`, { method: 'POST' });
  } catch {
    // Ignored: the next poll shows whatever state the server is in.
  }
  poll();
}

function copyFallback(text) {
  // select() moves focus to the textarea; give it back so draw() can restore it.
  const prev = document.activeElement;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
    prev?.focus?.();
  }
}

async function copyPrompt(key) {
  const text = lastVm?.fixPrompts?.[key];
  let ok = false;
  if (typeof text === 'string') {
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = copyFallback(text);
    }
  }
  clearTimeout(copiedTimer);
  ui.copied = { key, ok };
  draw();
  copiedTimer = setTimeout(() => {
    ui.copied = null;
    draw();
  }, COPIED_MS);
}

const toggle = (set, value) => (set.has(value) ? set.delete(value) : set.add(value));

root.addEventListener('click', (event) => {
  if (event.target.closest('a')) return; // Tabs, PR rows, Ticket keys and repo links open as links.
  const el = event.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const { action, value } = el.dataset;
  switch (action) {
    case 'mine': ui.mine = value === '1'; savePrefs(); break;
    case 'view': ui.view = value === 'repo' ? 'repo' : 'ticket'; savePrefs(); break;
    case 'attention': ui.attention = ui.attention === value ? null : value; break;
    case 'group': toggle(ui.expandedGroups, value); break;
    case 'repo': toggle(ui.expandedRepos, value); break;
    case 'releases': ui.releasesOpen = !ui.releasesOpen; break;
    case 'fix': toggle(ui.fixOpen, value); break;
    case 'fix-copy': copyPrompt(value); return;
    case 'refresh': refresh(); return;
    case 'detail': toggleDetail(value); return;
    default: return;
  }
  draw();
});

// PR detail panel

function loadWidth() {
  try {
    return parsePanelWidth(localStorage.getItem(WIDTH_STORE));
  } catch {
    return PANEL_DEFAULT_W;
  }
}

function saveWidth() {
  try {
    localStorage.setItem(WIDTH_STORE, String(preferredWidth));
  } catch {
    // Storage blocked: the width still holds for this visit.
  }
}

function syncGrip() {
  panelEl.querySelector('.panel-grip')?.setAttribute('aria-valuenow', String(panelWidth));
}

// The applied width: the preference clamped to the window. The preference itself stays.
function applyWidth(width) {
  panelWidth = clampPanelWidth(width, window.innerWidth);
  document.body.style.setProperty('--panel-w', `${panelWidth}px`);
  syncGrip();
}

function setPreferred(width) {
  applyWidth(width);
  preferredWidth = panelWidth;
  saveWidth();
}

// Writes the panel only when its HTML changed, so polls keep its scroll position and focus.
function paintPanel() {
  panelEl.hidden = !panel;
  document.body.classList.toggle('panel-open', !!panel);
  const html = renderPanel(panelModel(panel, Date.now()));
  if (html === panelHtml) return;
  const focused = panelEl.contains(document.activeElement) ? document.activeElement : null;
  const was = focused?.classList.contains('panel-grip') ? ['grip']
    : focused?.dataset?.action ? [focused.dataset.action, focused.dataset.value] : null;
  const key = panel ? `${panel.id}|${panel.tab}` : null;
  const scroll = key && key === panelView ? (panelEl.querySelector('.panel-body')?.scrollTop ?? 0) : 0;
  panelHtml = html;
  panelView = key;
  panelEl.innerHTML = html;
  syncGrip();
  const body = panelEl.querySelector('.panel-body');
  if (body) body.scrollTop = scroll;
  if (!was) return;
  const target = was[0] === 'grip' ? panelEl.querySelector('.panel-grip')
    : [...panelEl.querySelectorAll('[data-action]')].find((el) => el.dataset.action === was[0] && el.dataset.value === was[1]);
  target?.focus();
}

async function fetchDetail(id) {
  try {
    const res = await fetch(`/api/p/${PROJECT_ID}/pr?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    let body = null;
    try {
      body = await res.json();
    } catch {
      // Not JSON: reported by status below.
    }
    if (res.ok && body) return { ok: true, body };
    return { ok: false, error: body?.error || `HTTP ${res.status}` };
  } catch {
    return { ok: false, error: 'the board server is unreachable' };
  }
}

// Starts a request for the open PR. Callers paint; the answer paints itself.
async function loadDetail() {
  if (!panel) return;
  const seq = ++panelSeq;
  const id = panel.id;
  panel = panelLoading(panel, seq);
  const result = await fetchDetail(id);
  panel = panelResult(panel, seq, result);
  paintPanel();
}

function caretOf(id) {
  return [...root.querySelectorAll('.detail-btn')].find((el) => el.dataset.value === id) ?? null;
}

function toggleDetail(id) {
  const pr = snapshot?.prs?.find((p) => p.id === id);
  if (!pr) return;
  const wasOpen = !!panel;
  if (panel?.id === id) {
    closePanel();
    return;
  }
  panel = togglePanel(panel, pr);
  loadDetail();
  draw();
  paintPanel();
  if (!wasOpen) panelEl.querySelector('.panel-close')?.focus();
}

function closePanel() {
  if (!panel) return;
  const { id } = panel;
  panel = null;
  draw();
  paintPanel();
  caretOf(id)?.focus();
}

panelEl.addEventListener('click', (event) => {
  if (event.target.closest('a')) return;
  const el = event.target.closest('[data-action]');
  if (!el || !panel) return;
  switch (el.dataset.action) {
    case 'panel-close': closePanel(); return;
    case 'panel-tab': panel = panelTab(panel, el.dataset.value); break;
    case 'panel-retry': loadDetail(); break;
    default: return;
  }
  paintPanel();
});

// The grip: pointer drag (move and up on window, so a re-render mid-drag doesn't break it),
// double-click to reset, arrow keys while focused.
panelEl.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !event.target.closest('.panel-grip')) return;
  event.preventDefault();
  dragging = true;
  document.body.classList.add('panel-dragging');
});

window.addEventListener('pointermove', (event) => {
  if (dragging) applyWidth(window.innerWidth - event.clientX);
});

function endDrag() {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('panel-dragging');
  setPreferred(panelWidth);
}

window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

panelEl.addEventListener('dblclick', (event) => {
  if (event.target.closest('.panel-grip')) setPreferred(PANEL_DEFAULT_W);
});

panelEl.addEventListener('keydown', (event) => {
  if (!event.target.closest('.panel-grip')) return;
  if (event.key === 'ArrowLeft') setPreferred(panelWidth + WIDTH_STEP);
  else if (event.key === 'ArrowRight') setPreferred(panelWidth - WIDTH_STEP);
  else return;
  event.preventDefault();
});

window.addEventListener('resize', () => applyWidth(preferredWidth));

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !panel) return;
  const t = event.target;
  if (t?.closest?.('input, textarea, select') || t?.isContentEditable) return;
  closePanel();
});

applyWidth(preferredWidth);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') poll();
  else clearTimeout(timer);
});

if (document.visibilityState !== 'hidden') poll();
requestAnimationFrame(frame); // paused by the browser while the tab is hidden
