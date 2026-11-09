import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { enrich } from '../src/derive.js';
import {
  FIXABLE_KINDS,
  fixableSignals,
  fixSeverity,
  promptFor,
  bundlePrompt,
} from '../public/fix-prompt.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-06T12:00:00Z');
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const PROJECT = readJson('../projects/example.json');
const CONFIG = readJson('../config.example.json');
const ctx = { now: NOW, staleDays: 14, behindWarn: 20, matchers: PROJECT.tickets };
const iso = (ms) => new Date(ms).toISOString();

// The snapshot's `fix` for the example project (SPEC "Snapshot"): sharedPackages resolved against the
// project's repos and aliases; defaultBranch comes from discovery, `develop` for the example repos.
const shortOf = (repo) => PROJECT.aliases[repo] ?? repo;
const hostOf = (repo) => Object.keys(PROJECT.repos).find((h) => PROJECT.repos[h].includes(repo));
const FIX = {
  sharedPackages: PROJECT.sharedPackages.map((p) => ({
    repo: p.repo,
    repoShort: shortOf(p.repo),
    host: hostOf(p.repo),
    package: p.package,
    defaultBranch: 'develop',
    consumers: p.consumers.map((c) => ({ repo: c, repoShort: shortOf(c), host: hostOf(c) })),
  })),
  fixPrompts: PROJECT.fixPrompts,
  fixNotes: CONFIG.fixNotes,
};
const BB = PROJECT.hosts.bitbucket.workspace;
const GH = PROJECT.hosts.github.owner;

const REPOS = {
  backend: { host: 'bitbucket', owner: BB, repo: 'acme-backend', repoShort: 'backend' },
  web: { host: 'bitbucket', owner: BB, repo: 'acme-web', repoShort: 'web' },
  worker: { host: 'bitbucket', owner: BB, repo: 'acme-worker', repoShort: 'worker' },
  shared: { host: 'bitbucket', owner: BB, repo: 'acme-shared', repoShort: 'shared' },
  api: { host: 'github', owner: GH, repo: 'acme-api', repoShort: 'api' },
};

const SHARED = { host: 'bitbucket', repo: 'acme-shared', repoShort: 'shared', defaultBranch: 'develop' };
const lock = (over = {}) => ({
  package: 'acme/shared', sharedRepo: SHARED, constraint: 'dev-develop', lockRef: 'abc1234',
  pinnedPr: null, missingPrs: [], ...over,
});

