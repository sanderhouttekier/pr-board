import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ticketKey,
  ticketsFor,
  isMainBranch,
  isRelease,
  signals,
  worst,
  isReady,
  enrich,
  groupByTicket,
  groupByRepo,
  attentionCounts,
  ATTENTION,
} from '../src/derive.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-06T12:00:00Z');
const MATCHERS = JSON.parse(readFileSync(new URL('../projects/example.json', import.meta.url), 'utf8')).tickets;
const ctx = { now: NOW, staleDays: 14, behindWarn: 20, matchers: MATCHERS };
const iso = (ms) => new Date(ms).toISOString();

const REPOS = {
  backend: { host: 'bitbucket', repo: 'acme-backend', repoShort: 'backend' },
  web: { host: 'bitbucket', repo: 'acme-web', repoShort: 'web' },
  worker: { host: 'bitbucket', repo: 'acme-worker', repoShort: 'worker' },
  shared: { host: 'bitbucket', repo: 'acme-shared', repoShort: 'shared' },
  api: { host: 'github', repo: 'acme-api', repoShort: 'api' },
  status: { host: 'github', repo: 'acme-status', repoShort: 'status' },
};
const repoList = Object.values(REPOS).map((r) => ({ ...r, repoUrl: `https://example.test/${r.repo}/pulls` }));

let seq = 1000;
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
    title: 'Some change',
    url: `https://example.test/${r.repo}/pull/${number}`,
    author: { name: 'Ada', id: 'ada' },
    mine: true,
    source: 'feature/SHOP-1-thing',
    target: 'develop',
    headSha: 'abc123',
    draft: false,
    createdAt: iso(NOW - 2 * DAY),
    updatedAt: iso(NOW - DAY),
    ci: 'ok',
    mergeable: 'clean',
    behindBy: 0,
    basePr: undefined,
    locks: [],
    ...over,
  };
}

const kinds = (sigs) => sigs.map((s) => s.kind);
const find = (sigs, kind) => sigs.find((s) => s.kind === kind);

describe('ticketKey: prefix matchers', () => {
  const shop = (key) => ({ key, label: key, url: `https://jira.example.com/browse/${key}`, jiraSite: 'main' });
  const ops = (key) => ({ key, label: key, url: null, jiraSite: null });
  const cases = [
    ['SHOP-42 in a branch', { source: 'feature/SHOP-42-checkout' }, shop('SHOP-42')],
    ['SHOP 42 (space)', { source: 'SHOP 42 checkout' }, shop('SHOP-42')],
    ['shop_42 (underscore, lowercase)', { source: 'shop_42' }, shop('SHOP-42')],
    ['SHOP42 (no separator)', { source: 'SHOP42' }, shop('SHOP-42')],
    ['digits kept as written', { source: 'feat/SHOP-042' }, shop('SHOP-042')],
    ['boundary: xSHOP-42 does not match', { source: 'xSHOP-42', title: 'x' }, null],
    ['boundary: feat/shop_42 matches', { source: 'feat/shop_42' }, shop('SHOP-42')],
    ['boundary: _ before the prefix counts', { source: 'feat_SHOP-42' }, shop('SHOP-42')],
    ['no trailing digit run: SHOP-42 followed by a letter is fine', { source: 'SHOP-42abc' }, shop('SHOP-42')],
    ['no partial digit run', { source: '1SHOP-42', title: 'x' }, null],
    ['branch wins over title', { source: 'feature/SHOP-1', title: 'OPS-2 thing' }, shop('SHOP-1')],
    ['falls back to title', { source: 'hotfix/ssr', title: 'OPS-394: SSR scanner load' }, ops('OPS-394')],
    ['leftmost across prefixes', { source: 'fix/ops-12-after-SHOP-7' }, ops('OPS-12')],
    ['leftmost across prefixes, other order', { source: 'fix/SHOP-7-then-ops-12' }, shop('SHOP-7')],
    ['#42 never matches', { source: 'fix/#42', title: '#42 fix' }, null],
    ['bare number never matches', { source: '42-fix', title: '42' }, null],
    ['no key', { source: 'chore/bump-deps', title: 'Bump deps' }, null],
  ];
  for (const [name, over, expected] of cases) {
    test(name, () => assert.deepEqual(ticketKey(makePr({ title: 'Some change', ...over }), MATCHERS), expected));
  }

  test('no matchers → null', () => {
    assert.equal(ticketKey(makePr({ source: 'feature/SHOP-42' }), []), null);
    assert.equal(ticketKey(makePr({ source: 'feature/SHOP-42' })), null);
  });

  test('regex characters in a prefix are literal', () => {
    const m = [{ prefix: 'A.B', browse: null }];
    assert.equal(ticketKey(makePr({ source: 'A.B-1' }), m)?.key, 'A.B-1');
    assert.equal(ticketKey(makePr({ source: 'AxB-1', title: 'x' }), m), null);
  });
});

