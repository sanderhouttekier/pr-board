// The PR detail readers (SPEC "PR detail"): description and comments of one PR, read on demand.
// Run through the real http.js over a fake fetch, so pagination (Link header, Bitbucket `next`) runs for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHttp, HttpError } from '../src/http.js';
import { githubDetail } from '../src/sources/github.js';
import { bitbucketDetail } from '../src/sources/bitbucket.js';

const FIX = new URL('./fixtures/', import.meta.url);
const fixture = (name) => JSON.parse(readFileSync(new URL(name, FIX), 'utf8'));
const GH_AUTH = 'Bearer ghp_TESTONLY_not_a_real_token';
const BB_AUTH = 'Basic dGVzdDp0ZXN0LXNlY3JldA==';

// `routes`: URL -> { file | body | status, link }. Anything else is a 404.
function httpOver(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = routes[String(url)];
    if (!r) return new Response('{"message":"Not Found"}', { status: 404 });
    if (r.status && r.status !== 200) return new Response('{"message":"boom"}', { status: r.status });
    const body = r.file ? fixture(r.file) : r.body;
    return new Response(JSON.stringify(body), { status: 200, headers: r.link ? { link: r.link } : {} });
  };
  return { http: createHttp({ fetch }), calls };
}

// --- GitHub ---

const GH = 'https://api.github.com/repos/acme-corp/acme-api';
const GH_PULL = `${GH}/pulls/101`;
const GH_ISSUE_1 = `${GH}/issues/101/comments?per_page=100`;
const GH_ISSUE_2 = 'https://api.github.com/repositories/1/issues/101/comments?per_page=100&page=2';
const GH_REVIEW = `${GH}/pulls/101/comments?per_page=100`;
const GH_ROUTES = {
  [GH_PULL]: { file: 'github/detail-pull-101.json' },
  [GH_ISSUE_1]: { file: 'github/detail-issue-comments-101-1.json', link: `<${GH_ISSUE_2}>; rel="next", <${GH_ISSUE_2}>; rel="last"` },
  [GH_ISSUE_2]: { file: 'github/detail-issue-comments-101-2.json' },
  [GH_REVIEW]: { file: 'github/detail-review-comments-101.json' },
};
const ghArgs = (http, number = 101) => ({ http, auth: GH_AUTH, owner: 'acme-corp', repo: 'acme-api', number });

test('githubDetail: description from body, general comments (all pages) then inline review comments', async () => {
  const { http, calls } = httpOver(GH_ROUTES);
  const d = await githubDetail(ghArgs(http));
  assert.match(d.description, /^## What\n/);
  assert.deepEqual(d.comments, [
    { author: 'ada', bot: false, createdAt: '2026-11-10T09:00:00Z', body: 'Looks good, one question below.', path: null, line: null },
    { author: 'grace', bot: false, createdAt: '2026-11-10T09:30:00Z', body: 'Answered inline.', path: null, line: null },
    { author: 'acme-ci[bot]', bot: true, createdAt: '2026-11-10T08:15:00Z', body: 'Preview deployed: https://preview.example.com/101', path: null, line: null },
    { author: 'ada', bot: false, createdAt: '2026-11-10T09:10:00Z', body: 'Should this be `encodeURIComponent`?', path: 'src/login/redirect.ts', line: 12 },
    { author: 'linus', bot: false, createdAt: '2026-11-10T09:20:00Z', body: 'This line moved in the last push.', path: 'src/login/redirect.ts', line: 7 },
  ]);
  assert.deepEqual(calls.map((c) => c.url).sort(), [GH_ISSUE_1, GH_ISSUE_2, GH_PULL, GH_REVIEW].sort());
  for (const c of calls) {
    assert.equal(c.init.method, 'GET');
    assert.equal(c.init.headers.Authorization, GH_AUTH);
    assert.equal(c.init.headers.Accept, 'application/vnd.github+json');
  }
});

test('githubDetail: an empty body is a null description; no comments is an empty list', async () => {
  const { http } = httpOver({
    [`${GH}/pulls/102`]: { file: 'github/detail-pull-102.json' },
    [`${GH}/issues/102/comments?per_page=100`]: { body: [] },
    [`${GH}/pulls/102/comments?per_page=100`]: { body: [] },
  });
  assert.deepEqual(await githubDetail(ghArgs(http, 102)), { description: null, comments: [] });
});

test('githubDetail: a failing read rejects with an HttpError that carries no token', async () => {
  const { http } = httpOver({ ...GH_ROUTES, [GH_REVIEW]: { status: 502 } });
  await assert.rejects(githubDetail(ghArgs(http)), (err) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 502);
    assert.doesNotMatch(JSON.stringify(err) + err.message, /TESTONLY/);
    return true;
  });
});

