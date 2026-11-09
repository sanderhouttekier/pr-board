// Pure: builds a "fix this PR" prompt for an AI coding agent from an enriched PR (SPEC "Fix prompts").
// No DOM, no imports, no clock, no I/O: loads in node:test and in the browser.
// Project and personal parts come in through `ctx` = the snapshot's `fix`:
// { sharedPackages: [{ repo, repoShort, host, package, defaultBranch, consumers: [{ repo, repoShort, host }] }],
//   fixPrompts: { <kind>|group: string }, fixNotes: { all, github, bitbucket } }.

export const FIXABLE_KINDS = new Set([
  'conflict', 'ci-failed', 'base-retarget', 'base-no-pr', 'lock-unpin', 'lock-missing', 'lock-pinned',
]);

const CLOSING = 'Read the repo\'s AGENTS.md or CLAUDE.md first, if present, and follow it. '
  + 'Work in a worktree if the checkout has other work in progress. Never force-push. '
  + 'Report what you changed, the commit, and the CI result after the push.';

const HOST_ORDER = ['github', 'bitbucket'];
const HOST_NAMES = { github: 'GitHub', bitbucket: 'Bitbucket' };
const MAIN_BRANCHES = new Set(['develop', 'main', 'master', 'staging', 'acceptance']);

export function fixableSignals(pr) {
  return (pr?.signals ?? []).filter((s) => FIXABLE_KINDS.has(s.kind));
}

export function fixSeverity(pr) {
  const sigs = fixableSignals(pr);
  if (sigs.length === 0) return null;
  return sigs.some((s) => s.severity === 'danger') ? 'danger' : 'warning';
}

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const isGithub = (pr) => pr.host === 'github';
const hostLabel = (pr) => [HOST_NAMES[pr.host], text(pr.owner)].filter(Boolean).join(' ');
const srcOf = (pr) => pr.source || '<source branch>';
const tgtOf = (pr) => pr.target || '<target branch>';
const defaultOf = (pr) => pr.defaultBranch || '<default branch>';
const repoOf = (pr) => pr.repo || pr.repoShort || '<repo>';
const slugOf = (pr) => `${text(pr.owner) || '<owner>'}/${repoOf(pr)}`;
const code = (s) => `\`${s}\``;
const prName = (pr) => [pr.repoShort || pr.repo, pr.number != null ? `#${pr.number}` : ''].filter(Boolean).join(' ');
const labelsOf = (sigs) => sigs.map((s) => s.label).filter(Boolean).join(', ');

// Lock wording from a `locks` entry; a missing entry (sparse data) gets placeholders.
function lockNames(pr, lock) {
  const shared = lock?.sharedRepo ?? {};
  return {
    sharedRepo: shared.repo || shared.repoShort || 'the shared package repo',
    sharedDefault: code(shared.defaultBranch || '<default branch>'),
    pkg: lock?.package || 'the shared package',
    consumer: repoOf(pr),
  };
}