describe('ticketKey: link matchers', () => {
  const nokey = { source: 'chore/stuff', title: 'Stuff' };
  const cases = [
    ['key URL and #N label from the next segment',
      'See https://trello.com/c/AbC123/95-fix-login for context',
      { key: 'https://trello.com/c/AbC123', label: '#95', url: 'https://trello.com/c/AbC123', jiraSite: null }],
    ['id segment as label without leading digits',
      'Card: https://trello.com/c/AbC123/fix-login',
      { key: 'https://trello.com/c/AbC123', label: 'AbC123', url: 'https://trello.com/c/AbC123', jiraSite: null }],
    ['id segment as label with no next segment',
      '(https://trello.com/c/AbC123)',
      { key: 'https://trello.com/c/AbC123', label: 'AbC123', url: 'https://trello.com/c/AbC123', jiraSite: null }],
    ['first matching URL in the description',
      'Docs https://example.com/x then https://trello.com/c/First1/7-a and https://trello.com/c/Second2/8-b',
      { key: 'https://trello.com/c/First1', label: '#7', url: 'https://trello.com/c/First1', jiraSite: null }],
    ['markdown link', '[card](https://trello.com/c/Zz9/12-thing)',
      { key: 'https://trello.com/c/Zz9', label: '#12', url: 'https://trello.com/c/Zz9', jiraSite: null }],
    ['query string ends the id segment', 'https://trello.com/c/Q1w2?filter=x',
      { key: 'https://trello.com/c/Q1w2', label: 'Q1w2', url: 'https://trello.com/c/Q1w2', jiraSite: null }],
    ['no id segment → no match', 'https://trello.com/c/', null],
    ['no matching URL', 'https://example.com/c/AbC123', null],
    ['null description', null, null],
  ];
  for (const [name, description, expected] of cases) {
    test(name, () => assert.deepEqual(ticketKey(makePr({ ...nokey, description }), MATCHERS), expected));
  }

  test('a prefix beats a link', () => {
    const pr = makePr({ source: 'feature/SHOP-42', description: 'https://trello.com/c/AbC123/95-x' });
    assert.equal(ticketKey(pr, MATCHERS).key, 'SHOP-42');
  });

  test('link matchers in file order', () => {
    const m = [{ link: 'tracker.example.com/t/' }, { link: 'trello.com/c/' }];
    const pr = makePr({ ...nokey, description: 'https://trello.com/c/A1/1-a https://tracker.example.com/t/B2/2-b' });
    assert.equal(ticketKey(pr, m).key, 'https://tracker.example.com/t/B2');
  });
});

describe('ticketsFor', () => {
  test('tickets skeleton and Jira keys per site, from raw PRs', () => {
    const prs = [
      makePr({ source: 'feature/SHOP-42-a' }),
      makePr({ source: 'feature/SHOP-42-b' }),
      makePr({ source: 'fix/OPS-7' }),
      makePr({ source: 'feature/SHOP-9' }),
      makePr({ source: 'chore/x', title: 'x', description: 'https://trello.com/c/AbC123/95-fix' }),
      makePr({ source: 'chore/y', title: 'y', description: null }),
    ];
    assert.deepEqual(ticketsFor(prs, MATCHERS), {
      tickets: {
        'SHOP-42': { label: 'SHOP-42', url: 'https://jira.example.com/browse/SHOP-42', status: null, summary: null },
        'OPS-7': { label: 'OPS-7', url: null, status: null, summary: null },
        'SHOP-9': { label: 'SHOP-9', url: 'https://jira.example.com/browse/SHOP-9', status: null, summary: null },
        'https://trello.com/c/AbC123': { label: '#95', url: 'https://trello.com/c/AbC123', status: null, summary: null },
      },
      jiraKeys: { main: ['SHOP-42', 'SHOP-9'] },
    });
  });

  test('no matchers → empty', () => {
    assert.deepEqual(ticketsFor([makePr()], undefined), { tickets: {}, jiraKeys: {} });
  });
});