// --- Bitbucket ---

const BB = 'https://api.bitbucket.org/2.0/repositories/acme/acme-backend/pullrequests';
const BB_PR = `${BB}/12`;
const BB_COMMENTS_1 = `${BB}/12/comments?pagelen=100`;
const BB_COMMENTS_2 = `${BB}/12/comments?pagelen=100&page=2`;
const BB_ROUTES = {
  [BB_PR]: { file: 'bitbucket/detail-pr-12.json' },
  [BB_COMMENTS_1]: { file: 'bitbucket/detail-comments-12-1.json' },
  [BB_COMMENTS_2]: { file: 'bitbucket/detail-comments-12-2.json' },
};
const bbArgs = (http, number = 12) => ({ http, auth: BB_AUTH, owner: 'acme', repo: 'acme-backend', number });

test('bitbucketDetail: description, every page of comments, deleted ones skipped, inline path and line', async () => {
  const { http, calls } = httpOver(BB_ROUTES);
  const d = await bitbucketDetail(bbArgs(http));
  assert.match(d.description, /^## What\n/);
  assert.deepEqual(d.comments, [
    { author: 'Grace Example', bot: false, createdAt: '2026-11-10T09:00:00.000000+00:00', body: 'Can we stream this instead?', path: null, line: null },
    { author: 'ada', bot: false, createdAt: '2026-11-10T08:30:00.000000+00:00', body: 'Typo in the header name.', path: 'src/Invoice/Export.php', line: 42 },
    { author: 'Grace Example', bot: false, createdAt: '2026-11-10T08:40:00.000000+00:00', body: 'Why was this removed?', path: 'src/Invoice/Legacy.php', line: 7 },
  ]);
  assert.deepEqual(calls.map((c) => c.url).sort(), [BB_COMMENTS_1, BB_COMMENTS_2, BB_PR].sort());
  for (const c of calls) {
    assert.equal(c.init.method, 'GET');
    assert.equal(c.init.headers.Authorization, BB_AUTH);
  }
});

test('bitbucketDetail: empty description is null; summary.raw is the fallback; a missing user is unknown', async () => {
  const { http } = httpOver({
    [`${BB}/13`]: { file: 'bitbucket/detail-pr-13.json' },
    [`${BB}/13/comments?pagelen=100`]: { body: { values: [] } },
  });
  assert.deepEqual(await bitbucketDetail(bbArgs(http, 13)), { description: null, comments: [] });

  const { http: http2 } = httpOver({
    [`${BB}/14`]: { body: { id: 14, summary: { raw: 'From the summary' } } },
    [`${BB}/14/comments?pagelen=100`]: { body: { values: [{ created_on: '2026-11-10T08:00:00Z', content: { raw: 'x' } }] } },
  });
  assert.deepEqual(await bitbucketDetail(bbArgs(http2, 14)), {
    description: 'From the summary',
    comments: [{ author: 'unknown', bot: false, createdAt: '2026-11-10T08:00:00Z', body: 'x', path: null, line: null }],
  });
});

test('bitbucketDetail: a failing read rejects with an HttpError that carries no token', async () => {
  const { http } = httpOver({ ...BB_ROUTES, [BB_PR]: { status: 500 } });
  await assert.rejects(bitbucketDetail(bbArgs(http)), (err) => {
    assert.ok(err instanceof HttpError);
    assert.doesNotMatch(JSON.stringify(err) + err.message, /dGVzdDp0ZXN0LXNlY3JldA/);
    return true;
  });
});
