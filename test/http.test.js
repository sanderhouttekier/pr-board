import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as httpModule from '../src/http.js';
import { createHttp, HttpError } from '../src/http.js';

const AUTH = 'Bearer ghp_TOPSECRET_abc123';

// Fake fetch driven by a handler; records every call.
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

const json = (body, { status = 200, headers = {} } = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('module exports only createHttp and HttpError (no method-taking helpers)', () => {
  assert.deepEqual(Object.keys(httpModule).sort(), ['HttpError', 'createHttp']);
  const h = createHttp({ fetch: fakeFetch(() => json({})) });
  assert.deepEqual(Object.keys(h).sort(), ['get', 'getAll', 'stats']);
});

test('get: always GET, sends auth, parses JSON', async () => {
  const f = fakeFetch(() => json({ ok: 1 }));
  const h = createHttp({ fetch: f });
  assert.deepEqual(await h.get('https://api.github.com/x', { auth: AUTH, headers: { Accept: 'a/b' } }), { ok: 1 });
  assert.equal(f.calls[0].init.method, 'GET');
  assert.equal(f.calls[0].init.headers.Authorization, AUTH);
  assert.equal(f.calls[0].init.headers.Accept, 'a/b');
});

test('get: as text returns raw text', async () => {
  const h = createHttp({ fetch: fakeFetch(() => new Response('{"raw": true}')) });
  assert.equal(await h.get('https://x/y', { as: 'text' }), '{"raw": true}');
});

test('get: method guard rejects any non-GET method, accepts explicit GET', async () => {
  const f = fakeFetch(() => json({}));
  const h = createHttp({ fetch: f });
  for (const method of ['POST', 'put', 'DELETE', 'PATCH', 'HEAD']) {
    await assert.rejects(h.get('https://x/y', { method }), /GET/);
  }
  assert.equal(f.calls.length, 0);
  await h.get('https://x/y', { method: 'get' });
  assert.equal(f.calls[0].init.method, 'GET');
});

test('get: caller headers cannot smuggle a method override or replace Authorization casing', async () => {
  const f = fakeFetch(() => json({}));
  const h = createHttp({ fetch: f });
  await assert.rejects(h.get('https://x/y', { headers: { 'X-HTTP-Method-Override': 'DELETE' } }), /GET/);
  assert.equal(f.calls.length, 0);
});

test('ETag: sends If-None-Match / If-Modified-Since and reuses cached body on 304', async () => {
  const f = fakeFetch((url, init, n) =>
    n === 1
      ? json([{ id: 1 }], { headers: { etag: 'W/"abc"', 'last-modified': 'Wed, 05 Nov 2026 10:00:00 GMT' } })
      : new Response(null, { status: 304 }));
  const h = createHttp({ fetch: f });
  const first = await h.get('https://api.github.com/r', { auth: AUTH });
  first.push('mutated by caller');
  const second = await h.get('https://api.github.com/r', { auth: AUTH });
  assert.deepEqual(second, [{ id: 1 }]);
  assert.equal(f.calls[0].init.headers['If-None-Match'], undefined);
  assert.equal(f.calls[1].init.headers['If-None-Match'], 'W/"abc"');
  assert.equal(f.calls[1].init.headers['If-Modified-Since'], 'Wed, 05 Nov 2026 10:00:00 GMT');
  const s = h.stats()['api.github.com'];
  assert.equal(s.requests, 2);
  assert.equal(s.notModified, 1);
});

test('ETag cache is bounded: least recently used entry is evicted past maxCacheEntries', async () => {
  const f = fakeFetch(() => json({ ok: 1 }, { headers: { etag: '"e"' } }));
  const h = createHttp({ fetch: f, maxCacheEntries: 2 });
  await h.get('https://x/a');
  await h.get('https://x/b');
  await h.get('https://x/a'); // touch a → b is now least recently used
  await h.get('https://x/c'); // evicts b
  await h.get('https://x/b');
  await h.get('https://x/a');
  const sentEtag = (i) => f.calls[i].init.headers['If-None-Match'];
  assert.equal(sentEtag(4), undefined, 'b was evicted, so no conditional request');
  assert.equal(sentEtag(5), undefined, 'a was evicted when b came back');
  assert.equal(sentEtag(2), '"e"');
});

test('ETag cache is keyed per auth identity', async () => {
  const f = fakeFetch(() => json({ v: 1 }, { headers: { etag: '"e1"' } }));
  const h = createHttp({ fetch: f });
  await h.get('https://x/r', { auth: AUTH });
  await h.get('https://x/r', { auth: 'Basic other' });
  assert.equal(f.calls[1].init.headers['If-None-Match'], undefined);
  await h.get('https://x/r', { auth: AUTH });
  assert.equal(f.calls[2].init.headers['If-None-Match'], '"e1"');
});

test('non-2xx: HttpError with status, url, short excerpt, no auth leakage', async () => {
  const body = 'x'.repeat(1000);
  const f = fakeFetch(() => new Response(body, { status: 403 }));
  const h = createHttp({ fetch: f });
  const url = 'https://api.github.com/repos/o/r/pulls';
  await assert.rejects(h.get(url, { auth: AUTH }), (err) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 403);
    assert.equal(err.url, url);
    assert.ok(err.body.length <= 200);
    assert.ok(!err.message.includes(AUTH));
    assert.ok(!err.message.includes('TOPSECRET'));
    assert.ok(!JSON.stringify(err).includes('TOPSECRET'));
    assert.ok(!String(err.stack).includes('TOPSECRET'));
    return true;
  });
});