describe('isMainBranch', () => {
  const cases = [
    ['develop', 'develop', undefined, true],
    ['main', 'main', 'develop', true],
    ['master', 'master', null, true],
    ['staging', 'staging', undefined, true],
    ['acceptance', 'acceptance', undefined, true],
    ['the default branch', 'trunk', 'trunk', true],
    ['a feature branch', 'feature/x', 'trunk', false],
    ['not the default', 'trunk', 'develop', false],
  ];
  for (const [name, branch, def, expected] of cases) {
    test(name, () => assert.equal(isMainBranch(branch, def), expected));
  }
});

describe('isRelease', () => {
  const cases = [
    ['develop → staging', { source: 'develop', target: 'staging' }, true],
    ['staging → main', { source: 'staging', target: 'main' }, true],
    ['acceptance → master', { source: 'acceptance', target: 'master' }, true],
    ['title "Develop > staging"', { source: 'release/2026-11', target: 'staging', title: 'Develop > staging' }, true],
    ['title "acceptance >main"', { source: 'x', target: 'y', title: 'acceptance >main' }, true],
    ['feature → develop', { source: 'feature/SHOP-1', target: 'develop' }, false],
    ['default branch → main', { source: 'trunk', target: 'main', defaultBranch: 'trunk' }, true],
    ['trunk → main without trunk as default', { source: 'trunk', target: 'main', defaultBranch: 'develop' }, false],
    ['title mentions develop mid-sentence', { source: 'feature/SHOP-1', target: 'develop', title: 'Fix develop > staging script' }, false],
  ];
  for (const [name, over, expected] of cases) {
    test(name, () => assert.equal(isRelease(makePr(over)), expected));
  }
});

describe('signals: CI and mergeable', () => {
  const cases = [
    ['ci failed', { ci: 'failed' }, { kind: 'ci-failed', severity: 'danger', label: 'CI failed' }],
    ['ci running', { ci: 'running' }, { kind: 'ci-running', severity: 'neutral', label: 'CI running' }],
    ['ci ok', { ci: 'ok' }, { kind: 'ci-ok', severity: 'success', label: 'CI ok' }],
    ['conflict', { mergeable: 'conflict' }, { kind: 'conflict', severity: 'danger', label: 'conflict' }],
    ['mergeable', { mergeable: 'clean' }, { kind: 'mergeable', severity: 'success', label: 'mergeable' }],
    ['draft', { draft: true }, { kind: 'draft', severity: 'neutral', label: 'draft' }],
  ];
  for (const [name, over, expected] of cases) {
    test(name, () => assert.deepEqual(find(signals(makePr(over), ctx), expected.kind), expected));
  }

  test('ci none / unknown → no CI signal', () => {
    for (const ci of ['none', 'unknown']) {
      const k = kinds(signals(makePr({ ci }), ctx));
      assert.ok(!k.some((x) => x.startsWith('ci-')), `${ci}: ${k}`);
    }
  });

  test('mergeable unknown → nothing', () => {
    const k = kinds(signals(makePr({ mergeable: 'unknown' }), ctx));
    assert.ok(!k.includes('conflict') && !k.includes('mergeable'));
  });
});

