import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as derive from '../src/derive.js';
import { createView } from '../public/view.js';
import * as fixPrompt from '../public/fix-prompt.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-06T12:00:00Z');
const MATCHERS = JSON.parse(readFileSync(new URL('../projects/example.json', import.meta.url), 'utf8')).tickets;
const ctx = { now: NOW, staleDays: 14, behindWarn: 20, matchers: MATCHERS };
const iso = (ms) => new Date(ms).toISOString();

const REPOS = {
  backend: { host: 'bitbucket', repo: 'acme-backend', repoShort: 'backend' },
  web: { host: 'bitbucket', repo: 'acme-web', repoShort: 'web' },
  shared: { host: 'bitbucket', repo: 'acme-shared', repoShort: 'shared' },
  app: { host: 'github', repo: 'acme-app', repoShort: 'app' },
  api: { host: 'github', repo: 'acme-api', repoShort: 'api' },
  status: { host: 'github', repo: 'acme-status', repoShort: 'status' },
};
const repoList = Object.values(REPOS).map((r) => ({ ...r, repoUrl: `https://example.test/${r.repo}/pulls` }));

let seq = 100;
function makePr(over = {}) {
  const r = REPOS[over.repoShort ?? 'api'];
  const number = over.number ?? ++seq;
  return {
    id: `${r.host}:${r.repo}#${number}`,
    host: r.host,
    repo: r.repo,
    repoShort: r.repoShort,
    repoUrl: `https://example.test/${r.repo}/pulls`,
    number,
    title: `PR ${number}`,
    url: `https://example.test/${r.repo}/pull/${number}`,
    author: { name: 'Ada', id: 'ada' },
    mine: false,
    source: 'feature/x',
    target: 'develop',
    headSha: 'abc',
    draft: false,
    createdAt: iso(NOW - 3 * DAY),
    updatedAt: iso(NOW - DAY),
    ci: 'ok',
    mergeable: 'clean',
    behindBy: 0,
    basePr: undefined,
    locks: [],
    ...over,
  };
}

const raw = [
  // SHOP-42 across 4 repos: 3 ready, backend CI failed.
  makePr({ repoShort: 'shared', number: 215, source: 'feature/SHOP-42-checkout', mine: true, updatedAt: iso(NOW - 2 * DAY) }),
  makePr({ repoShort: 'backend', number: 2504, source: 'feature/SHOP-42-checkout', ci: 'failed', mine: true, updatedAt: iso(NOW - 2 * DAY) }),
  makePr({ repoShort: 'web', number: 3487, source: 'feature/SHOP-42-checkout', updatedAt: iso(NOW - 2 * DAY) }),
  makePr({ repoShort: 'status', number: 42, source: 'feature/SHOP-42-checkout', updatedAt: iso(NOW - 2 * DAY) }),
  // No-ticket PRs sharing a branch: one branch group, app has a conflict.
  makePr({ repoShort: 'app', number: 551, source: 'fix/create-check-followup', mergeable: 'conflict', updatedAt: iso(NOW - 3600_000) }),
  makePr({ repoShort: 'api', number: 600, source: 'fix/create-check-followup', updatedAt: iso(NOW - 7200_000) }),
  // Stacked GitHub PR whose base merged: danger, mine, oldest danger.
  makePr({ repoShort: 'api', number: 610, source: 'feature/SHOP-430-x', target: 'feature/SHOP-429-y', basePr: { number: 605, state: 'merged', url: 'https://example.test/pr/605' }, mine: true, updatedAt: iso(NOW - 5 * DAY) }),
  // Stale: warning.
  makePr({ repoShort: 'api', number: 620, source: 'feature/SHOP-350-ratings', createdAt: iso(NOW - 30 * DAY), updatedAt: iso(NOW - 20 * DAY) }),
  // Plain ready ticket, most recent of all.
  makePr({ repoShort: 'web', number: 3500, source: 'feature/SHOP-600-z', createdAt: iso(NOW - 3600_000), updatedAt: iso(NOW - 600_000) }),
  // A single no-ticket PR → Other PRs.
  makePr({ repoShort: 'web', number: 3499, source: 'chore/bump-deps', author: { name: 'Paul', id: 'paul' } }),
  // A release PR.
  makePr({ repoShort: 'backend', number: 2510, source: 'develop', target: 'staging', title: 'develop > staging' }),
];

function snapshot(over = {}) {
  return {
    project: { id: 'acme', title: 'Acme Shop', hosts: {}, error: null, warnings: [] },
    rate: 'viewed',
    generatedAt: '2026-11-06T11:58:00.000Z',
    refreshing: false,
    intervalSec: 300,
    sources: {
      github: { ok: true, error: null, fetchedAt: '2026-11-06T11:58:00.000Z' },
      bitbucket: { ok: true, error: null, fetchedAt: '2026-11-06T11:58:00.000Z' },
      jira: { ok: true, error: null, fetchedAt: '2026-11-06T11:58:00.000Z' },
    },
    prs: derive.enrich(raw, ctx),
    tickets: {
      'SHOP-42': { label: 'SHOP-42', status: 'In Progress', summary: 'Checkout: PDF + mailbox', url: 'https://jira.example.com/browse/SHOP-42' },
      'SHOP-350': { label: 'SHOP-350', status: 'Done', summary: 'Product ratings', url: 'https://jira.example.com/browse/SHOP-350' },
    },
    repos: repoList,
    ...over,
  };
}

function ui(over = {}) {
  return {
    mine: false,
    view: 'ticket',
    attention: null,
    expandedRepos: new Set(),
    expandedGroups: new Set(),
    releasesOpen: false,
    now: NOW,
    ...over,
  };
}

const view = createView(derive, fixPrompt);
const allRowIds = (vm) => vm.groups.flatMap((g) => g.rows.map((r) => r.id));
const keyOf = (r) => `${r.repoShort}#${r.number}`;