let seq = 100;
function makePr(over = {}) {
  const r = REPOS[over.repoShort ?? 'api'];
  const number = over.number ?? ++seq;
  const raw = {
    id: `${r.host}:${r.repo}#${number}`,
    host: r.host,
    owner: r.owner,
    repo: r.repo,
    repoShort: r.repoShort,
    defaultBranch: 'develop',
    number,
    title: 'Some change',
    url: `https://example.test/${r.repo}/pull/${number}`,
    author: { name: 'Paul', id: 'paul' },
    mine: true,
    source: 'feature/SHOP-1-thing',
    target: 'develop',
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
  return enrich([raw], ctx)[0];
}

const stepLines = (p) => p.split('\n').filter((l) => /^\d+\. /.test(l));
const onlyStep = (p) => {
  const steps = stepLines(p);
  assert.equal(steps.length, 1, p);
  return steps[0].replace(/^\d+\. /, '');
};

function assertClean(text) {
  assert.ok(typeof text === 'string' && text.length > 0);
  assert.doesNotMatch(text, /undefined|null|NaN|\[object Object\]/);
}

const CLOSING = 'Read the repo\'s AGENTS.md or CLAUDE.md first, if present, and follow it. '
  + 'Work in a worktree if the checkout has other work in progress. Never force-push. '
  + 'Report what you changed, the commit, and the CI result after the push.';

describe('canonical examples (SPEC "Fix prompts")', () => {
  const LOCK_REF = '3f2a9c1e7b5d4a8c9e0f1a2b3c4d5e6f7a8b9c0d';
  const SHARED_7 = { number: 7, url: 'https://bitbucket.org/acme/acme-shared/pull-requests/7' };
  const ticketPr = (repoShort, number, over = {}) => makePr({
    repoShort,
    number,
    url: `https://bitbucket.org/acme/${REPOS[repoShort].repo}/pull-requests/${number}`,
    title: 'SHOP-42 Add invoice export',
    source: 'feature/SHOP-42-invoice-export',
    target: 'develop',
    ...over,
  });
  const backend = () => ticketPr('backend', 12, { locks: [lock({ lockRef: LOCK_REF, missingPrs: [SHARED_7] })] });
  const worker = () => ticketPr('worker', 31, { locks: [lock({ lockRef: LOCK_REF, missingPrs: [SHARED_7] })] });
  const shared = () => ticketPr('shared', 7, { ci: 'failed' });

  const block = (name, repo, number, step) => [
    `## ${name} #${number}`,
    `PR: https://bitbucket.org/acme/${repo}/pull-requests/${number}`,
    'Title: SHOP-42 Add invoice export',
    `Repo: ${repo} (Bitbucket acme)`,
    'Branch: feature/SHOP-42-invoice-export → develop',
    '',
    step,
  ].join('\n');
  const lockStep = (repo) => `1. Lock bump due: acme-shared PR(s) #7 (https://bitbucket.org/acme/acme-shared/pull-requests/7) merged to \`develop\`, but ${repo}'s composer.lock still references \`3f2a9c1e\`. Update acme/shared in ${repo}'s lock to acme-shared's current \`develop\` head, then push and let CI build.\n`
    + '   Project convention: Edit only `reference` and `time` of the package in composer.lock, and only if its composer.json is unchanged between the two commits; otherwise stop and tell me. Git only, no local composer run.';

  test('promptFor: backend #12, lock bump due', () => {
    const expected = `Fix backend #12 (lock bump due: shared #7).

PR: https://bitbucket.org/acme/acme-backend/pull-requests/12
Title: SHOP-42 Add invoice export
Repo: acme-backend (Bitbucket acme)
Branch: feature/SHOP-42-invoice-export → develop

1. Lock bump due: acme-shared PR(s) #7 (https://bitbucket.org/acme/acme-shared/pull-requests/7) merged to \`develop\`, but acme-backend's composer.lock still references \`3f2a9c1e\`. Update acme/shared in acme-backend's lock to acme-shared's current \`develop\` head, then push and let CI build.
   Project convention: Edit only \`reference\` and \`time\` of the package in composer.lock, and only if its composer.json is unchanged between the two commits; otherwise stop and tell me. Git only, no local composer run.

Read the repo's AGENTS.md or CLAUDE.md first, if present, and follow it. Work in a worktree if the checkout has other work in progress. Never force-push. Report what you changed, the commit, and the CI result after the push.

My setup: Read pipelines through the Atlassian MCP.`;
    assert.equal(promptFor(backend(), FIX), expected);
  });

  test('bundlePrompt: Ticket group SHOP-42, shared package first', () => {
    const expected = [
      'Unblock the PRs of SHOP-42:',
      '- shared #7: CI failed',
      '- backend #12: lock bump due: shared #7',
      '- worker #31: lock bump due: shared #7',
      '',
      'Work in this order: shared (shared package) first, then its consumers (backend, worker), then the rest. One commit per repo.',
      'Project convention: Wait for CI on the shared package before you update a lock.',
      '',
      block('shared', 'acme-shared', 7, '1. CI failed. Read the failing pipeline from the PR\'s build status. Find the root cause; if it\'s flaky or infra, tell me instead of retrying blindly. Push.'),
      '',
      block('backend', 'acme-backend', 12, lockStep('acme-backend')),
      '',
      block('worker', 'acme-worker', 31, lockStep('acme-worker')),
      '',
      CLOSING,
      '',
      'My setup: Read pipelines through the Atlassian MCP.',
    ].join('\n');
    // Board order differs on purpose: the bundle puts the shared package first.
    assert.equal(bundlePrompt([backend(), worker(), shared()], 'SHOP-42', FIX), expected);
  });
});

describe('fixableSignals / fixSeverity', () => {
  test('FIXABLE_KINDS holds exactly the fixable kinds', () => {
    assert.deepEqual([...FIXABLE_KINDS].sort(), [
      'base-no-pr', 'base-retarget', 'ci-failed', 'conflict', 'lock-missing', 'lock-pinned', 'lock-unpin',
    ]);
  });

  test('behind and stale alone are not fixable', () => {
    const pr = makePr({ behindBy: 50, updatedAt: iso(NOW - 30 * DAY) });
    assert.deepEqual(pr.signals.map((s) => s.kind).sort(), ['behind', 'ci-ok', 'mergeable', 'stale']);
    assert.deepEqual(fixableSignals(pr), []);
    assert.equal(fixSeverity(pr), null);
    assert.equal(promptFor(pr, FIX), null);
  });

  test('missing signals → empty / null', () => {
    assert.deepEqual(fixableSignals({}), []);
    assert.equal(fixSeverity({}), null);
    assert.equal(promptFor({}), null);
  });

  test('keeps original order and drops non-fixable kinds', () => {
    const pr = { signals: [
      { kind: 'ci-failed', severity: 'danger', label: 'CI failed' },
      { kind: 'behind', severity: 'warning', label: '30 behind' },
      { kind: 'conflict', severity: 'danger', label: 'conflict' },
      { kind: 'draft', severity: 'neutral', label: 'draft' },
    ] };
    assert.deepEqual(fixableSignals(pr).map((s) => s.kind), ['ci-failed', 'conflict']);
  });

  test('severity danger when any fixable signal is danger', () => {
    assert.equal(fixSeverity(makePr({ ci: 'failed', locks: [lock({ missingPrs: [{ number: 5, url: 'u' }] })] })), 'danger');
  });

  test('severity warning when fixable signals are only warnings', () => {
    assert.equal(fixSeverity(makePr({ target: 'feature/x', basePr: null })), 'warning');
  });
});

describe('promptFor: header', () => {
  test('title line, url, title, repo host, branches, closing', () => {
    const pr = makePr({ number: 42, mergeable: 'conflict', title: 'Add thing' });
    const p = promptFor(pr, FIX);
    assertClean(p);
    assert.match(p, /^Fix api #42 \(conflict\)\./);
    assert.match(p, /PR: https:\/\/example\.test\/acme-api\/pull\/42/);
    assert.match(p, /Title: Add thing/);
    assert.match(p, /Repo: acme-api \(GitHub acme-corp\)/);
    assert.match(p, /Branch: feature\/SHOP-1-thing → develop/);
  });

  test('host label comes from pr.owner: GitHub <owner> / Bitbucket <workspace>', () => {
    assert.match(promptFor(makePr({ mergeable: 'conflict', owner: 'other-org' })), /Repo: acme-api \(GitHub other-org\)\n/);
    assert.match(promptFor(makePr({ repoShort: 'backend', mergeable: 'conflict', owner: 'ws2' })), /Repo: acme-backend \(Bitbucket ws2\)\n/);
    const noOwner = promptFor(makePr({ repoShort: 'backend', mergeable: 'conflict', owner: undefined }));
    assertClean(noOwner);
    assert.match(noOwner, /Repo: acme-backend \(Bitbucket\)\n/);
  });

  test('labels joined and steps numbered in signal order', () => {
    const p = promptFor(makePr({ ci: 'failed', mergeable: 'conflict' }), FIX);
    assertClean(p);
    assert.match(p, /\((CI failed, conflict|conflict, CI failed)\)/);
    assert.match(p, /\n1\. /);
    assert.match(p, /\n2\. /);
  });

  test('behind line only when a behind signal exists', () => {
    assert.match(promptFor(makePr({ ci: 'failed', behindBy: 30 }), FIX), /Also: 30 behind develop\./);
    assert.doesNotMatch(promptFor(makePr({ ci: 'failed', behindBy: 0 }), FIX), /Also:/);
  });

  test('owner line only when not mine', () => {
    assert.doesNotMatch(promptFor(makePr({ ci: 'failed' }), FIX), /Owner:/);
    const p = promptFor(makePr({ ci: 'failed', mine: false, author: { name: 'Linus', id: 'g' } }), FIX);
    assert.match(p, /Owner: Linus, not me\. Don't push to their branch/);
  });

  test('owner falls back to "someone else"', () => {
    const p = promptFor(makePr({ ci: 'failed', mine: false, author: null }), FIX);
    assertClean(p);
    assert.match(p, /Owner: someone else, not me\./);
  });

  test('closing text is fixed and comes right after the steps', () => {
    const p = promptFor(makePr({ mergeable: 'conflict' }), {});
    assert.ok(p.endsWith(`push.\n\n${CLOSING}`), p);
  });

  test('works without a ctx', () => {
    const p = promptFor(makePr({ repoShort: 'backend', locks: [lock({ missingPrs: [{ number: 5, url: 'https://bb.test/5' }] })] }));
    assertClean(p);
    assert.doesNotMatch(p, /Project convention|My setup/);
  });
});

describe('promptFor: default steps (SPEC table)', () => {
  test('conflict', () => {
    assert.equal(onlyStep(promptFor(makePr({ mergeable: 'conflict' }), FIX)),
      'Merge conflict with `develop`: fetch, check out `feature/SHOP-1-thing`, merge `origin/develop` (merge, not rebase), '
      + 'resolve keeping the intent of both sides, run the repo\'s tests, push.');
  });

  test('ci-failed on GitHub: gh run commands with the owner', () => {
    assert.equal(onlyStep(promptFor(makePr({ ci: 'failed' }), FIX)),
      'CI failed. Read the failing run: `gh run list -R acme-corp/acme-api --branch feature/SHOP-1-thing --limit 5`, '
      + 'then `gh run view <id> -R acme-corp/acme-api --log-failed`. Find the root cause; if it\'s flaky or infra, '
      + 'tell me instead of retrying blindly. Push.');
    assert.match(promptFor(makePr({ ci: 'failed', owner: 'other-org' })), /gh run list -R other-org\/acme-api /);
  });

  test('ci-failed on Bitbucket: the PR\'s build status, no tool named', () => {
    assert.equal(onlyStep(promptFor(makePr({ repoShort: 'backend', ci: 'failed' }), {})),
      'CI failed. Read the failing pipeline from the PR\'s build status. Find the root cause; if it\'s flaky or infra, '
      + 'tell me instead of retrying blindly. Push.');
  });

  test('lock-missing: every missing PR, lockRef cut to 8 chars, names from locks', () => {
    const pr = makePr({ repoShort: 'backend', locks: [lock({ lockRef: 'deadbeefcafe0123', missingPrs: [
      { number: 215, url: 'https://bb.test/pkg/215' }, { number: 216, url: 'https://bb.test/pkg/216' },
    ] })] });
    assert.equal(onlyStep(promptFor(pr, {})),
      'Lock bump due: acme-shared PR(s) #215 (https://bb.test/pkg/215), #216 (https://bb.test/pkg/216) merged to `develop`, '
      + 'but acme-backend\'s composer.lock still references `deadbeef`. Update acme/shared in acme-backend\'s lock to '
      + 'acme-shared\'s current `develop` head, then push and let CI build.');
  });

  test('lock-missing without lockRef → "an older commit"', () => {
    const p = promptFor(makePr({ repoShort: 'worker', locks: [lock({ lockRef: null, missingPrs: [{ number: 9, url: 'https://bb.test/9' }] })] }), FIX);
    assertClean(p);
    assert.match(p, /still references an older commit\./);
  });

  test('lock-missing: the shared default branch comes from the lock', () => {
    const sharedRepo = { ...SHARED, defaultBranch: 'main' };
    const p = promptFor(makePr({ repoShort: 'backend', locks: [lock({ sharedRepo, missingPrs: [{ number: 9, url: 'u9' }] })] }), {});
    assert.match(p, /merged to `main`, .* current `main` head/);
  });

  test('lock-unpin', () => {
    const pr = makePr({ repoShort: 'backend', locks: [lock({
      constraint: 'dev-feature/SHOP-42-x', pinnedPr: { number: 207, state: 'merged', url: 'https://bb.test/pkg/207' },
    })] });
    assert.equal(onlyStep(promptFor(pr, {})),
      'composer.json requires `dev-feature/SHOP-42-x`, but acme-shared PR #207 is merged: set the constraint back to '
      + '`dev-develop`, then update acme/shared in acme-backend\'s lock to acme-shared\'s current `develop` head. '
      + 'Push and let CI build.');
  });

  test('lock-pinned', () => {
    const pr = makePr({ repoShort: 'worker', locks: [lock({ constraint: 'dev-feature/SHOP-9-y' })] });
    assert.equal(onlyStep(promptFor(pr, FIX)),
      'composer.json requires `dev-feature/SHOP-9-y` (a branch of acme-shared), and no acme-shared PR was found for it: '
      + 'find out whether that branch was merged, renamed or abandoned, and report back before changing anything.');
  });

  test('a lock step per locks entry that needs it', () => {
    const lib = { host: 'github', repo: 'acme-lib', repoShort: 'lib', defaultBranch: 'main' };
    const pr = makePr({ repoShort: 'backend', locks: [
      lock({ missingPrs: [{ number: 5, url: 'u5' }] }),
      lock({ package: 'acme/lib', sharedRepo: lib, constraint: 'dev-main', missingPrs: [] }),
      lock({ package: 'acme/lib2', sharedRepo: { ...lib, repo: 'acme-lib2', repoShort: 'lib2' }, constraint: 'dev-main', missingPrs: [{ number: 8, url: 'u8' }] }),
    ] });
    const steps = stepLines(promptFor(pr, {}));
    assert.equal(steps.length, 2);
    assert.match(steps[0], /^1\. Lock bump due: acme-shared PR\(s\) #5 \(u5\)/);
    assert.match(steps[1], /^2\. Lock bump due: acme-lib2 PR\(s\) #8 \(u8\) merged to `main`/);
  });

  test('base-retarget on GitHub: gh pr edit to the default branch', () => {
    const pr = makePr({ number: 77, target: 'feature/SHOP-1-base', defaultBranch: 'main', basePr: { number: 70, state: 'merged', url: 'u' } });
    assert.equal(onlyStep(promptFor(pr, FIX)),
      'Stacked trap: this PR targets `feature/SHOP-1-base`, whose PR #70 is merged. First check the base really reached `main`; '
      + 'then retarget this PR to `main` (GitHub: `gh pr edit 77 -R acme-corp/acme-api --base main`), '
      + 'merge `main` into `feature/SHOP-1-thing`, resolve, push.');
  });

  test('base-retarget on Bitbucket: no gh command', () => {
    const pr = makePr({ repoShort: 'backend', target: 'feature/x', basePr: { number: 70, state: 'declined', url: 'u' } });
    assert.equal(onlyStep(promptFor(pr, FIX)),
      'Stacked trap: this PR targets `feature/x`, whose PR #70 is declined. First check the base really reached `develop`; '
      + 'then retarget this PR to `develop`, merge `develop` into `feature/SHOP-1-thing`, resolve, push.');
  });

  test('base-no-pr', () => {
    assert.equal(onlyStep(promptFor(makePr({ target: 'feature/SHOP-1-base', basePr: null }), FIX)),
      'This PR targets `feature/SHOP-1-base`, which has no PR of its own: find out whether `feature/SHOP-1-base` needs a PR '
      + 'or this one should target `develop`, and ask me before retargeting.');
  });

  test('no undefined/null text with sparse data', () => {
    const sparse = {
      host: 'github', repo: 'acme-api', repoShort: 'api', number: 1,
      signals: [
        { kind: 'conflict', severity: 'danger', label: 'conflict' },
        { kind: 'ci-failed', severity: 'danger', label: 'CI failed' },
        { kind: 'base-retarget', severity: 'danger', label: 'base closed: retarget' },
        { kind: 'base-no-pr', severity: 'warning', label: 'base has no PR' },
        { kind: 'lock-unpin', severity: 'warning', label: 'lock bump due: unpin' },
        { kind: 'lock-pinned', severity: 'warning', label: 'pinned to shared branch' },
        { kind: 'lock-missing', severity: 'warning', label: 'lock bump due: shared #3' },
      ],
    };
    assertClean(promptFor(sparse));
    assertClean(promptFor({ ...sparse, host: 'bitbucket', mine: false }, FIX));
    assert.equal(stepLines(promptFor(sparse)).length, 7);
  });
});

describe('promptFor: project conventions', () => {
  const conflictAndLock = () => makePr({
    repoShort: 'backend', mergeable: 'conflict', locks: [lock({ missingPrs: [{ number: 5, url: 'u5' }] })],
  });

  test('a Project convention line right under its step only, indented to the step', () => {
    const p = promptFor(conflictAndLock(), { fixPrompts: { 'lock-missing': 'Bump it the team way.' } });
    const lines = p.split('\n');
    const at = lines.findIndex((l) => l.startsWith('   Project convention:'));
    assert.equal(lines[at], '   Project convention: Bump it the team way.');
    assert.match(lines[at - 1], /^\d\. Lock bump due:/);
    assert.equal(p.match(/Project convention/g).length, 1);
  });

  test('indent follows a two-digit step number', () => {
    const many = { host: 'bitbucket', repo: 'r', repoShort: 'r', number: 1, signals: [
      ...Array.from({ length: 9 }, () => ({ kind: 'lock-missing', label: 'x' })),
    ] };
    // nine lock-missing signals without locks still make one fallback step
    assert.equal(stepLines(promptFor(many)).length, 1);
    const locks = Array.from({ length: 10 }, (_, i) => lock({ missingPrs: [{ number: i + 1, url: `u${i}` }] }));
    const p = promptFor(makePr({ repoShort: 'backend', locks }), { fixPrompts: { 'lock-missing': 'C.' } });
    assert.match(p, /\n10\. Lock bump due: [^\n]*\n {4}Project convention: C\./);
    assert.match(p, /\n9\. Lock bump due: [^\n]*\n {3}Project convention: C\./);
  });

  test('empty or whitespace convention → no line', () => {
    assert.doesNotMatch(promptFor(conflictAndLock(), { fixPrompts: { 'lock-missing': '', conflict: '  \n ' } }), /Project convention/);
  });

  test('unknown key ignored', () => {
    const p = promptFor(conflictAndLock(), { fixPrompts: { 'lock-wait': 'ZZZ-unknown', nope: 'ZZZ-nope' } });
    assert.doesNotMatch(p, /ZZZ|Project convention/);
  });

  test('group convention is not used for a single PR', () => {
    assert.doesNotMatch(promptFor(conflictAndLock(), { fixPrompts: { group: 'ZZZ-group' } }), /ZZZ/);
  });
});

describe('promptFor: fix notes', () => {
  const notes = { all: 'Use the worktree helper.', github: 'gh is logged in.', bitbucket: 'Pipelines via MCP.' };

  test('My setup: all first, then the PR\'s host, last in the prompt', () => {
    const gh = promptFor(makePr({ ci: 'failed' }), { fixNotes: notes });
    assert.ok(gh.endsWith(`${CLOSING}\n\nMy setup: Use the worktree helper. gh is logged in.`), gh);
    const bb = promptFor(makePr({ repoShort: 'backend', ci: 'failed' }), { fixNotes: notes });
    assert.ok(bb.endsWith('\n\nMy setup: Use the worktree helper. Pipelines via MCP.'), bb);
  });

  test('only a host note, or only all', () => {
    assert.ok(promptFor(makePr({ ci: 'failed' }), { fixNotes: { github: ' gh ok. ' } }).endsWith('\n\nMy setup: gh ok.'));
    assert.ok(promptFor(makePr({ ci: 'failed' }), { fixNotes: { all: 'A.', bitbucket: 'B.' } }).endsWith('\n\nMy setup: A.'));
  });

  test('no notes, or only notes for absent hosts or blank → no paragraph', () => {
    for (const fixNotes of [undefined, {}, { all: '  ', github: '' }, { bitbucket: 'B.' }]) {
      const p = promptFor(makePr({ ci: 'failed' }), { fixNotes });
      assert.doesNotMatch(p, /My setup/);
      assert.ok(p.endsWith(CLOSING));
    }
  });
});

describe('bundlePrompt', () => {
  const sections = (p) => [...p.matchAll(/^## (\S+) #(\d+)$/gm)].map((m) => `${m[1]}#${m[2]}`);
  const listed = (p) => [...p.matchAll(/^- (\S+) #(\d+):/gm)].map((m) => `${m[1]}#${m[2]}`);
  const orderLine = (p) => p.split('\n\n')[1].split('\n')[0];

  test('orders shared package repos, then consumers, then the rest; board order within a tier; skips non-fixable', () => {
    const prs = [
      makePr({ repoShort: 'web', number: 1, ci: 'failed' }),
      makePr({ repoShort: 'api', number: 2 }), // nothing fixable
      makePr({ repoShort: 'worker', number: 3, mergeable: 'conflict' }),
      makePr({ repoShort: 'api', number: 4, ci: 'failed' }),
      makePr({ repoShort: 'shared', number: 5, ci: 'failed' }),
      makePr({ repoShort: 'backend', number: 6, locks: [lock({ missingPrs: [{ number: 5, url: 'https://bb.test/5' }] })] }),
    ];
    const p = bundlePrompt(prs, 'SHOP-1', FIX);
    assertClean(p);
    assert.match(p, /^Unblock the PRs of SHOP-1:/);
    assert.deepEqual(listed(p), ['shared#5', 'worker#3', 'backend#6', 'web#1', 'api#4']);
    assert.deepEqual(sections(p), listed(p));
    assert.doesNotMatch(p, /api #2/);
    assert.equal(orderLine(p),
      'Work in this order: shared (shared package) first, then its consumers (worker, backend), then the rest. One commit per repo.');
  });

  test('shared package repos matched on host as well as name', () => {
    const fix = { sharedPackages: [{ ...FIX.sharedPackages[0], host: 'github' }] };
    const p = bundlePrompt([
      makePr({ repoShort: 'web', number: 1, ci: 'failed' }),
      makePr({ repoShort: 'shared', number: 5, ci: 'failed' }),
    ], 'SHOP-1', fix);
    assert.deepEqual(listed(p), ['web#1', 'shared#5']);
    assert.equal(orderLine(p), 'One commit per repo.');
  });

  test('ordering line without a shared package repo in the group, or without ctx', () => {
    const prs = [makePr({ repoShort: 'web', number: 1, ci: 'failed' }), makePr({ repoShort: 'api', number: 2, ci: 'failed' })];
    assert.equal(orderLine(bundlePrompt(prs, 'SHOP-1', FIX)), 'One commit per repo.');
    assert.equal(orderLine(bundlePrompt(prs, 'SHOP-1')), 'One commit per repo.');
  });

  test('ordering line with a shared package repo and no consumer in the group', () => {
    const p = bundlePrompt([
      makePr({ repoShort: 'web', number: 1, ci: 'failed' }),
      makePr({ repoShort: 'shared', number: 5, ci: 'failed' }),
    ], 'SHOP-1', FIX);
    assert.equal(orderLine(p), 'Work in this order: shared (shared package) first, then the rest. One commit per repo.');
  });

  test('group convention right after the ordering line; none when blank', () => {
    const prs = [makePr({ repoShort: 'web', number: 1, ci: 'failed' }), makePr({ repoShort: 'api', number: 2, ci: 'failed' })];
    const p = bundlePrompt(prs, 'SHOP-1', { fixPrompts: { group: 'One PR at a time.' } });
    assert.match(p, /\n\nOne commit per repo\.\nProject convention: One PR at a time\.\n\n## web #1\n/);
    assert.doesNotMatch(bundlePrompt(prs, 'SHOP-1', { fixPrompts: { group: ' ' } }), /Project convention/);
  });

  test('closing once, then My setup for the hosts present in order github, bitbucket', () => {
    const notes = { all: 'A.', github: 'G.', bitbucket: 'B.' };
    const p = bundlePrompt([
      makePr({ repoShort: 'backend', number: 1, ci: 'failed' }),
      makePr({ repoShort: 'api', number: 2, ci: 'failed' }),
    ], 'SHOP-1', { fixNotes: notes });
    assert.equal(p.match(/Never force-push/g).length, 1);
    assert.doesNotMatch(p, /^Fix /m);
    assert.ok(p.endsWith(`${CLOSING}\n\nMy setup: A. G. B.`), p);
    const bbOnly = bundlePrompt([
      makePr({ repoShort: 'backend', number: 1, ci: 'failed' }),
      makePr({ repoShort: 'web', number: 2, ci: 'failed' }),
    ], 'SHOP-1', { fixNotes: notes });
    assert.ok(bbOnly.endsWith('\n\nMy setup: A. B.'), bbOnly);
  });

  test('owner line per section only for PRs that are not mine', () => {
    const p = bundlePrompt([
      makePr({ repoShort: 'shared', ci: 'failed', mine: false, author: { name: 'Linus', id: 'g' } }),
      makePr({ repoShort: 'backend', mergeable: 'conflict' }),
    ], 'SHOP-2', FIX);
    assert.equal(p.match(/Owner:/g).length, 1);
    const [sharedSection] = p.split('## backend');
    assert.match(sharedSection, /Owner: Linus/);
  });

  test('null when nothing fixable or empty', () => {
    assert.equal(bundlePrompt([makePr({ behindBy: 50 })], 'SHOP-3', FIX), null);
    assert.equal(bundlePrompt([], 'SHOP-3', FIX), null);
  });
});