describe('signals: stacked', () => {
  const base = (state) => ({ number: 77, state, url: 'https://example.test/base/77' });
  const cases = [
    ['base open (github)', 'github', base('open'), { kind: 'stacked', severity: 'neutral', label: 'stacked on #77', href: 'https://example.test/base/77' }],
    ['base merged on GitHub', 'github', base('merged'), { kind: 'base-retarget', severity: 'danger', label: 'base merged: retarget' }],
    ['base merged on Bitbucket', 'bitbucket', base('merged'), { kind: 'base-auto', severity: 'neutral', label: 'base merged (auto-retarget)' }],
    ['base declined on Bitbucket', 'bitbucket', base('declined'), { kind: 'base-retarget', severity: 'danger', label: 'base closed: retarget' }],
    ['base closed on GitHub', 'github', base('closed'), { kind: 'base-retarget', severity: 'danger', label: 'base closed: retarget' }],
    ['no base PR', 'github', null, { kind: 'base-no-pr', severity: 'warning', label: 'base has no PR' }],
  ];
  for (const [name, host, basePr, expected] of cases) {
    test(name, () => {
      const repoShort = host === 'github' ? 'api' : 'web';
      const sigs = signals(makePr({ repoShort, target: 'feature/SHOP-1-base', basePr }), ctx);
      const stackKinds = kinds(sigs).filter((k) => ['stacked', 'base-retarget', 'base-auto', 'base-no-pr'].includes(k));
      assert.deepEqual(stackKinds, [expected.kind]);
      const got = find(sigs, expected.kind);
      assert.deepEqual({ ...got }, expected);
    });
  }

  test('target is a non-standard default branch → not stacked', () => {
    for (const basePr of [null, base('merged'), base('open')]) {
      const k = kinds(signals(makePr({ target: 'trunk', defaultBranch: 'trunk', basePr }), ctx));
      assert.deepEqual(k.filter((x) => ['stacked', 'base-retarget', 'base-auto', 'base-no-pr'].includes(x)), []);
    }
  });

  test('basePr undefined → no stacked signal', () => {
    const k = kinds(signals(makePr({ basePr: undefined }), ctx));
    assert.ok(!k.some((x) => x.startsWith('base') || x === 'stacked'));
  });

  test('GitHub stacked with merged base → base-retarget is worst', () => {
    const sigs = signals(makePr({ target: 'feature/x', basePr: base('merged'), behindBy: 30 }), ctx);
    assert.equal(worst(sigs).kind, 'base-retarget');
  });

  test('Bitbucket stacked with merged base → base-auto is not worst', () => {
    const sigs = signals(makePr({ repoShort: 'web', target: 'feature/x', basePr: base('merged') }), ctx);
    assert.equal(worst(sigs), null);
  });
});

describe('signals: locks', () => {
  const SHARED = { host: 'bitbucket', repo: 'acme-shared', repoShort: 'shared', defaultBranch: 'develop' };
  const sharedPr = (state, number = 7) => ({ number, state, url: `https://example.test/acme-shared/${number}` });
  const entry = (over) => ({ package: 'acme/shared', sharedRepo: SHARED, constraint: 'dev-develop', lockRef: 'aaa', pinnedPr: null, missingPrs: [], ...over });
  const onMain = (over) => entry({ sharedRepo: { ...SHARED, defaultBranch: 'main' }, ...over });
  const unknownDefault = (over) => entry({ sharedRepo: { ...SHARED, defaultBranch: null }, ...over });
  const pinned = 'dev-feature/SHOP-42-checkout';
  const href = 'https://example.test/acme-shared/7';
  const lockSigs = (locks) => signals(makePr({ repoShort: 'backend', locks }), ctx)
    .filter((s) => s.kind.startsWith('lock-')).map((s) => ({ ...s }));
  const cases = [
    ['pinned, shared PR open', entry({ constraint: pinned, pinnedPr: sharedPr('open') }), [{ kind: 'lock-waits', severity: 'neutral', label: 'waits for shared #7', href }]],
    ['pinned, shared PR merged', entry({ constraint: pinned, pinnedPr: sharedPr('merged') }), [{ kind: 'lock-unpin', severity: 'warning', label: 'lock bump due: unpin', href }]],
    ['pinned, no shared PR', entry({ constraint: pinned, pinnedPr: null }), [{ kind: 'lock-pinned', severity: 'warning', label: 'pinned to shared branch' }]],
    ['pinned, lookup failed', entry({ constraint: pinned, pinnedPr: undefined }), [{ kind: 'lock-pinned', severity: 'warning', label: 'pinned to shared branch' }]],
    ['pinned, shared PR declined', entry({ constraint: pinned, pinnedPr: sharedPr('declined') }), [{ kind: 'lock-pinned', severity: 'warning', label: 'pinned to shared branch' }]],
    ['dev-<shared default> → nothing', entry({}), []],
    ['dev-develop against a shared default main → pinned', onMain({}), [{ kind: 'lock-pinned', severity: 'warning', label: 'pinned to shared branch' }]],
    ['dev-main against a shared default main → nothing', onMain({ constraint: 'dev-main' }), []],
    ['shared default unknown: dev-<main branch> → nothing', unknownDefault({ constraint: 'dev-main' }), []],
    ['shared default unknown: dev-<feature branch> → pinned', unknownDefault({ constraint: pinned }), [{ kind: 'lock-pinned', severity: 'warning', label: 'pinned to shared branch' }]],
    ['tagged constraint → nothing', entry({ constraint: '^3.2' }), []],
    ['null constraint → nothing', entry({ constraint: null }), []],
    ['missing shared PRs → one each', entry({ missingPrs: [{ number: 7, url: 'u7' }, { number: 8, url: 'u8' }] }), [
      { kind: 'lock-missing', severity: 'warning', label: 'lock bump due: shared #7', href: 'u7' },
      { kind: 'lock-missing', severity: 'warning', label: 'lock bump due: shared #8', href: 'u8' },
    ]],
  ];
  for (const [name, l, expected] of cases) {
    test(name, () => assert.deepEqual(lockSigs([l]), expected));
  }

  test('one set per entry, each named by its shared package short name', () => {
    const tools = { host: 'github', repo: 'acme-tools', repoShort: 'tools', defaultBranch: 'main' };
    const locks = [
      entry({ missingPrs: [{ number: 7, url: 'u7' }] }),
      entry({ package: 'acme/tools', sharedRepo: tools, constraint: 'dev-feature/SHOP-42-x', pinnedPr: sharedPr('open', 3) }),
    ];
    assert.deepEqual(lockSigs(locks).map((s) => s.label), ['lock bump due: shared #7', 'waits for tools #3']);
  });

  test('no locks, empty locks and the old `lock` field → no lock signals', () => {
    assert.deepEqual(lockSigs([]), []);
    assert.deepEqual(lockSigs(undefined), []);
    const old = { constraint: pinned, lockRef: 'a', pinnedPkgPr: null, missingPkgPrs: [{ number: 1, url: 'u' }] };
    assert.deepEqual(signals(makePr({ repoShort: 'backend', lock: old }), ctx).filter((s) => s.kind.startsWith('lock-')), []);
  });

  test('backend pinned to a shared branch whose PR is merged → worst lock-unpin', () => {
    const sigs = signals(makePr({ repoShort: 'backend', locks: [entry({ constraint: pinned, pinnedPr: sharedPr('merged') })] }), ctx);
    assert.equal(worst(sigs).kind, 'lock-unpin');
  });
});