describe('viewModel: ticket view', () => {
  test('groups sorted danger, warning, rest; by most recent update within a tier; Other PRs last', () => {
    const vm = view.viewModel(snapshot(), ui());
    assert.deepEqual(vm.groups.map((g) => `${g.kind}:${g.key}`), [
      'branch:fix/create-check-followup',
      'ticket:SHOP-42',
      'ticket:SHOP-430',
      'ticket:SHOP-350',
      'ticket:SHOP-600',
      'other:Other PRs',
    ]);
  });

  test('branch group has ready/total and severity; Other PRs shows authors', () => {
    const vm = view.viewModel(snapshot(), ui());
    const branch = vm.groups[0];
    assert.equal(branch.total, 2);
    assert.equal(branch.ready, 1);
    assert.equal(branch.severity, 'danger');
    assert.deepEqual(branch.rows.map(keyOf).sort(), ['api#600', 'app#551']);
    const other = vm.groups.at(-1);
    assert.equal(other.total, 1);
    assert.deepEqual(other.rows.map((r) => r.author), ['Paul']);
    assert.equal(vm.groups[1].rows[0].author, null);
  });

  test('ticket group carries Jira status, summary and url; status severity', () => {
    const vm = view.viewModel(snapshot(), ui());
    const f419 = vm.groups.find((g) => g.key === 'SHOP-42');
    assert.equal(f419.summary, 'Checkout: PDF + mailbox');
    assert.equal(f419.status, 'In Progress');
    assert.equal(f419.statusSeverity, 'neutral');
    assert.equal(vm.groups.find((g) => g.key === 'SHOP-350').statusSeverity, 'success');
    const f430 = vm.groups.find((g) => g.key === 'SHOP-430');
    assert.equal(f430.status, null);
    assert.equal(f430.url, null, 'no hardcoded browse fallback');
    assert.equal(f430.label, 'SHOP-430', 'label falls back to the key');
  });

  test('more than 3 rows: ready rows hidden behind "show N more" until expanded', () => {
    let g = view.viewModel(snapshot(), ui()).groups.find((x) => x.key === 'SHOP-42');
    assert.equal(g.total, 4);
    assert.equal(g.ready, 3);
    assert.deepEqual(g.rows.map(keyOf), ['backend#2504']);
    assert.equal(g.hiddenCount, 3);
    assert.equal(g.toggle, 'more');

    g = view.viewModel(snapshot(), ui({ expandedGroups: new Set([g.id]) })).groups.find((x) => x.key === 'SHOP-42');
    assert.equal(g.rows.length, 4);
    assert.equal(g.toggle, 'less');
  });

  test('3 rows or fewer never collapse', () => {
    const vm = view.viewModel(snapshot(), ui());
    for (const g of vm.groups.filter((x) => x.total <= 3)) {
      assert.equal(g.toggle, null);
      assert.equal(g.rows.length, g.total);
    }
  });

  test('all rows ready and more than 3: only the button', () => {
    const prs = derive.enrich([1, 2, 3, 4].map((n) => makePr({ number: 900 + n, source: 'feature/SHOP-700-a' })), ctx);
    const g = view.viewModel(snapshot({ prs }), ui()).groups[0];
    assert.equal(g.rows.length, 0);
    assert.equal(g.hiddenCount, 4);
    assert.equal(g.toggle, 'more');
  });

  test('release PRs go to the releases disclosure, closed by default', () => {
    const vm = view.viewModel(snapshot(), ui());
    assert.equal(vm.releases.count, 1);
    assert.equal(vm.releases.open, false);
    assert.deepEqual(vm.releases.rows.map(keyOf), ['backend#2510']);
    assert.ok(!allRowIds(vm).includes(vm.releases.rows[0].id));
    assert.equal(view.viewModel(snapshot(), ui({ releasesOpen: true })).releases.open, true);
  });

  test('header counts visible non-release PRs', () => {
    const vm = view.viewModel(snapshot(), ui());
    assert.equal(vm.header.openCount, 10);
    assert.equal(vm.header.refreshing, false);
    assert.equal(vm.header.intervalMin, 5);
    assert.match(vm.header.updated, /^\d\d:\d\d$/);
  });
});

describe('viewModel: filters', () => {
  test('Mine keeps only my PRs; groups without PRs disappear', () => {
    const vm = view.viewModel(snapshot(), ui({ mine: true }));
    assert.deepEqual(vm.groups.map((g) => g.key), ['SHOP-42', 'SHOP-430']);
    assert.deepEqual(allRowIds(vm).length, 3);
    assert.equal(vm.header.openCount, 3);
    assert.equal(vm.releases.count, 0);
  });

  test('attention counts use the Mine filter, not the attention filter', () => {
    const all = view.viewModel(snapshot(), ui({ attention: 'ciFailed' }));
    const counts = Object.fromEntries(all.attention.map((c) => [c.name, c.count]));
    assert.deepEqual(counts, { ciFailed: 1, conflicts: 1, stacked: 1, lock: 0, stale: 1 });
    const mine = view.viewModel(snapshot(), ui({ mine: true }));
    const mineCounts = Object.fromEntries(mine.attention.map((c) => [c.name, c.count]));
    assert.deepEqual(mineCounts, { ciFailed: 1, conflicts: 0, stacked: 1, lock: 0, stale: 0 });
  });

  test('attention chips: labels, severity, active state', () => {
    const vm = view.viewModel(snapshot(), ui({ attention: 'stale' }));
    assert.deepEqual(vm.attention.map((c) => [c.name, c.label, c.severity, c.active]), [
      ['ciFailed', 'CI failing', 'danger', false],
      ['conflicts', 'Conflicts', 'danger', false],
      ['stacked', 'Stacked trap', 'danger', false],
      ['lock', 'Lock bump due', 'warning', false],
      ['stale', 'Stale', 'warning', true],
    ]);
  });

  test('attention filter keeps only PRs with that signal, and nothing collapses', () => {
    const vm = view.viewModel(snapshot(), ui({ attention: 'ciFailed' }));
    assert.deepEqual(vm.groups.map((g) => g.key), ['SHOP-42']);
    assert.deepEqual(vm.groups[0].rows.map(keyOf), ['backend#2504']);
    assert.equal(vm.groups[0].toggle, null);

    const prs = derive.enrich([1, 2, 3, 4].map((n) => makePr({ number: 950 + n, source: 'feature/SHOP-701-a', updatedAt: iso(NOW - 20 * DAY) })), ctx);
    const g = view.viewModel(snapshot({ prs }), ui({ attention: 'stale' })).groups[0];
    assert.equal(g.rows.length, 4);
    assert.equal(g.toggle, null);
  });

  test('empty after filtering', () => {
    const prs = derive.enrich([makePr({ number: 1 })], ctx);
    const vm = view.viewModel(snapshot({ prs }), ui({ mine: true }));
    assert.equal(vm.empty, 'No PRs match');
    assert.equal(view.viewModel(snapshot({ prs: [] }), ui()).empty, 'No open PRs');
    assert.equal(view.viewModel(snapshot(), ui()).empty, null);
  });
});

