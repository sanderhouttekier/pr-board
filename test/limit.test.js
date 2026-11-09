import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit } from '../src/limit.js';

test('mapLimit keeps order and never runs more than `limit` at once', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n, i) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, n));
    running -= 1;
    return `${i}:${n}`;
  });
  assert.deepEqual(out, ['0:5', '1:1', '2:4', '3:2', '4:3']);
  assert.equal(peak, 2);
});

test('mapLimit rejects with the first error', async () => {
  await assert.rejects(mapLimit([1, 2], 2, async (n) => { if (n === 2) throw new Error('boom'); return n; }), /boom/);
});

test('mapLimit on an empty list resolves to []', async () => {
  assert.deepEqual(await mapLimit([], 3, async () => 1), []);
});