describe('signals: behind and stale', () => {
  const behindCases = [
    [0, null],
    [null, null],
    [5, { kind: 'behind', severity: 'neutral', label: '5 behind' }],
    [19, { kind: 'behind', severity: 'neutral', label: '19 behind' }],
    [20, { kind: 'behind', severity: 'warning', label: '20 behind' }],
    [99, { kind: 'behind', severity: 'warning', label: '99 behind' }],
    [100, { kind: 'behind', severity: 'warning', label: '99+ behind' }],
    [250, { kind: 'behind', severity: 'warning', label: '99+ behind' }],
  ];
  for (const [behindBy, expected] of behindCases) {
    test(`behindBy ${behindBy}`, () => {
      const got = find(signals(makePr({ behindBy }), ctx), 'behind');
      assert.deepEqual(got ? { ...got } : null, expected);
    });
  }

  const staleCases = [
    ['exactly staleDays → not stale', NOW - 14 * DAY, null],
    ['1 ms over → stale 14d', NOW - 14 * DAY - 1, { kind: 'stale', severity: 'warning', label: 'stale 14d' }],
    ['20.5 days → stale 20d', NOW - 20.5 * DAY, { kind: 'stale', severity: 'warning', label: 'stale 20d' }],
    ['1 day → not stale', NOW - DAY, null],
  ];
  for (const [name, at, expected] of staleCases) {
    test(name, () => {
      const got = find(signals(makePr({ updatedAt: iso(at) }), ctx), 'stale');
      assert.deepEqual(got ? { ...got } : null, expected);
    });
  }
});

describe('signals ordering', () => {
  test('sorted danger, warning, neutral, success; stable within severity', () => {
    const sigs = signals(makePr({
      ci: 'failed', mergeable: 'conflict', draft: true, behindBy: 3,
      updatedAt: iso(NOW - 30 * DAY),
      repoShort: 'backend',
      locks: [{
        package: 'acme/shared', sharedRepo: { host: 'bitbucket', repo: 'acme-shared', repoShort: 'shared', defaultBranch: 'develop' },
        constraint: 'dev-develop', lockRef: 'a', pinnedPr: null, missingPrs: [{ number: 1, url: 'u1' }],
      }],
    }), ctx);
    assert.deepEqual(kinds(sigs), ['ci-failed', 'conflict', 'lock-missing', 'stale', 'draft', 'behind']);
  });

  test('success signals last', () => {
    assert.deepEqual(kinds(signals(makePr({ draft: true }), ctx)), ['draft', 'ci-ok', 'mergeable']);
  });
});