describe('viewModel: rows', () => {
  const rowOf = (prs, number) => {
    const vm = view.viewModel(snapshot({ prs: derive.enrich(prs, ctx) }), ui());
    return vm.groups.flatMap((g) => g.rows).find((r) => r.number === number);
  };
  const chipsOf = (r) => r.chips.map((c) => [c.label, c.severity]);

  test('quiet chips: success signals are hidden when the row has a problem', () => {
    const vm = view.viewModel(snapshot(), ui());
    const stacked = vm.groups.find((g) => g.key === 'SHOP-430').rows[0];
    assert.deepEqual(chipsOf(stacked), [['base merged: retarget', 'danger']]);
  });

  test('quiet chips: a row without problems shows one "ok" chip', () => {
    const vm = view.viewModel(snapshot(), ui());
    const fresh = vm.groups.find((g) => g.key === 'SHOP-600').rows[0];
    assert.deepEqual(chipsOf(fresh), [['ok', 'success']]);
  });

  test('quiet chips: neutral signals stay next to "ok"', () => {
    const r = rowOf([makePr({ number: 900, behindBy: 5 })], 900);
    assert.deepEqual(chipsOf(r), [['ok', 'success'], ['5 behind', 'neutral']]);
  });

  test('quiet chips: CI ok with a conflict shows only the conflict', () => {
    const r = rowOf([makePr({ number: 901, mergeable: 'conflict' })], 901);
    assert.ok(r.chips.every((c) => c.severity !== 'success'), JSON.stringify(r.chips));
    assert.ok(r.chips.some((c) => c.severity === 'danger'));
  });

  test('age is plain text next to the chips, "today" under one day', () => {
    const vm = view.viewModel(snapshot(), ui());
    assert.equal(vm.groups.find((g) => g.key === 'SHOP-430').rows[0].age, '3d');
    assert.equal(vm.groups.find((g) => g.key === 'SHOP-600').rows[0].age, 'today');
  });
});

describe('viewModel: repo view', () => {
  test('one row per repo with open, mine and worst chip; releases excluded', () => {
    const vm = view.viewModel(snapshot(), ui({ view: 'repo' }));
    const rows = Object.fromEntries(vm.repos.map((r) => [r.repoShort, r]));
    assert.deepEqual(vm.repos.map((r) => r.repoShort), ['backend', 'web', 'shared', 'app', 'api', 'status']);
    assert.equal(rows.backend.open, 1);
    assert.equal(rows.backend.mine, 1);
    assert.deepEqual(rows.backend.worst, { label: 'CI failed', severity: 'danger' });
    assert.equal(rows.shared.worst, null);
    assert.deepEqual(rows.api.worst, { label: 'base merged: retarget', severity: 'danger' });
    assert.equal(rows.api.open, 3);
    assert.equal(rows.backend.expanded, false);
    assert.deepEqual(rows.backend.rows, []);
  });

  test('expanded repo lists its PR rows; filters hide repos with no PRs', () => {
    let vm = view.viewModel(snapshot(), ui({ view: 'repo' }));
    const id = vm.repos.find((r) => r.repoShort === 'web').id;
    vm = view.viewModel(snapshot(), ui({ view: 'repo', expandedRepos: new Set([id]) }));
    const web = vm.repos.find((r) => r.repoShort === 'web');
    assert.equal(web.expanded, true);
    assert.deepEqual(web.rows.map(keyOf).sort(), ['web#3487', 'web#3499', 'web#3500']);

    vm = view.viewModel(snapshot(), ui({ view: 'repo', mine: true }));
    assert.deepEqual(vm.repos.map((r) => r.repoShort), ['backend', 'shared', 'api']);
  });
});

describe('viewModel: loading and banners', () => {
  test('loading before the first snapshot', () => {
    const vm = view.viewModel(snapshot({ generatedAt: null, prs: [] }), ui());
    assert.equal(vm.loading, true);
  });

  test('banner per failed source; not-run sources get none', () => {
    const vm = view.viewModel(snapshot({
      sources: {
        github: { ok: false, error: 'rate limited', fetchedAt: '2026-11-06T11:00:00.000Z' },
        bitbucket: { ok: false, error: 'boom', fetchedAt: null },
        jira: { ok: null, error: null, fetchedAt: null },
      },
    }), ui());
    assert.equal(vm.banners.length, 2);
    assert.match(vm.banners[0], /^GitHub: last update \d\d:\d\d · rate limited$/);
    assert.equal(vm.banners[1], 'Bitbucket: no data yet · boom');
  });
});

