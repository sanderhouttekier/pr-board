import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devStubBoard } from '../scripts/dev-stub.js';

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

const quiet = { log: () => {} };

test('dev stub: two made-up projects, fixture-shaped PRs, no upstream', async () => {
  const board = devStubBoard(quiet);
  assert.deepEqual(board.ids(), ['acme', 'nova']);
  board.snapshot('acme');
  board.snapshot('nova');
  await flush();
  const acme = board.snapshot('acme');
  assert.equal(acme.project.title, 'Acme');
  assert.equal(acme.project.error, null);
  assert.ok(acme.prs.length >= 8);
  assert.ok(acme.prs.some((p) => p.ticketKey === 'SHOP-42'));
  assert.ok(acme.prs.some((p) => p.release));
  assert.deepEqual(acme.tickets['SHOP-42'], { label: 'SHOP-42', url: 'https://jira.example.com/browse/SHOP-42', status: 'In Progress', summary: 'Invoice export' });
  assert.ok(Object.values(acme.tickets).some((t) => t.label === '#95'), 'a Trello link Ticket');
  assert.deepEqual(acme.fix.sharedPackages.map((s) => [s.repoShort, s.consumers.map((c) => c.repoShort)]), [['shared', ['backend', 'worker']]]);
  for (const name of ['github', 'bitbucket', 'jira']) assert.equal(acme.sources[name].ok, true, name);
  const nova = board.snapshot('nova');
  assert.equal(nova.project.title, 'Nova Labs');
  assert.deepEqual(nova.project.warnings, ['nova.json: Unknown key `colour`, ignored']);
  const tabs = board.list().projects;
  assert.deepEqual(tabs.map((t) => [t.id, t.count]), [['acme', 1], ['nova', 1]]);
  for (const s of [acme, nova]) for (const p of s.prs) assert.equal('description' in p, false);
});

test('dev stub: an optional third project with a config error', () => {
  const board = devStubBoard({ ...quiet, broken: true });
  assert.deepEqual(board.ids(), ['acme', 'nova', 'broken']);
  assert.match(board.list().projects[2].error, /broken\.json: /);
});