test('error body that echoes the auth value is redacted', async () => {
  const f = fakeFetch(() => new Response(`bad token ${AUTH}`, { status: 401 }));
  const h = createHttp({ fetch: f });
  await assert.rejects(h.get('https://x/y', { auth: AUTH }), (err) => {
    assert.ok(!JSON.stringify(err).includes('TOPSECRET'));
    assert.ok(!err.message.includes('TOPSECRET'));
    return true;
  });
});

test('rate-limit headers tracked per host', async () => {
  const f = fakeFetch(() => json({}, { headers: { 'x-ratelimit-remaining': '4321', 'x-ratelimit-reset': '1799999999' } }));
  const h = createHttp({ fetch: f });
  await h.get('https://api.github.com/a');
  await h.get('https://api.bitbucket.org/b');
  const s = h.stats();
  assert.equal(s['api.github.com'].rateLimitRemaining, 4321);
  assert.equal(s['api.github.com'].rateLimitReset, 1799999999);
  assert.equal(s['api.bitbucket.org'].requests, 1);
});

test('timeout aborts the request and throws', async () => {
  const f = fakeFetch((url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')));
  }));
  const h = createHttp({ fetch: f, timeoutMs: 20 });
  await assert.rejects(h.get('https://x/slow', { auth: AUTH }), (err) => {
    assert.ok(err instanceof HttpError);
    assert.match(err.message, /timeout/i);
    assert.ok(!JSON.stringify(err).includes('TOPSECRET'));
    return true;
  });
});

test('getAll: GitHub Link rel="next" pagination concatenates arrays', async () => {
  const base = 'https://api.github.com/repos/o/r/pulls';
  const f = fakeFetch((url) => {
    if (url === base) return json([1, 2], { headers: { link: `<${base}?page=2>; rel="next", <${base}?page=3>; rel="last"` } });
    if (url === `${base}?page=2`) return json([3], { headers: { link: `<${base}?page=3>; rel="next"` } });
    return json([4]);
  });
  const h = createHttp({ fetch: f });
  assert.deepEqual(await h.getAll(base, { auth: AUTH }), [1, 2, 3, 4]);
  assert.ok(f.calls.every((c) => c.init.method === 'GET'));
});

test('getAll: Bitbucket body.next pagination concatenates values', async () => {
  const base = 'https://api.bitbucket.org/2.0/repositories/acme/x/pullrequests';
  const f = fakeFetch((url) =>
    url === base
      ? json({ values: [{ id: 1 }], next: `${base}?page=2` })
      : json({ values: [{ id: 2 }, { id: 3 }] }));
  const h = createHttp({ fetch: f });
  assert.deepEqual(await h.getAll(base), [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test('getAll: caps at 20 pages', async () => {
  const f = fakeFetch((url, init, n) => json({ values: [n], next: `https://api.bitbucket.org/p?page=${n + 1}` }));
  const h = createHttp({ fetch: f });
  const all = await h.getAll('https://api.bitbucket.org/p');
  assert.equal(f.calls.length, 20);
  assert.equal(all.length, 20);
});

test('getAll: never follows a next link to another origin (auth would leak)', async () => {
  const f = fakeFetch(() => json({ values: [1], next: 'https://evil.example/steal' }));
  const h = createHttp({ fetch: f });
  await assert.rejects(h.getAll('https://api.bitbucket.org/p', { auth: AUTH }), /origin/);
  assert.equal(f.calls.length, 1);
});

test('getAll: 304 on a page reuses cached Link for further pages', async () => {
  const base = 'https://api.github.com/p';
  let round = 1;
  const f = fakeFetch((url) => {
    if (round === 2) return new Response(null, { status: 304 });
    return url === base
      ? json([1], { headers: { etag: '"p1"', link: `<${base}?page=2>; rel="next"` } })
      : json([2], { headers: { etag: '"p2"' } });
  });
  const h = createHttp({ fetch: f });
  assert.deepEqual(await h.getAll(base), [1, 2]);
  round = 2;
  assert.deepEqual(await h.getAll(base), [1, 2]);
  assert.equal(f.calls.length, 4);
});