describe('render', () => {
  const html = view.render(view.viewModel(snapshot(), ui()));

  const rowsOf = (h) => h.split('<div class="pr">').slice(1).map((s) => s.split('</div>')[0]);
  const linkOf = (r) => r.slice(r.indexOf('<a class="pr-link"'), r.indexOf('</a>') + 4);

  test('PR rows are plain containers, never links themselves', () => {
    assert.ok(!html.includes('<a class="pr"'), 'no anchor rows');
    assert.ok(rowsOf(html).length > 0);
  });

  test('PR row link wraps only the logo and ref, opening in a new tab', () => {
    assert.match(html, /<a class="pr-link" href="https:\/\/example\.test\/acme-app\/pull\/551" target="_blank" rel="noopener noreferrer" title="Open app #551 on GitHub">/);
    for (const r of rowsOf(html)) {
      const link = linkOf(r);
      assert.match(link, /^<a class="pr-link"/);
      assert.match(link, /<svg class="logo"/);
      assert.match(link, /<span class="ref">/);
      assert.ok(!link.includes('class="title"'), 'title is outside the link');
      assert.ok(!link.includes('class="chips"'), 'chips are outside the link');
      assert.equal(r.split('<a ').length, 2, 'exactly one link per row');
      assert.match(r, /<span class="title" title="[^"]*">/);
    }
  });

  test('age renders as muted text inside the chips line, not as a chip', () => {
    assert.match(html, /<span class="chips"><span class="chip success">ok<\/span><span class="age">today<\/span><\/span>/);
    assert.ok(!/<span class="chip muted">\d+d<\/span>/.test(html), 'no age chips');
  });

  test('Bitbucket rows say so in the link title', () => {
    assert.match(html, /<a class="pr-link" href="https:\/\/example\.test\/acme-backend\/pull\/2504"[^>]* title="Open backend #2504 on Bitbucket">/);
  });

  test('PR rows have no external-link icon and end with an empty fix column', () => {
    for (const r of rowsOf(html)) {
      assert.ok(!r.includes('icon-ext'), 'no external icon in a PR row');
      assert.match(r, /<span class="fixcol">(<button [^]*<\/button>)?<\/span>$/, 'fixcol is the last child');
    }
  });

  test('Jira key link keeps its external-link icon', () => {
    assert.match(html, /<a class="key" href="https:\/\/jira\.example\.com\/browse\/SHOP-42" target="_blank" rel="noopener noreferrer">SHOP-42<svg class="icon-ext"/);
  });

  test('host logos per host, with titles', () => {
    assert.match(html, /<title>GitHub<\/title>/);
    assert.match(html, /<title>Bitbucket<\/title>/);
  });

  test('ticket header links Jira; branch header has no link', () => {
    assert.match(html, /<a class="key" href="https:\/\/jira\.example\.com\/browse\/SHOP-42" target="_blank" rel="noopener noreferrer">SHOP-42/);
    assert.match(html, /fix\/create-check-followup/);
    assert.ok(!html.includes('browse/fix'));
    assert.match(html, /ready 3 of 4/);
    assert.match(html, /Show 3 more · all mergeable/);
    assert.match(html, /Other PRs/);
    assert.match(html, /Release PRs \(1\)/);
  });

  test('header, toggles and attention chips', () => {
    assert.match(html, /<h1>Acme Shop pull requests<\/h1>/);
    assert.match(html, /10 open/);
    assert.match(html, /updated \d\d:\d\d · every 5 min/);
    assert.match(html, /data-action="mine" data-value="0" aria-pressed="true"/);
    assert.match(html, /data-action="view" data-value="ticket" aria-pressed="true"/);
    assert.match(html, /data-value="ticket" aria-pressed="true">By ticket<\/button>/);
    assert.match(html, /data-action="attention" data-value="lock"[^>]*disabled/);
    assert.match(html, /CI failing <span class="count">1<\/span>/);
  });

  test('header interval follows snapshot.intervalSec', () => {
    const h = view.render(view.viewModel(snapshot({ intervalSec: 60 }), ui()));
    assert.match(h, /every 1 min/);
    assert.doesNotMatch(h, /every 5 min/);
  });

  test('updating… while refreshing', () => {
    const h = view.render(view.viewModel(snapshot({ refreshing: true }), ui()));
    assert.match(h, /updating…/);
    assert.match(h, /class="icon-button spinning"/);
  });

  test('repo view renders a table with expandable rows', () => {
    const vm = view.viewModel(snapshot(), ui({ view: 'repo' }));
    const id = vm.repos[0].id;
    const h = view.render(view.viewModel(snapshot(), ui({ view: 'repo', expandedRepos: new Set([id]) })));
    assert.match(h, /data-action="repo"/);
    assert.match(h, /aria-expanded="true"/);
    assert.match(h, /<a class="repo-link" href="https:\/\/example\.test\/acme-backend\/pulls" target="_blank"/);
    assert.match(h, /<span class="chip muted">none<\/span>/);
  });

  test('loading and empty states', () => {
    assert.match(view.render(view.viewModel(snapshot({ generatedAt: null, prs: [] }), ui())), /Loading…/);
    assert.match(view.render(view.viewModel(snapshot({ prs: [] }), ui())), /No open PRs/);
  });

  test('escapes PR-controlled strings and drops non-http hrefs', () => {
    const evil = makePr({
      number: 666,
      title: '<img src=x onerror=alert(1)>',
      url: 'javascript:alert(1)',
      source: 'fix/"><script>x</script>',
      author: { name: '<b>eve</b>', id: 'eve' },
    });
    const twin = makePr({ number: 667, repoShort: 'app', source: 'fix/"><script>x</script>' });
    const lone = makePr({ number: 668, repoShort: 'web', source: 'chore/a', author: { name: '<b>eve</b>', id: 'eve' } });
    const prs = derive.enrich([evil, twin, lone], ctx);
    const tickets = {};
    const h = view.render(view.viewModel(snapshot({ prs, tickets }), ui({ expandedGroups: new Set() })));
    assert.ok(!h.includes('<img src=x'), 'title escaped');
    assert.ok(h.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(!h.includes('javascript:'), 'javascript: href dropped');
    assert.ok(!h.includes('<script>'), 'branch escaped');
    assert.ok(!h.includes('<b>eve</b>'), 'author escaped');
    assert.ok(h.includes('&quot;&gt;&lt;script&gt;'), 'attribute-safe escaping');
  });
});

describe('fix prompts', () => {
  const FIX_RAW = [
    // SHOP-800: two fixable (one not mine), one stale-only.
    makePr({ repoShort: 'backend', number: 801, source: 'feature/SHOP-800-a', ci: 'failed', title: 'Backend <script>alert(1)</script>', author: { name: 'Paul', id: 'paul' } }),
    makePr({ repoShort: 'app', number: 802, source: 'feature/SHOP-800-a', mergeable: 'conflict', mine: true }),
    makePr({ repoShort: 'api', number: 803, source: 'feature/SHOP-800-a', createdAt: iso(NOW - 30 * DAY), updatedAt: iso(NOW - 20 * DAY) }),
    // Behind-only and stale-only rows.
    makePr({ repoShort: 'web', number: 810, source: 'feature/SHOP-810-b', behindBy: 50 }),
    // Not mine, no author name.
    makePr({ repoShort: 'shared', number: 820, source: 'feature/SHOP-820-c', ci: 'failed', author: null }),
    // Branch group with two fixable warnings? conflict is danger; use two not-mine danger PRs, same author.
    makePr({ repoShort: 'app', number: 830, source: 'fix/two', ci: 'failed', author: { name: 'Eve', id: 'eve' } }),
    makePr({ repoShort: 'api', number: 831, source: 'fix/two', mergeable: 'conflict', author: { name: 'Eve', id: 'eve' } }),
    // Other PRs: two single no-ticket fixable PRs.
    makePr({ repoShort: 'web', number: 840, source: 'chore/one', ci: 'failed' }),
    makePr({ repoShort: 'shared', number: 841, source: 'chore/two', ci: 'failed' }),
  ];
  const snap = () => snapshot({ prs: derive.enrich(FIX_RAW, ctx), tickets: {} });
  const fui = (over = {}) => ui({ fixOpen: new Set(), copied: null, ...over });
  const vmOf = (over) => view.viewModel(snap(), fui(over));
  const rows = (vm) => vm.groups.flatMap((g) => g.rows);
  const row = (vm, n) => rows(vm).find((r) => r.number === n);
  const group = (vm, key) => vm.groups.find((g) => g.key === key);
  const idOf = (n) => derive.enrich(FIX_RAW, ctx).find((p) => p.number === n).id;

  test('rows get fix only with fixable signals; severity from the signals', () => {
    const vm = vmOf();
    assert.equal(row(vm, 801).fix.severity, 'danger');
    assert.equal(row(vm, 801).fix.open, false);
    assert.equal(row(vm, 801).fix.prompt, undefined);
    assert.equal(row(vm, 803).fix, null, 'stale only');
    assert.equal(row(vm, 810).fix, null, 'behind only');
  });

  test('lock-pinned only is a warning', () => {
    const pr = makePr({ repoShort: 'backend', number: 850, source: 'feature/SHOP-850-x' });
    const [e] = derive.enrich([pr], ctx);
    e.signals = [{ kind: 'lock-pinned', severity: 'warning', label: 'pkg pinned' }];
    const vm = view.viewModel(snapshot({ prs: [e], tickets: {} }), fui());
    assert.equal(vm.groups[0].rows[0].fix.severity, 'warning');
    assert.match(view.render(vm), /class="fix-btn warning"/);
  });

  test('row owner: name when not mine, null name without author, null when mine', () => {
    const vm = vmOf();
    assert.deepEqual(row(vm, 801).fix.owner, { name: 'Paul' });
    assert.deepEqual(row(vm, 820).fix.owner, { name: null });
    assert.equal(row(vm, 802).fix.owner, null);
  });

  test('drawer id sanitises the key', () => {
    const vm = vmOf();
    assert.equal(row(vm, 801).fix.drawerId, 'fix-bitbucket-acme-backend-801');
    assert.equal(group(vm, 'fix/two').fix.drawerId, 'fix-b-fix-two');
  });

  test('open row carries the prompt; fixPrompts has exactly the open keys', () => {
    const k = idOf(801);
    const vm = vmOf({ fixOpen: new Set([k, 'b:fix/two', 'not-there']) });
    assert.equal(row(vm, 801).fix.open, true);
    assert.equal(row(vm, 801).fix.prompt, fixPrompt.promptFor(derive.enrich(FIX_RAW, ctx).find((p) => p.number === 801), {}));
    assert.deepEqual(Object.keys(vm.fixPrompts).sort(), [k, 'b:fix/two'].sort());
    assert.equal(vm.fixPrompts[k], row(vm, 801).fix.prompt);
    assert.equal(vm.fixPrompts['b:fix/two'], group(vm, 'fix/two').fix.prompt);
    assert.deepEqual(vmOf().fixPrompts, {});
  });

  test('group Fix all: 2+ fixable PRs, never Other PRs, respects the attention filter', () => {
    const vm = vmOf();
    const f800 = group(vm, 'SHOP-800');
    assert.equal(f800.fix.count, 2);
    assert.equal(f800.fix.severity, 'danger');
    assert.equal(group(vm, 'SHOP-820').fix, null, 'one fixable PR');
    assert.equal(group(vm, 'fix/two').fix.count, 2);
    assert.equal(vm.groups.find((g) => g.kind === 'other').fix, null);
    const filtered = vmOf({ attention: 'ciFailed' });
    assert.equal(group(filtered, 'SHOP-800').fix, null);
  });

  test('group prompt is the bundle of its fixable PRs', () => {
    const vm = vmOf({ fixOpen: new Set(['f:SHOP-800']) });
    // In the group's (board) order: the bundle keeps it within a tier.
    const byNumber = new Map(derive.enrich(FIX_RAW, ctx).map((p) => [p.number, p]));
    const prs = group(vm, 'SHOP-800').rows.map((r) => byNumber.get(r.number));
    assert.equal(group(vm, 'SHOP-800').fix.prompt, fixPrompt.bundlePrompt(prs, 'SHOP-800', {}));
  });

  test('prompts get snapshot.fix as ctx', () => {
    const fix = { fixPrompts: { group: 'Group rule.', 'ci-failed': 'CI rule.' }, fixNotes: { all: 'My note.' } };
    const k = idOf(801);
    const vm = view.viewModel({ ...snap(), fix }, fui({ fixOpen: new Set([k, 'f:SHOP-800']) }));
    const pr = derive.enrich(FIX_RAW, ctx).find((p) => p.number === 801);
    assert.equal(row(vm, 801).fix.prompt, fixPrompt.promptFor(pr, fix));
    assert.match(row(vm, 801).fix.prompt, /Project convention: CI rule\.[\s\S]*My setup: My note\.$/);
    assert.match(group(vm, 'SHOP-800').fix.prompt, /\nProject convention: Group rule\.\n/);
  });

  test('group owners', () => {
    const vm = vmOf();
    assert.deepEqual(group(vm, 'SHOP-800').fix.owners, { notMine: 1, total: 2, names: ['Paul'] });
    assert.deepEqual(group(vm, 'fix/two').fix.owners, { notMine: 2, total: 2, names: ['Eve'] });
    const mine = derive.enrich([801, 802].map((n) => makePr({ number: n, source: 'feature/SHOP-860-a', ci: 'failed', mine: true })), ctx);
    assert.equal(view.viewModel(snapshot({ prs: mine, tickets: {} }), fui()).groups[0].fix.owners, null);
  });

  describe('render', () => {
    const btnRe = (id) => new RegExp(`<button type="button" class="fix-btn (danger|warning)" data-action="fix" data-value="${id}" aria-expanded="(true|false)" aria-controls="([^"]+)" title="Show a fix prompt for Claude"><svg class="icon-wand"[^]*?</svg>Fix</button>`);

    test('Fix button only on fixable rows, closed by default, no drawer', () => {
      const h = view.render(vmOf());
      const m = h.match(btnRe(idOf(801)));
      assert.ok(m, 'row button');
      assert.equal(m[1], 'danger');
      assert.equal(m[2], 'false');
      assert.equal(m[3], 'fix-bitbucket-acme-backend-801');
      assert.ok(!h.includes(`data-value="${idOf(803)}"`), 'stale-only row has no button');
      assert.ok(!h.includes(`data-value="${idOf(810)}"`), 'behind-only row has no button');
      assert.ok(!h.includes('class="fix-drawer"'));
    });

    test('open row: aria-expanded true and drawer right after the row with escaped prompt', () => {
      const h = view.render(vmOf({ fixOpen: new Set([idOf(801)]) }));
      assert.equal(h.match(btnRe(idOf(801)))[2], 'true');
      assert.match(h, /<span class="fixcol"><button [^]*?<\/button><\/span><\/div><div class="fix-drawer" id="fix-bitbucket-acme-backend-801">/);
      const drawer = h.slice(h.indexOf('<div class="fix-drawer"'));
      assert.match(drawer, /<pre class="fix-prompt">Fix backend #801/);
      assert.ok(drawer.includes('Title: Backend &lt;script&gt;alert(1)&lt;/script&gt;'));
      assert.ok(!h.includes('<script>'));
      assert.match(drawer, /<div class="fix-bar"><span class="fix-bar-label">Prompt for Claude<\/span><button type="button" class="fix-copy" data-action="fix-copy" data-value="[^"]+"><svg class="icon-copy"[^]*?<\/svg>Copy prompt<\/button><\/div>/);
    });

    test('owner warning with name, fallback without, none for mine', () => {
      const h = view.render(vmOf({ fixOpen: new Set([idOf(801), idOf(820), idOf(802)]) }));
      const drawerOf = (n) => {
        const id = `fix-${idOf(n).replace(/[^A-Za-z0-9_-]/g, '-')}`;
        const start = h.indexOf(`<div class="fix-drawer" id="${id}">`);
        return h.slice(start, h.indexOf('</pre>', start));
      };
      assert.match(drawerOf(801), /<div class="fix-owner" role="note"><svg class="icon-alert"[^]*?<\/svg><span><strong>Not your PR\.<\/strong> Paul owns it\. Fixing it is an intrusive action: discuss it with Paul before you push anything\.<\/span><\/div>/);
      assert.match(drawerOf(820), /<strong>Not your PR\.<\/strong> Fixing someone else's PR is an intrusive action: discuss it with the owner before you push anything\./);
      assert.ok(!drawerOf(802).includes('fix-owner'));
    });

    test('owner name is escaped', () => {
      const [e] = derive.enrich([makePr({ number: 870, source: 'feature/SHOP-870-a', ci: 'failed', author: { name: '<b>eve</b>', id: 'e' } })], ctx);
      const h = view.render(view.viewModel(snapshot({ prs: [e], tickets: {} }), fui({ fixOpen: new Set([e.id]) })));
      assert.ok(!h.includes('<b>eve</b>'));
      assert.ok(h.includes('&lt;b&gt;eve&lt;/b&gt; owns it'));
    });

    test('group Fix all N sits right before the ready text; drawer at the top of rows', () => {
      const h = view.render(vmOf({ fixOpen: new Set(['f:SHOP-800']) }));
      assert.match(h, /<button type="button" class="fix-btn danger" data-action="fix" data-value="f:SHOP-800" aria-expanded="true" aria-controls="fix-f-SHOP-800" title="Show a fix prompt for Claude"><svg class="icon-wand"[^]*?<\/svg>Fix all 2<\/button><span class="ready/);
      assert.match(h, /<div class="rows"><div class="fix-drawer" id="fix-f-SHOP-800">/);
      assert.match(h, /<pre class="fix-prompt">Unblock the PRs of SHOP-800/);
      assert.ok(!/Fix all \d<\/button><\/div>[^]*Other PRs/.test(h.slice(h.indexOf('Other PRs'))));
      assert.equal((h.match(/Fix all/g) ?? []).length, 2, 'SHOP-800 and fix/two only');
    });

    test('group owner warning: singular and plural', () => {
      const h = view.render(vmOf({ fixOpen: new Set(['f:SHOP-800', 'b:fix/two']) }));
      assert.ok(h.includes("<strong>1 of these 2 PRs isn't yours</strong> (Paul). Fixing them is an intrusive action: discuss it with the owner before you push anything."));
      assert.ok(h.includes("<strong>2 of these 2 PRs aren't yours</strong> (Eve). Fixing them is an intrusive action: discuss it with the owners before you push anything."));
    });

    test('group owner warning without names omits the parentheses', () => {
      const prs = derive.enrich([880, 881].map((n) => makePr({ number: n, source: 'feature/SHOP-880-a', ci: 'failed', author: null })), ctx);
      const h = view.render(view.viewModel(snapshot({ prs, tickets: {} }), fui({ fixOpen: new Set(['f:SHOP-880']) })));
      assert.ok(h.includes("<strong>2 of these 2 PRs aren't yours</strong>. Fixing them"));
    });

    test('copy button states', () => {
      const k = idOf(801);
      const ok = view.render(vmOf({ fixOpen: new Set([k]), copied: { key: k, ok: true } }));
      assert.match(ok, /<button type="button" class="fix-copy ok" data-action="fix-copy" data-value="[^"]+"><svg class="icon-check"[^]*?<\/svg>Copied<\/button>/);
      const bad = view.render(vmOf({ fixOpen: new Set([k]), copied: { key: k, ok: false } }));
      assert.match(bad, /<button type="button" class="fix-copy failed"[^>]*>[^]*?Copy failed<\/button>/);
      const other = view.render(vmOf({ fixOpen: new Set([k]), copied: { key: 'b:fix/two', ok: true } }));
      assert.match(other, /class="fix-copy" [^>]*>[^]*?Copy prompt<\/button>/);
    });

    test('repo view: no group buttons, rows still get Fix', () => {
      const vm = vmOf({ view: 'repo' });
      const id = vm.repos.find((r) => r.repoShort === 'backend').id;
      const h = view.render(vmOf({ view: 'repo', expandedRepos: new Set([id]) }));
      assert.ok(!h.includes('Fix all'));
      assert.match(h, btnRe(idOf(801)));
    });
  });
});

describe('page: projects, header, banners and Tickets', () => {
  const summary = (over = {}) => ({ id: 'acme', title: 'Acme Shop', count: 0, ageMin: 0, rate: 'viewed', error: null, warnings: [], ...over });
  const board = (projects, over = {}) => ({ projects, error: null, warnings: [], configDir: '/home/ada/.config/pr-board', ...over });
  const two = () => board([
    summary({ count: 2 }),
    summary({ id: 'nova', title: 'Nova Labs', count: 0, ageMin: 40, rate: 'hourly' }),
  ]);
  const navOf = (h) => {
    const start = h.indexOf('<nav class="projects"');
    return start < 0 ? '' : h.slice(start, h.indexOf('</nav>', start) + 6);
  };
  const tabOf = (h, id) => {
    const nav = navOf(h);
    const start = nav.indexOf(`<a class="tab`, nav.indexOf(`href="/p/${id}"`) - 40);
    return nav.slice(start, nav.indexOf('</a>', start) + 4);
  };

  describe('tabs', () => {
    test('only with two or more projects', () => {
      assert.equal(view.viewModel(snapshot(), ui(), board([summary()])).tabs, null);
      assert.equal(view.viewModel(snapshot(), ui()).tabs, null, 'no board yet');
      assert.equal(navOf(view.render(view.viewModel(snapshot(), ui(), board([summary()])))), '');
      const h = view.render(view.viewModel(snapshot(), ui(), two()));
      assert.match(h, /^<nav class="projects" aria-label="Projects">/, 'tabs come before the header');
      assert.equal((navOf(h).match(/<a class="tab/g) ?? []).length, 2);
    });

    test('Title (N), with (N) hidden at 0; each tab links to its project', () => {
      const h = view.render(view.viewModel(snapshot(), ui(), two()));
      assert.match(tabOf(h, 'acme'), /^<a class="tab" href="\/p\/acme" aria-current="page">Acme Shop \(2\)<\/a>$/);
      assert.match(tabOf(h, 'nova'), /^<a class="tab" href="\/p\/nova">Nova Labs<span class="tab-age">/);
    });

    test('age only on the hourly rate; <1 min below one minute', () => {
      const tabs = view.viewModel(snapshot(), ui(), board([
        summary({ ageMin: 40, rate: 'viewed' }),
        summary({ id: 'nova', ageMin: 40, rate: 'hourly' }),
        summary({ id: 'zeta', ageMin: 0, rate: 'hourly' }),
        summary({ id: 'idle', ageMin: 12, rate: 'paused' }),
        summary({ id: 'none', ageMin: null, rate: 'hourly' }),
      ])).tabs;
      assert.deepEqual(tabs.map((t) => t.age), [null, '40 min', '<1 min', null, null]);
      const h = view.render(view.viewModel(snapshot(), ui(), two()));
      assert.match(tabOf(h, 'nova'), /Nova Labs<span class="tab-age">· 40 min<\/span><\/a>$/);
      assert.ok(!tabOf(h, 'acme').includes('tab-age'));
    });

    test('a project with an error gets the warning mark and a hidden label', () => {
      const b = board([summary(), summary({ id: 'broken', title: 'broken', error: '/x/broken.json: Missing required key `hosts`' })]);
      const h = view.render(view.viewModel(snapshot(), ui(), b));
      assert.equal(tabOf(h, 'broken'), '<a class="tab has-error" href="/p/broken">broken<span class="tab-mark" aria-hidden="true">!</span><span class="visually-hidden"> (error)</span></a>');
      assert.ok(!tabOf(h, 'acme').includes('has-error'));
    });

    test('aria-current marks the viewed project only', () => {
      const tabs = view.viewModel(snapshot({ project: { ...snapshot().project, id: 'nova', title: 'Nova Labs' } }), ui(), two()).tabs;
      assert.deepEqual(tabs.map((t) => [t.id, t.current]), [['acme', false], ['nova', true]]);
      const h = view.render(view.viewModel(snapshot(), ui(), two()));
      assert.equal((navOf(h).match(/aria-current="page"/g) ?? []).length, 1);
    });

    test('titles are escaped', () => {
      const b = board([summary({ title: '<b>x</b>' }), summary({ id: 'nova' })]);
      const h = view.render(view.viewModel(snapshot(), ui(), b));
      assert.ok(!navOf(h).includes('<b>x</b>'));
      assert.ok(navOf(h).includes('&lt;b&gt;x&lt;/b&gt;'));
    });
  });

  describe('header', () => {
    test('project title in the h1 and the document title', () => {
      const vm = view.viewModel(snapshot(), ui());
      assert.equal(vm.title, 'Acme Shop pull requests');
      assert.match(view.render(vm), /<h1>Acme Shop pull requests<\/h1>/);
      const evil = view.render(view.viewModel(snapshot({ project: { ...snapshot().project, title: '<i>x</i>' } }), ui()));
      assert.match(evil, /<h1>&lt;i&gt;x&lt;\/i&gt; pull requests<\/h1>/);
    });

    test('"every 5 min" on the viewed rate, "hourly" on the hourly rate', () => {
      assert.match(view.render(view.viewModel(snapshot(), ui())), /<p class="meta">updated \d\d:\d\d · every 5 min<\/p>/);
      const hourly = view.render(view.viewModel(snapshot({ rate: 'hourly' }), ui()));
      assert.match(hourly, /<p class="meta">updated \d\d:\d\d · hourly<\/p>/);
      assert.doesNotMatch(hourly, /every \d+ min/);
    });
  });

  describe('banners', () => {
    const broken = () => snapshot({
      project: { id: 'broken', title: 'broken', hosts: {}, error: '/x/broken.json: Missing required key `hosts`\nsecond line', warnings: [] },
      generatedAt: null,
      prs: [],
    });

    test('a project error replaces the content', () => {
      const vm = view.viewModel(broken(), ui());
      assert.equal(vm.projectError, '/x/broken.json: Missing required key `hosts`\nsecond line');
      const h = view.render(vm);
      assert.match(h, /<h1>broken pull requests<\/h1>/);
      assert.match(h, /<div class="banner error" role="status"><strong>This project can't run\.<\/strong><div class="banner-text">\/x\/broken\.json: Missing required key <code>hosts<\/code>\nsecond line<\/div><\/div>/);
      assert.ok(!h.includes('class="attention"'), 'no attention row');
      assert.ok(!h.includes('class="board"'), 'no groups');
      assert.ok(!h.includes('Loading…'));
      assert.ok(!h.includes('open-count'));
    });

    test('a board error shows on project pages too', () => {
      const h = view.render(view.viewModel(snapshot(), ui(), board([summary()], { error: '/c/config.json: Invalid JSON' })));
      assert.match(h, /<div class="banner error" role="status"><strong>The board can't run\.<\/strong><div class="banner-text">\/c\/config\.json: Invalid JSON<\/div><\/div>/);
    });

    test('warnings: one muted list right under the attention row, backticks as code, escaped', () => {
      const warnings = ['config.json: Unknown key `colour`', 'acme.json: <b>bold</b> `a<b>`'];
      const vm = view.viewModel(snapshot({ project: { ...snapshot().project, warnings } }), ui());
      assert.deepEqual(vm.warnings, warnings);
      const h = view.render(vm);
      assert.match(h, /<\/nav><ul class="warnings"><li>config\.json: Unknown key <code>colour<\/code><\/li><li>acme\.json: &lt;b&gt;bold&lt;\/b&gt; <code>a&lt;b&gt;<\/code><\/li><\/ul>/);
      assert.ok(!view.render(view.viewModel(snapshot(), ui())).includes('class="warnings"'), 'no list without warnings');
    });
  });

  describe('Ticket groups', () => {
    const TRELLO = 'https://trello.com/c/AbC123';
    const prs = () => derive.enrich([
      makePr({ number: 960, source: 'feature/SHOP-960-a' }),
      makePr({ number: 961, source: 'feature/OPS-7-b' }),
      makePr({ number: 962, source: 'fix/login', description: `See ${TRELLO}/95-fix-login` }),
    ], ctx);
    const tickets = {
      'SHOP-960': { label: 'SHOP-960', url: 'https://jira.example.com/browse/SHOP-960', status: 'In Review', summary: 'Jira summary' },
      'OPS-7': { label: 'OPS-7', url: null, status: null, summary: 'not shown' },
      [TRELLO]: { label: '#95', url: TRELLO, status: null, summary: null },
    };
    const headOf = (h, label) => {
      const start = h.lastIndexOf('<div class="group-head">', h.indexOf(`>${label}`));
      return h.slice(start, h.indexOf('</div>', start));
    };

    test('label as a link with the external icon; Jira summary and status only with a status', () => {
      const vm = view.viewModel(snapshot({ prs: prs(), tickets }), ui());
      const g = Object.fromEntries(vm.groups.map((x) => [x.key, x]));
      assert.equal(g[TRELLO].label, '#95');
      assert.equal(g['OPS-7'].summary, null, 'no summary without a status');
      const h = view.render(vm);
      assert.match(headOf(h, 'SHOP-960'), /^<div class="group-head"><a class="key" href="https:\/\/jira\.example\.com\/browse\/SHOP-960" target="_blank" rel="noopener noreferrer">SHOP-960<svg class="icon-ext"[^]*?<\/svg><\/a><span class="summary" title="Jira summary">Jira summary<\/span><span class="chip neutral">In Review<\/span>/);
      assert.match(headOf(h, '#95'), /^<div class="group-head"><a class="key" href="https:\/\/trello\.com\/c\/AbC123" target="_blank" rel="noopener noreferrer">#95<svg class="icon-ext"[^]*?<\/svg><\/a><span class="summary"><\/span><span class="ready/);
    });

    test('no url: plain text label, never a guessed link', () => {
      const h = view.render(view.viewModel(snapshot({ prs: prs(), tickets }), ui()));
      assert.match(headOf(h, 'OPS-7'), /^<div class="group-head"><span class="key">OPS-7<\/span><span class="summary"><\/span><span class="ready/);
      assert.ok(!h.includes('browse/OPS-7'));
      assert.ok(!h.includes('not shown'));
    });

    test('fix drawers use snapshot.fix and the Ticket label', () => {
      const raw2 = [960, 961].map((n) => makePr({ number: n, source: 'fix/login', ci: 'failed', description: `${TRELLO}/95-fix-login` }));
      const enriched = derive.enrich(raw2, ctx);
      const fix = { fixPrompts: { group: 'Group rule.' } };
      const vm = view.viewModel(snapshot({ prs: enriched, tickets, fix }), ui({ fixOpen: new Set([`f:${TRELLO}`, enriched[0].id]) }));
      const g = vm.groups.find((x) => x.key === TRELLO);
      assert.equal(g.fix.prompt, fixPrompt.bundlePrompt(g.rows.map((r) => enriched.find((p) => p.id === r.id)), '#95', fix));
      assert.equal(g.rows.find((r) => r.id === enriched[0].id).fix.prompt, fixPrompt.promptFor(enriched[0], fix));
    });
  });

  describe('states', () => {
    test('no projects: one card with the config path', () => {
      const vm = view.stateModel(board([]), null);
      assert.equal(vm.title, 'Pull requests');
      assert.equal(view.render(vm), '<div class="card state">No projects yet.<br>Add one in <code>/home/ada/.config/pr-board/config.json</code>. The README shows how.</div>');
    });

    test('no projects on Windows: the config path keeps backslashes', () => {
      const h = view.render(view.stateModel(board([], { configDir: 'C:\\Users\\ada\\AppData\\Roaming\\pr-board' }), null));
      assert.ok(h.includes('<code>C:\\Users\\ada\\AppData\\Roaming\\pr-board\\config.json</code>'), h);
    });

    test('a board error replaces the no-projects card', () => {
      const h = view.render(view.stateModel(board([], { error: '/c/config.json: Invalid JSON' }), null));
      assert.match(h, /^<div class="banner error" role="status"><strong>The board can't run\.<\/strong>/);
      assert.ok(!h.includes('No projects yet'));
    });

    test('unknown project: the id and links to every project', () => {
      const vm = view.stateModel(two(), 'gone');
      assert.equal(view.render(vm), '<div class="card state">Unknown project <code>gone</code>.<br><a href="/p/acme">Acme Shop</a>, <a href="/p/nova">Nova Labs</a></div>');
      assert.ok(!view.render(view.stateModel(two(), '<x>')).includes('<x>'), 'id escaped');
    });
  });
});
