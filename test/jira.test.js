import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectJira, jiraSites } from '../src/sources/jira.js';
import { HttpError } from '../src/http.js';

const hit = JSON.parse(readFileSync(new URL('./fixtures/jira/SHOP-42.json', import.meta.url), 'utf8'));
const OPS_HIT = JSON.parse(readFileSync(new URL('./fixtures/jira/OPS-7.json', import.meta.url), 'utf8'));
const MAIN = '00000000-0000-4000-8000-000000000000';
const OPS = '00000000-0000-4000-8000-000000000001';
const sites = {
  main: { cloudId: MAIN, browse: { SHOP: 'https://jira.example.com/browse/{key}' } },
  ops: { cloudId: OPS, browse: { OPS: null } },
};
const MIN = 60_000;
const auth = (value = 'Basic x') => async () => value;

function fakeHttp(handler) {
  const calls = [];
  return { calls, get: async (url, opts) => { calls.push({ url, opts }); return handler(url); } };
}
const keyOf = (url) => /issue\/([^?]+)/.exec(url)[1];
const ok = () => fakeHttp((url) => {
  if (keyOf(url) === 'SHOP-42') return hit;
  if (keyOf(url) === 'OPS-7') return OPS_HIT;
  throw new HttpError({ status: 404, url });
});
const run = (keysBySite, extra = {}) => collectJira(keysBySite, { sites, http: extra.http ?? ok(), auth: extra.auth ?? auth(), cache: extra.cache ?? new Map(), now: extra.now ?? 0 });

test('maps a hit to status, summary and the browse url, through the gateway of its site', async () => {
  const http = fakeHttp(() => hit);
  const { tickets, errors } = await run({ main: ['SHOP-42'] }, { http });
  assert.deepEqual(tickets['SHOP-42'], { status: 'PULL REQUEST', summary: hit.fields.summary, url: 'https://jira.example.com/browse/SHOP-42' });
  assert.equal(errors, undefined);
  assert.equal(http.calls[0].url, `https://api.atlassian.com/ex/jira/${MAIN}/rest/api/3/issue/SHOP-42?fields=status,summary`);
  assert.equal(http.calls[0].opts.auth, 'Basic x');
  assert.equal(http.calls[0].opts.headers.Accept, 'application/json');
  assert.equal(http.calls[0].opts.method, undefined);
});

test('two sites: each key goes to the cloud id of its site; a null browse gives url null', async () => {
  const http = ok();
  const { tickets, errors } = await run({ main: ['SHOP-42'], ops: ['OPS-7'] }, { http });
  assert.equal(errors, undefined);
  assert.deepEqual(http.calls.map((c) => c.url).sort(), [
    `https://api.atlassian.com/ex/jira/${MAIN}/rest/api/3/issue/SHOP-42?fields=status,summary`,
    `https://api.atlassian.com/ex/jira/${OPS}/rest/api/3/issue/OPS-7?fields=status,summary`,
  ]);
  assert.deepEqual(tickets['OPS-7'], { status: 'In Progress', summary: OPS_HIT.fields.summary, url: null });
  assert.equal(tickets['SHOP-42'].url, 'https://jira.example.com/browse/SHOP-42');
  for (const t of Object.values(tickets)) assert.ok(!String(t.url).includes('atlassian'));
});

test('404 gives null status and summary, not an error, and is cached', async () => {
  const http = fakeHttp((url) => { throw new HttpError({ status: 404, url }); });
  const cache = new Map();
  const r = await run({ main: ['SHOP-999999'] }, { http, cache });
  assert.deepEqual(r.tickets['SHOP-999999'], { status: null, summary: null, url: 'https://jira.example.com/browse/SHOP-999999' });
  assert.equal(r.errors, undefined);
  await run({ main: ['SHOP-999999'] }, { http, cache, now: MIN });
  assert.equal(http.calls.length, 1);
});

test('cache reused within 10 min and refetched after; keyed per site', async () => {
  const http = fakeHttp(() => hit);
  const cache = new Map();
  await run({ main: ['SHOP-42'] }, { http, cache, now: 0 });
  const r = await run({ main: ['SHOP-42'] }, { http, cache, now: 10 * MIN - 1 });
  assert.equal(http.calls.length, 1);
  assert.equal(r.tickets['SHOP-42'].status, 'PULL REQUEST');
  assert.ok([...cache.keys()].every((k) => k.startsWith('jira:')));
  await run({ main: ['SHOP-42'] }, { http, cache, now: 10 * MIN });
  assert.equal(http.calls.length, 2);
});

test('error keeps older cached value and adds an errors entry without auth', async () => {
  const cache = new Map();
  await run({ main: ['SHOP-42'] }, { http: fakeHttp(() => hit), auth: auth('Basic SECRET'), cache, now: 0 });
  const failing = fakeHttp((url) => { throw new HttpError({ status: 503, url }); });
  const r = await run({ main: ['SHOP-42', 'SHOP-1'] }, { http: failing, auth: auth('Basic SECRET'), cache, now: 11 * MIN });
  assert.equal(r.tickets['SHOP-42'].status, 'PULL REQUEST');
  assert.equal(r.tickets['SHOP-1'], undefined);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0], /SHOP-42.*503/);
  assert.ok(r.errors.every((e) => !e.includes('SECRET')));
});

test('a site that is not configured is an error for its keys, with no call', async () => {
  const http = ok();
  const r = await run({ nope: ['SHOP-42'] }, { http });
  assert.deepEqual(r.tickets, {});
  assert.deepEqual(r.errors, ['jira SHOP-42: no Jira site `nope`']);
  assert.equal(http.calls.length, 0);
});

test('duplicate keys fetched once; no keys → no calls and no auth', async () => {
  const http = ok();
  const r = await run({ main: ['SHOP-42', 'SHOP-42', 'SHOP-2'] }, { http });
  assert.equal(http.calls.length, 2);
  assert.deepEqual(Object.keys(r.tickets).sort(), ['SHOP-2', 'SHOP-42']);

  let authCalls = 0;
  const none = await run({}, { http, auth: async () => (authCalls++, 'x') });
  assert.deepEqual(none, { tickets: {} });
  assert.equal(authCalls, 0);
});

test('at most 5 requests in flight', async () => {
  let inFlight = 0, max = 0;
  const http = { get: async () => { inFlight++; max = Math.max(max, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return hit; } };
  const keys = Array.from({ length: 12 }, (_, i) => `SHOP-${i}`);
  await run({ main: keys }, { http });
  assert.equal(max, 5);
});

test('jiraSites: cloud id per site and the browse template per prefix from the matchers', () => {
  const project = {
    tickets: [
      { prefix: 'SHOP', browse: 'https://jira.example.com/browse/{key}', jira: 'main' },
      { prefix: 'ops', browse: null, jira: 'main' },
      { prefix: 'DOC', browse: 'https://docs.example.com/{key}' },
      { link: 'trello.com/c/' },
    ],
    jira: { main: { cloudId: MAIN }, spare: { cloudId: OPS } },
  };
  assert.deepEqual(jiraSites(project), {
    main: { cloudId: MAIN, browse: { SHOP: 'https://jira.example.com/browse/{key}', OPS: null } },
    spare: { cloudId: OPS, browse: {} },
  });
  assert.deepEqual(jiraSites({}), {});
});