// Mirrors derive.lockPin: a `dev-<branch>` constraint pins a shared package branch other than its default.
function pinned(lock) {
  const branch = /^dev-([^\s#]+)/.exec(typeof lock?.constraint === 'string' ? lock.constraint : '')?.[1];
  if (!branch) return false;
  const def = lock.sharedRepo?.defaultBranch;
  return def ? branch !== def : !MAIN_BRANCHES.has(branch);
}

const LOCK_APPLIES = {
  'lock-missing': (l) => (l?.missingPrs ?? []).length > 0,
  'lock-unpin': (l) => pinned(l) && l.pinnedPr?.state === 'merged',
  'lock-pinned': (l) => pinned(l) && l.pinnedPr?.state !== 'open' && l.pinnedPr?.state !== 'merged',
};

const STEPS = {
  conflict: (pr) => `Merge conflict with ${code(tgtOf(pr))}: fetch, check out ${code(srcOf(pr))}, merge ${code(`origin/${tgtOf(pr)}`)} `
    + '(merge, not rebase), resolve keeping the intent of both sides, run the repo\'s tests, push.',

  'ci-failed': (pr) => {
    const read = isGithub(pr)
      ? `Read the failing run: ${code(`gh run list -R ${slugOf(pr)} --branch ${srcOf(pr)} --limit 5`)}, `
        + `then ${code(`gh run view <id> -R ${slugOf(pr)} --log-failed`)}.`
      : 'Read the failing pipeline from the PR\'s build status.';
    return `CI failed. ${read} Find the root cause; if it's flaky or infra, tell me instead of retrying blindly. Push.`;
  },

  'lock-missing': (pr, lock) => {
    const n = lockNames(pr, lock);
    const missing = lock?.missingPrs ?? [];
    const prs = missing.length
      ? `PR(s) ${missing.map((m) => (m.url ? `#${m.number} (${m.url})` : `#${m.number}`)).join(', ')}`
      : 'PR(s)';
    const ref = lock?.lockRef ? code(String(lock.lockRef).slice(0, 8)) : 'an older commit';
    return `Lock bump due: ${n.sharedRepo} ${prs} merged to ${n.sharedDefault}, but ${n.consumer}'s composer.lock still references ${ref}. `
      + `Update ${n.pkg} in ${n.consumer}'s lock to ${n.sharedRepo}'s current ${n.sharedDefault} head, then push and let CI build.`;
  },

  'lock-unpin': (pr, lock) => {
    const n = lockNames(pr, lock);
    const constraint = lock?.constraint ? code(lock.constraint) : 'a shared package branch';
    const which = lock?.pinnedPr?.number != null ? `PR #${lock.pinnedPr.number}` : 'PR';
    const back = lock?.sharedRepo?.defaultBranch ? code(`dev-${lock.sharedRepo.defaultBranch}`) : 'its default branch';
    return `composer.json requires ${constraint}, but ${n.sharedRepo} ${which} is merged: set the constraint back to ${back}, `
      + `then update ${n.pkg} in ${n.consumer}'s lock to ${n.sharedRepo}'s current ${n.sharedDefault} head. Push and let CI build.`;
  },

  'lock-pinned': (pr, lock) => {
    const n = lockNames(pr, lock);
    const constraint = lock?.constraint ? code(lock.constraint) : 'a shared package branch';
    return `composer.json requires ${constraint} (a branch of ${n.sharedRepo}), and no ${n.sharedRepo} PR was found for it: `
      + 'find out whether that branch was merged, renamed or abandoned, and report back before changing anything.';
  },

  'base-retarget': (pr) => {
    const base = pr.basePr;
    const which = base?.number != null ? `PR #${base.number} is ${base.state || 'merged or closed'}` : 'PR is merged or closed';
    const def = defaultOf(pr);
    const retarget = isGithub(pr) && pr.number != null
      ? ` (GitHub: ${code(`gh pr edit ${pr.number} -R ${slugOf(pr)} --base ${def}`)})`
      : '';
    return `Stacked trap: this PR targets ${code(tgtOf(pr))}, whose ${which}. First check the base really reached ${code(def)}; `
      + `then retarget this PR to ${code(def)}${retarget}, merge ${code(def)} into ${code(srcOf(pr))}, resolve, push.`;
  },

  'base-no-pr': (pr) => `This PR targets ${code(tgtOf(pr))}, which has no PR of its own: find out whether ${code(tgtOf(pr))} `
    + `needs a PR or this one should target ${code(defaultOf(pr))}, and ask me before retargeting.`,
};

// One step per kind; lock kinds get one step per `locks` entry that needs it (one placeholder step without locks).
function stepTexts(pr, kind) {
  const applies = LOCK_APPLIES[kind];
  if (!applies) return [STEPS[kind](pr)];
  const locks = (Array.isArray(pr.locks) ? pr.locks : []).filter((l) => l && applies(l));
  return locks.length ? locks.map((l) => STEPS[kind](pr, l)) : [STEPS[kind](pr, null)];
}

function body(pr, sigs, ctx) {
  const lines = [];
  if (pr.url) lines.push(`PR: ${pr.url}`);
  if (pr.title) lines.push(`Title: ${pr.title}`);
  const host = hostLabel(pr);
  lines.push(`Repo: ${repoOf(pr)}${host ? ` (${host})` : ''}`);
  if (pr.source || pr.target) lines.push(`Branch: ${srcOf(pr)} → ${tgtOf(pr)}`);
  const behind = (pr.signals ?? []).find((s) => s.kind === 'behind');
  if (behind?.label) lines.push(`Also: ${behind.label} ${tgtOf(pr)}.`);
  if (!pr.mine) {
    const owner = pr.author?.name || 'someone else';
    lines.push(`Owner: ${owner}, not me. Don't push to their branch: tell me what needs to change, or ask me first.`);
  }
  const steps = [];
  for (const kind of new Set(sigs.map((s) => s.kind))) {
    const convention = text(ctx?.fixPrompts?.[kind]);
    for (const step of stepTexts(pr, kind)) {
      const prefix = `${steps.length + 1}. `;
      steps.push(`${prefix}${step}${convention ? `\n${' '.repeat(prefix.length)}Project convention: ${convention}` : ''}`);
    }
  }
  return `${lines.join('\n')}\n\n${steps.join('\n')}`;
}

// Closing, then "My setup": `all` first, then the notes of the hosts present, in HOST_ORDER.
function ending(prs, ctx) {
  const notes = ctx?.fixNotes ?? {};
  const hosts = new Set(prs.map((pr) => pr.host));
  const parts = [text(notes.all), ...HOST_ORDER.filter((h) => hosts.has(h)).map((h) => text(notes[h]))].filter(Boolean);
  return parts.length ? `${CLOSING}\n\nMy setup: ${parts.join(' ')}` : CLOSING;
}

export function promptFor(pr, ctx) {
  const sigs = fixableSignals(pr);
  if (sigs.length === 0) return null;
  return `Fix ${prName(pr)} (${labelsOf(sigs)}).\n\n${body(pr, sigs, ctx)}\n\n${ending([pr], ctx)}`;
}

// SPEC "Fix all" order: shared package repos (0), their consumers (1), the rest (2).
function tierOf(pr, packages) {
  const same = (r) => r?.repo === pr.repo && (!r.host || r.host === pr.host);
  if (packages.some(same)) return 0;
  if (packages.some((p) => (p.consumers ?? []).some(same))) return 1;
  return 2;
}

function orderLine(ranked) {
  const names = (tier) => [...new Set(ranked.filter((x) => x.tier === tier).map((x) => x.pr.repoShort || x.pr.repo))];
  const shared = names(0);
  if (shared.length === 0) return 'One commit per repo.';
  const consumers = names(1);
  const many = shared.length > 1;
  const then = consumers.length ? `, then ${many ? 'their' : 'its'} consumers (${consumers.join(', ')})` : '';
  return `Work in this order: ${shared.join(', ')} (shared package${many ? 's' : ''}) first${then}, then the rest. One commit per repo.`;
}

export function bundlePrompt(prs, groupLabel, ctx) {
  const packages = Array.isArray(ctx?.sharedPackages) ? ctx.sharedPackages.filter(Boolean) : [];
  const ranked = (prs ?? [])
    .map((pr, i) => ({ pr, i, sigs: fixableSignals(pr), tier: tierOf(pr, packages) }))
    .filter((x) => x.sigs.length > 0)
    .sort((a, b) => a.tier - b.tier || a.i - b.i);
  if (ranked.length === 0) return null;
  const list = ranked.map(({ pr, sigs }) => `- ${prName(pr)}: ${labelsOf(sigs)}`).join('\n');
  const group = text(ctx?.fixPrompts?.group);
  const order = `${orderLine(ranked)}${group ? `\nProject convention: ${group}` : ''}`;
  const sections = ranked.map(({ pr, sigs }) => `## ${prName(pr)}\n${body(pr, sigs, ctx)}`).join('\n\n');
  return `Unblock the PRs of ${groupLabel || 'this group'}:\n${list}\n\n${order}\n\n${sections}\n\n`
    + ending(ranked.map((x) => x.pr), ctx);
}