describe('worst', () => {
  const s = (kind, severity) => ({ kind, severity, label: kind });
  const cases = [
    ['conflict beats ci-failed', [s('ci-failed', 'danger'), s('conflict', 'danger')], 'conflict'],
    ['ci-failed beats base-retarget', [s('base-retarget', 'danger'), s('ci-failed', 'danger')], 'ci-failed'],
    ['base-retarget beats lock-unpin', [s('lock-unpin', 'warning'), s('base-retarget', 'danger')], 'base-retarget'],
    ['lock-unpin beats lock-missing', [s('lock-missing', 'warning'), s('lock-unpin', 'warning')], 'lock-unpin'],
    ['lock-missing beats base-no-pr', [s('base-no-pr', 'warning'), s('lock-missing', 'warning')], 'lock-missing'],
    ['base-no-pr beats lock-pinned', [s('lock-pinned', 'warning'), s('base-no-pr', 'warning')], 'base-no-pr'],
    ['lock-pinned beats stale', [s('stale', 'warning'), s('lock-pinned', 'warning')], 'lock-pinned'],
    ['stale beats warning behind', [s('behind', 'warning'), s('stale', 'warning')], 'stale'],
    ['warning behind beats ci-running', [s('ci-running', 'neutral'), s('behind', 'warning')], 'behind'],
    ['neutral behind is never worst', [s('behind', 'neutral')], null],
    ['ci-running as last resort', [s('ci-running', 'neutral'), s('draft', 'neutral'), s('behind', 'neutral')], 'ci-running'],
    ['informational only → null', [s('ci-ok', 'success'), s('mergeable', 'success'), s('draft', 'neutral'), s('stacked', 'neutral'), s('base-auto', 'neutral'), s('lock-waits', 'neutral')], null],
    ['empty → null', [], null],
  ];
  for (const [name, sigs, expected] of cases) {
    test(name, () => assert.equal(worst(sigs)?.kind ?? null, expected));
  }
});

describe('isReady', () => {
  const cases = [
    ['ci ok + clean', {}, true],
    ['ci none + clean', { ci: 'none' }, true],
    ['draft never ready', { draft: true }, false],
    ['ci running', { ci: 'running' }, false],
    ['ci unknown', { ci: 'unknown' }, false],
    ['ci failed', { ci: 'failed' }, false],
    ['mergeable unknown', { mergeable: 'unknown' }, false],
    ['conflict', { mergeable: 'conflict' }, false],
    ['neutral behind still ready', { behindBy: 5 }, true],
    ['warning behind not ready', { behindBy: 25 }, false],
    ['stale not ready', { updatedAt: iso(NOW - 15 * DAY) }, false],
    ['stacked on open base still ready', { target: 'feature/x', basePr: { number: 1, state: 'open', url: 'u' } }, true],
  ];
  for (const [name, over, expected] of cases) {
    test(name, () => {
      const p = makePr(over);
      assert.equal(isReady(p, signals(p, ctx)), expected);
    });
  }
});

describe('enrich', () => {
  test('adds derived fields without mutating input', () => {
    const p = makePr({ source: 'feature/SHOP-42-checkout', ci: 'failed' });
    const before = structuredClone(p);
    const [e] = enrich([p], ctx);
    assert.deepEqual(p, before);
    assert.equal(e.ticketKey, 'SHOP-42');
    assert.equal(e.release, false);
    assert.equal(e.worst.kind, 'ci-failed');
    assert.equal(e.ready, false);
    assert.ok(Array.isArray(e.signals));
    assert.equal(e.number, p.number);
  });

  test('ticketKey comes from ctx.matchers and is the key string', () => {
    const [shop, ops, link, none] = enrich([
      makePr({ source: 'feature/shop_42' }),
      makePr({ source: 'x', title: 'OPS 7 fix' }),
      makePr({ source: 'x', title: 'y', description: 'https://trello.com/c/AbC123/95-fix' }),
      makePr({ source: 'x', title: 'y' }),
    ], ctx);
    assert.deepEqual([shop.ticketKey, ops.ticketKey, link.ticketKey, none.ticketKey],
      ['SHOP-42', 'OPS-7', 'https://trello.com/c/AbC123', null]);
  });

  test('without matchers no PR has a ticket', () => {
    const [e] = enrich([makePr({ source: 'feature/SHOP-42' })], { ...ctx, matchers: undefined });
    assert.equal(e.ticketKey, null);
  });

  test('drops description from the output', () => {
    const [e] = enrich([makePr({ description: 'secret-ish body https://trello.com/c/A1' })], ctx);
    assert.equal('description' in e, false);
  });
});

describe('groupByTicket', () => {
  const tickets = {
    'SHOP-42': { status: 'In Progress', summary: 'Checkout', url: 'https://jira.example.com/browse/SHOP-42' },
  };

  test('SHOP-42 across shared/backend/web/status → one group, ready count', () => {
    const src = 'feature/SHOP-42-checkout';
    const prs = enrich([
      makePr({ repoShort: 'shared', number: 215, source: src, ci: 'ok' }),
      makePr({ repoShort: 'backend', number: 2504, source: src, ci: 'failed' }),
      makePr({ repoShort: 'web', number: 3487, source: src, ci: 'running' }),
      makePr({ repoShort: 'status', number: 42, source: src, ci: 'none', mine: false }),
    ], ctx);
    const { groups, noTicket, releases } = groupByTicket(prs, tickets);
    assert.equal(groups.length, 1);
    const g = groups[0];
    assert.equal(g.key, 'SHOP-42');
    assert.equal(g.status, 'In Progress');
    assert.equal(g.summary, 'Checkout');
    assert.equal(g.url, 'https://jira.example.com/browse/SHOP-42');
    assert.equal(g.total, 4);
    assert.equal(g.ready, 2);
    assert.equal(g.allMine, false);
    assert.equal(g.severity, 'danger');
    // problems first (ci-failed, then ci-running), then null-worst by repoShort
    assert.deepEqual(g.prs.map((p) => p.repoShort), ['backend', 'web', 'shared', 'status']);
    assert.deepEqual(noTicket.prs, []);
    assert.deepEqual(releases.prs, []);
  });

  test('unknown ticket → nulls; allMine true when all mine', () => {
    const prs = enrich([makePr({ source: 'feature/SHOP-999' })], ctx);
    const [g] = groupByTicket(prs, tickets).groups;
    assert.deepEqual({ key: g.key, status: g.status, summary: g.summary, url: g.url, allMine: g.allMine, severity: g.severity },
      { key: 'SHOP-999', status: null, summary: null, url: null, allMine: true, severity: null });
  });

  test('No ticket bucket and releases excluded from groups', () => {
    const prs = enrich([
      makePr({ number: 1, source: 'chore/deps', title: 'Bump deps' }),
      makePr({ number: 2, source: 'develop', target: 'staging', title: 'Release SHOP-42' }),
      makePr({ number: 3, source: 'release/x', target: 'staging', title: 'Develop > staging' }),
      makePr({ number: 4, source: 'feature/SHOP-42' }),
    ], ctx);
    const { groups, noTicket, releases } = groupByTicket(prs, tickets);
    assert.deepEqual(groups.map((g) => g.key), ['SHOP-42']);
    assert.deepEqual(groups[0].prs.map((p) => p.number), [4]);
    assert.deepEqual(noTicket.prs.map((p) => p.number), [1]);
    assert.deepEqual(releases.prs.map((p) => p.number).sort(), [2, 3]);
  });

  test('within a group: by worst precedence, then repoShort, then number', () => {
    const src = 'feature/SHOP-5';
    const prs = enrich([
      makePr({ repoShort: 'api', number: 9, source: src }),
      makePr({ repoShort: 'web', number: 20, source: src }),
      makePr({ repoShort: 'web', number: 10, source: src }),
      makePr({ repoShort: 'api', number: 1, source: src, updatedAt: iso(NOW - 30 * DAY) }),
      makePr({ repoShort: 'backend', number: 2, source: src, mergeable: 'conflict' }),
    ], ctx);
    const [g] = groupByTicket(prs, {}).groups;
    assert.deepEqual(g.prs.map((p) => `${p.repoShort}#${p.number}`),
      ['backend#2', 'api#1', 'api#9', 'web#10', 'web#20']);
  });

  test('groups: danger, then warning, then rest; within tier by most recent update', () => {
    const prs = enrich([
      makePr({ source: 'feature/SHOP-1', updatedAt: iso(NOW - 1 * DAY) }), // rest, newest
      makePr({ source: 'feature/SHOP-2', updatedAt: iso(NOW - 5 * DAY) }), // rest, older
      makePr({ source: 'feature/SHOP-3', updatedAt: iso(NOW - 20 * DAY) }), // warning (stale)
      makePr({ source: 'feature/SHOP-4', updatedAt: iso(NOW - 6 * DAY), ci: 'failed' }), // danger, older
      makePr({ source: 'feature/SHOP-5', updatedAt: iso(NOW - 2 * DAY), mergeable: 'conflict' }), // danger, newer
      makePr({ source: 'feature/SHOP-6', updatedAt: iso(NOW - 3 * DAY), behindBy: 40 }), // warning, newer
      makePr({ source: 'feature/SHOP-2', updatedAt: iso(NOW - 0.5 * DAY) }), // bumps SHOP-2 max updatedAt
    ], ctx);
    const keys = groupByTicket(prs, {}).groups.map((g) => g.key);
    assert.deepEqual(keys, ['SHOP-5', 'SHOP-4', 'SHOP-6', 'SHOP-3', 'SHOP-2', 'SHOP-1']);
  });
});

describe('groupByRepo', () => {
  test('config order, hides empty repos, excludes releases, worst across PRs', () => {
    const prs = enrich([
      makePr({ repoShort: 'api', number: 1, mine: true }),
      makePr({ repoShort: 'api', number: 2, mine: false, updatedAt: iso(NOW - 20 * DAY) }),
      makePr({ repoShort: 'api', number: 3, mine: false, ci: 'failed' }),
      makePr({ repoShort: 'backend', number: 4, mine: true }),
      makePr({ repoShort: 'web', number: 5, source: 'develop', target: 'staging', ci: 'failed' }),
    ], ctx);
    const rows = groupByRepo(prs, repoList);
    assert.deepEqual(rows.map((r) => r.repoShort), ['backend', 'api']);
    const [backend, api] = rows;
    assert.equal(backend.repoUrl, repoList[0].repoUrl);
    assert.deepEqual({ open: backend.open, mine: backend.mine, worst: backend.worst }, { open: 1, mine: 1, worst: null });
    assert.equal(api.open, 3);
    assert.equal(api.mine, 1);
    assert.equal(api.worst.kind, 'ci-failed');
    assert.deepEqual(api.prs.map((p) => p.number).sort(), [1, 2, 3]);
  });
});

describe('attentionCounts', () => {
  test('counts PRs, excludes releases, lock counted once per PR', () => {
    const lock = {
      package: 'acme/shared', sharedRepo: { host: 'bitbucket', repo: 'acme-shared', repoShort: 'shared', defaultBranch: 'develop' },
      constraint: 'dev-feature/SHOP-42-checkout', lockRef: 'a',
      pinnedPr: { number: 215, state: 'merged', url: 'u' },
      missingPrs: [{ number: 213, url: 'u213' }, { number: 214, url: 'u214' }],
    };
    const prs = enrich([
      makePr({ ci: 'failed', mergeable: 'conflict' }),
      makePr({ ci: 'failed' }),
      makePr({ repoShort: 'backend', locks: [lock] }),
      makePr({ target: 'feature/x', basePr: null }),
      makePr({ target: 'feature/y', basePr: { number: 3, state: 'merged', url: 'u' } }),
      makePr({ repoShort: 'web', target: 'feature/z', basePr: { number: 4, state: 'merged', url: 'u' } }),
      makePr({ updatedAt: iso(NOW - 30 * DAY) }),
      makePr({ source: 'develop', target: 'staging', ci: 'failed', mergeable: 'conflict', updatedAt: iso(NOW - 30 * DAY) }),
    ], ctx);
    assert.deepEqual(attentionCounts(prs), { ciFailed: 2, conflicts: 1, stacked: 2, lock: 1, stale: 1 });
  });

  test('ATTENTION mapping', () => {
    assert.deepEqual(ATTENTION, {
      ciFailed: ['ci-failed'],
      conflicts: ['conflict'],
      stacked: ['base-retarget', 'base-no-pr'],
      lock: ['lock-unpin', 'lock-pinned', 'lock-missing'],
      stale: ['stale'],
    });
  });
});
