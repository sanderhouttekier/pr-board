// The PR detail panel (SPEC "Page", "PR detail panel"): text rendering, state helpers, model and render.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderText,
  clampPanelWidth,
  parsePanelWidth,
  PANEL_DEFAULT_W,
  togglePanel,
  panelTab,
  panelLoading,
  panelResult,
  panelOnSnapshot,
  panelModel,
  renderPanel,
} from '../public/view.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-06T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

const pr = (over = {}) => ({
  id: 'github:acme-api#12',
  host: 'github',
  repo: 'acme-api',
  repoShort: 'api',
  number: 12,
  title: 'SHOP-42 Invoice export',
  url: 'https://example.test/acme-api/pull/12',
  author: { name: 'Ada', id: 'ada' },
  source: 'feature/SHOP-42-invoice-export',
  target: 'develop',
  createdAt: iso(NOW - 3 * DAY),
  updatedAt: iso(NOW - HOUR),
  ...over,
});

const comment = (over = {}) => ({
  author: 'grace',
  bot: false,
  createdAt: iso(NOW - 2 * HOUR),
  body: 'Looks good.',
  path: null,
  line: null,
  ...over,
});

const ok = (body) => ({ ok: true, body });
const fail = (error) => ({ ok: false, error });

// An open panel with its first request (seq) answered by `result`.
function opened(result, over = {}, seq = 1) {
  const s = panelLoading(togglePanel(null, pr(over)), seq);
  return result ? panelResult(s, seq, result) : s;
}

describe('renderText', () => {
  test('empty input renders nothing', () => {
    assert.equal(renderText(null), '');
    assert.equal(renderText(''), '');
    assert.equal(renderText(undefined), '');
  });

  test('plain lines, blank line as one gap, CRLF normalised', () => {
    assert.equal(renderText('one\r\ntwo\n\n\nthree'), '<div>one</div><div>two</div><div class="t-gap"></div><div>three</div>');
  });

  test('headings # to ###### as bold lines; # without a space is a plain line', () => {
    assert.equal(renderText('# What'), '<div class="t-h">What</div>');
    assert.equal(renderText('###### Six'), '<div class="t-h">Six</div>');
    assert.equal(renderText('####### seven'), '<div>####### seven</div>');
    assert.equal(renderText('#12 fixed'), '<div>#12 fixed</div>');
  });

  test('- and * lines as bullet lines', () => {
    assert.equal(renderText('- one\n* two\n  - nested'), '<div class="t-li">one</div><div class="t-li">two</div><div class="t-li">nested</div>');
    assert.equal(renderText('-not a bullet'), '<div>-not a bullet</div>');
  });

  test('inline code', () => {
    assert.equal(renderText('rename `rows` to `lines`'), '<div>rename <code>rows</code> to <code>lines</code></div>');
  });

  test('fenced blocks become <pre>, info string dropped, content escaped and not processed', () => {
    const h = renderText('before\n```js\nconst a = `x`;\n# not a heading\nhttps://example.test <b>\n```\nafter');
    assert.equal(h, '<div>before</div><pre>const a = `x`;\n# not a heading\nhttps://example.test &lt;b&gt;</pre><div>after</div>');
  });

  test('an unterminated fence runs to the end, still escaped', () => {
    assert.equal(renderText('x\n```\n<script>alert(1)</script>\n- y'), '<div>x</div><pre>&lt;script&gt;alert(1)&lt;/script&gt;\n- y</pre>');
  });

  test('http and https URLs become links that open in a new tab', () => {
    assert.equal(
      renderText('See https://example.test/a?b=1&c=2 and http://x.test.'),
      '<div>See <a href="https://example.test/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">https://example.test/a?b=1&amp;c=2</a>'
      + ' and <a href="http://x.test" target="_blank" rel="noopener noreferrer">http://x.test</a>.</div>',
    );
  });

  test('a trailing ) closes the sentence unless the URL opened one', () => {
    assert.match(renderText('(see https://x.test/a)'), /href="https:\/\/x\.test\/a"/);
    assert.match(renderText('https://x.test/wiki/A_(b)'), /href="https:\/\/x\.test\/wiki\/A_\(b\)"/);
  });

  test('URLs inside inline code stay code', () => {
    assert.equal(renderText('`https://x.test`'), '<div><code>https://x.test</code></div>');
  });

  test('never links other schemes', () => {
    for (const s of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'file:///etc/passwd']) {
      const h = renderText(s);
      assert.ok(!h.includes('<a '), `${s} → ${h}`);
    }
  });

  test('javascript: in front of an http URL only links the http part', () => {
    const h = renderText('javascript:https://x.test');
    assert.match(h, /<a href="https:\/\/x\.test"/);
    assert.ok(!h.includes('href="javascript'));
  });

  test('escapes HTML everywhere', () => {
    const evil = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '# <img src=x onerror=alert(1)>',
      '- <svg onload=alert(1)>',
      '`<b>x</b>`',
      "it's \"quoted\" & done",
    ].join('\n');
    const h = renderText(evil);
    assert.ok(!/<(script|img|svg|b)\b/.test(h), h);
    assert.ok(h.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(h.includes('<div class="t-h">&lt;img src=x onerror=alert(1)&gt;</div>'));
    assert.ok(h.includes('<code>&lt;b&gt;x&lt;/b&gt;</code>'));
    assert.ok(h.includes('it&#39;s &quot;quoted&quot; &amp; done'));
  });

  test('"><svg onload> inside or right after a URL never leaves the href', () => {
    for (const body of [
      'https://x.test/"><svg onload=alert(1)>',
      'https://x.test/a"onmouseover="alert(1)',
      "https://x.test/a'onmouseover='alert(1)",
      'https://x.test/<svg/onload=alert(1)>',
      'https://x.test/&quot;&gt;&lt;svg onload=alert(1)&gt;',
    ]) {
      const h = renderText(body);
      assert.ok(!/<svg/i.test(h), h);
      const hrefs = [...h.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]);
      assert.equal(hrefs.length, 1, h);
      assert.match(hrefs[0], /^https:\/\/x\.test\/[^"<>' ]*$/, h);
      assert.ok(!/&(quot|lt|gt|#39);/.test(hrefs[0]), `no escaped quote or angle bracket in the href: ${hrefs[0]}`);
      // Every tag in the output is one we made.
      for (const tag of h.match(/<[a-z][^>]*>/gi)) assert.match(tag, /^<(div|a|code|pre)( |>)/, tag);
    }
  });

  test('backticks inside a code block are left alone', () => {
    assert.equal(renderText('```\na `b` c\n```'), '<pre>a `b` c</pre>');
  });
});

describe('panel width', () => {
  test('default 460', () => assert.equal(PANEL_DEFAULT_W, 460));

  test('clamped to [320, viewport - 480], rounded', () => {
    assert.equal(clampPanelWidth(460, 1400), 460);
    assert.equal(clampPanelWidth(100, 1400), 320);
    assert.equal(clampPanelWidth(2000, 1400), 920);
    assert.equal(clampPanelWidth(500.6, 1400), 501);
    assert.equal(clampPanelWidth(600, 700), 320, 'never below the minimum, even when the window is narrow');
    assert.equal(clampPanelWidth(NaN, 1400), 460);
  });

  test('stored value: a number of at least 320, else the default', () => {
    assert.equal(parsePanelWidth('560'), 560);
    assert.equal(parsePanelWidth('2000'), 2000, 'kept; clamped only when applied');
    assert.equal(parsePanelWidth(null), 460);
    assert.equal(parsePanelWidth(''), 460);
    assert.equal(parsePanelWidth('abc'), 460);
    assert.equal(parsePanelWidth('100'), 460);
    assert.equal(parsePanelWidth('Infinity'), 460);
  });
});

describe('panel state', () => {
  test('toggle opens on the Description tab, closes when the same PR is toggled', () => {
    const s = togglePanel(null, pr());
    assert.equal(s.id, 'github:acme-api#12');
    assert.equal(s.tab, 'description');
    assert.equal(s.data, null);
    assert.equal(s.error, null);
    assert.equal(s.gone, false);
    assert.equal(togglePanel(s, pr()), null);
    assert.equal(togglePanel(null, undefined), null, 'unknown PR: nothing opens');
  });

  test('another PR swaps the content but keeps the tab', () => {
    const s = panelTab(opened(ok({ description: 'd', comments: [] })), 'conversation');
    const t = togglePanel(s, pr({ id: 'github:acme-api#13', number: 13 }));
    assert.equal(t.id, 'github:acme-api#13');
    assert.equal(t.tab, 'conversation');
    assert.equal(t.data, null, 'no old content from the other PR');
    assert.equal(panelTab(t, 'nonsense').tab, 'description');
  });

  test('a result is applied only for the latest request (stale responses are ignored)', () => {
    let s = panelLoading(togglePanel(null, pr()), 1);
    s = panelLoading(togglePanel(s, pr({ id: 'github:acme-api#13', number: 13 })), 2);
    const stale = panelResult(s, 1, ok({ description: 'from #12', comments: [] }));
    assert.equal(stale, s, 'unchanged');
    const fresh = panelResult(s, 2, ok({ description: 'from #13', comments: [] }));
    assert.equal(fresh.data.description, 'from #13');
    assert.equal(panelResult(null, 2, ok({})), null, 'closed meanwhile');
  });

  test('a failed first load is an error; a failed refetch keeps the old content', () => {
    const s = opened(fail('upstream failed'));
    assert.equal(s.error, 'upstream failed');
    assert.equal(s.data, null);
    const good = opened(ok({ description: 'd', comments: [] }));
    const again = panelResult(panelLoading(good, 2), 2, fail('boom'));
    assert.equal(again.data.description, 'd');
    assert.equal(again.error, null);
  });

  test('loading clears an earlier error (Try again shows the skeleton)', () => {
    const s = panelLoading(opened(fail('x')), 2);
    assert.equal(s.error, null);
    assert.equal(s.seq, 2);
  });

  test('snapshot: refetch only when updatedAt changed', () => {
    const s = opened(ok({ description: 'd', comments: [] }));
    const same = panelOnSnapshot(s, [pr()]);
    assert.equal(same.refetch, false);
    assert.equal(same.state, s);
    const moved = panelOnSnapshot(s, [pr({ updatedAt: iso(NOW), title: 'New title' })]);
    assert.equal(moved.refetch, true);
    assert.equal(moved.state.pr.title, 'New title', 'header follows the snapshot');
    assert.equal(moved.state.data.description, 'd', 'old content kept until the new arrives');
    assert.equal(panelOnSnapshot(null, [pr()]).state, null);
  });

  test('snapshot: a PR that disappears keeps the panel and its content, marked gone; it can come back', () => {
    const s = opened(ok({ description: 'd', comments: [] }));
    const gone = panelOnSnapshot(s, []);
    assert.equal(gone.refetch, false);
    assert.equal(gone.state.gone, true);
    assert.equal(gone.state.data.description, 'd');
    assert.equal(gone.state.pr.title, 'SHOP-42 Invoice export');
    const back = panelOnSnapshot(gone.state, [pr()]);
    assert.equal(back.state.gone, false);
    assert.equal(back.refetch, false);
  });
});

describe('panelModel', () => {
  test('closed: null', () => {
    assert.equal(panelModel(null, NOW), null);
    assert.equal(renderPanel(null), '');
  });

  test('header fields', () => {
    const vm = panelModel(opened(null), NOW);
    assert.equal(vm.repoShort, 'api');
    assert.equal(vm.number, 12);
    assert.equal(vm.hostLabel, 'GitHub');
    assert.equal(vm.url, 'https://example.test/acme-api/pull/12');
    assert.equal(vm.title, 'SHOP-42 Invoice export');
    assert.equal(vm.author, 'Ada');
    assert.equal(vm.source, 'feature/SHOP-42-invoice-export');
    assert.equal(vm.target, 'develop');
    assert.equal(vm.opened, '3d ago');
    assert.equal(vm.gone, false);
    assert.equal(panelModel(opened(null, { host: 'bitbucket' }), NOW).hostLabel, 'Bitbucket');
    assert.equal(panelModel(opened(null, { url: 'javascript:alert(1)' }), NOW).url, null);
  });

  test('ages: just now, minutes, hours, days', () => {
    const age = (ms) => panelModel(opened(null, { createdAt: iso(NOW - ms) }), NOW).opened;
    assert.equal(age(10_000), 'just now');
    assert.equal(age(5 * 60_000), '5m ago');
    assert.equal(age(3 * HOUR), '3h ago');
    assert.equal(age(2 * DAY), '2d ago');
    assert.equal(age(-HOUR), 'just now', 'clock skew');
    assert.equal(panelModel(opened(null, { createdAt: null }), NOW).opened, null);
  });

  test('loading: count unknown, body loading', () => {
    const vm = panelModel(opened(null), NOW);
    assert.equal(vm.count, null);
    assert.deepEqual(vm.body, { kind: 'loading' });
  });

  test('error', () => {
    const vm = panelModel(opened(fail('upstream failed')), NOW);
    assert.deepEqual(vm.body, { kind: 'error', message: 'upstream failed' });
    assert.equal(vm.count, null);
  });

  test('loaded: description tab and conversation tab', () => {
    const data = {
      description: 'Body',
      comments: [
        comment(),
        comment({ author: 'ci-bot', bot: true, body: 'Coverage 84%', createdAt: iso(NOW - HOUR) }),
        comment({ author: 'linus', path: 'src/a.js', line: 12, createdAt: iso(NOW - 30 * 60_000) }),
        comment({ author: 'ken', path: 'src/b.js', line: null }),
      ],
    };
    const s = opened(ok(data));
    const desc = panelModel(s, NOW);
    assert.equal(desc.count, 4);
    assert.deepEqual(desc.body, { kind: 'description', text: 'Body' });
    const conv = panelModel(panelTab(s, 'conversation'), NOW);
    assert.equal(conv.body.kind, 'conversation');
    assert.deepEqual(conv.body.comments.map((c) => [c.author, c.bot, c.age, c.where]), [
      ['grace', false, '2h ago', null],
      ['ci-bot', true, '1h ago', null],
      ['linus', false, '30m ago', 'src/a.js:12'],
      ['ken', false, '2h ago', 'src/b.js'],
    ]);
  });

  test('empty description (null or blank) and no comments', () => {
    assert.deepEqual(panelModel(opened(ok({ description: '  \n', comments: [] })), NOW).body, { kind: 'description', text: null });
    assert.deepEqual(panelModel(opened(ok({ description: null, comments: [] })), NOW).body, { kind: 'description', text: null });
    const conv = panelModel(panelTab(opened(ok({ description: null, comments: [] })), 'conversation'), NOW);
    assert.deepEqual(conv.body, { kind: 'conversation', comments: [] });
    assert.equal(conv.count, 0);
  });

  test('no longer open', () => {
    const s = panelOnSnapshot(opened(ok({ description: 'd', comments: [] })), []).state;
    assert.equal(panelModel(s, NOW).gone, true);
  });
});

describe('renderPanel', () => {
  const html = (s) => renderPanel(panelModel(s, NOW));
  const loaded = (over = {}) => opened(ok({ description: '## What\nExport', comments: [comment()], ...over }));

  test('grip: a vertical separator that can take focus', () => {
    assert.match(html(loaded()), /^<div class="panel-grip" role="separator" aria-orientation="vertical" aria-label="Resize panel" tabindex="0" title="Drag to resize, double-click to reset"><\/div>/);
  });

  test('header: ref, host link, close button, title, meta', () => {
    const h = html(loaded());
    assert.match(h, /<div class="panel-ref"><span class="ref"><span class="repo">api<\/span> <span class="num">#12<\/span><\/span><a class="panel-link" href="https:\/\/example\.test\/acme-api\/pull\/12" target="_blank" rel="noopener noreferrer">Open on GitHub ↗<\/a><button type="button" class="panel-close" data-action="panel-close" aria-label="Close panel" title="Close \(Esc\)">✕<\/button><\/div>/);
    assert.match(h, /<h2 class="panel-title">SHOP-42 Invoice export<\/h2>/);
    assert.match(h, /<p class="panel-meta">Ada · <code>feature\/SHOP-42-invoice-export<\/code> → <code>develop<\/code> · opened 3d ago<\/p>/);
    assert.ok(!h.includes('No longer open.'));
    assert.ok(!/class="[^"]*\bpanel-open\b/.test(h), 'panel-open is the body class; nothing in the panel may share it');
    assert.match(html(opened(null, { host: 'bitbucket' })), />Open on Bitbucket ↗<\/a>/);
  });

  test('no safe url: no host link', () => {
    const h = html(opened(null, { url: 'javascript:alert(1)' }));
    assert.ok(!h.includes('panel-link'));
    assert.ok(!h.includes('javascript:'));
  });

  test('no longer open: a muted line under the meta', () => {
    const h = html(panelOnSnapshot(loaded(), []).state);
    assert.match(h, /<\/p><p class="panel-gone">No longer open\.<\/p><\/div>/);
  });

  test('tabs: Description selected by default, Conversation with the count', () => {
    const h = html(loaded());
    assert.match(h, /<div class="panel-tabs" role="tablist" aria-label="Details">/);
    assert.match(h, /<button type="button" role="tab" class="panel-tab" id="panel-tab-description" aria-selected="true" aria-controls="panel-body" data-action="panel-tab" data-value="description">Description<\/button>/);
    assert.match(h, /<button type="button" role="tab" class="panel-tab" id="panel-tab-conversation" aria-selected="false" aria-controls="panel-body" data-action="panel-tab" data-value="conversation">Conversation <span class="pill">1<\/span><\/button>/);
    assert.match(h, /<div class="panel-body" id="panel-body" role="tabpanel" aria-labelledby="panel-tab-description">/);
    const c = html(panelTab(loaded(), 'conversation'));
    assert.match(c, /data-value="conversation">Conversation/);
    assert.match(c, /aria-selected="true" aria-controls="panel-body" data-action="panel-tab" data-value="conversation"/);
    assert.match(c, /aria-labelledby="panel-tab-conversation"/);
  });

  test('loading: three skeleton bars and "…" in the pill', () => {
    const h = html(opened(null));
    assert.match(h, /<span class="pill">…<\/span>/);
    assert.match(h, /<div class="panel-loading" role="status" aria-label="Loading"><div><\/div><div><\/div><div><\/div><\/div>/);
  });

  test('error: message and Try again', () => {
    const h = html(opened(fail('<b>upstream</b> failed')));
    assert.match(h, /<p class="panel-error">Couldn't load the details: &lt;b&gt;upstream&lt;\/b&gt; failed<\/p><button type="button" class="panel-retry" data-action="panel-retry">Try again<\/button>/);
    assert.ok(!h.includes('<b>'));
  });

  test('description through renderText; empty description', () => {
    assert.match(html(loaded()), /<div class="panel-text"><div class="t-h">What<\/div><div>Export<\/div><\/div>/);
    assert.match(html(loaded({ description: null })), /<p class="panel-empty">No description\.<\/p>/);
  });

  test('conversation: meta line, inline path:line, bot label, separators by CSS', () => {
    const s = panelTab(opened(ok({
      description: null,
      comments: [
        comment({ body: 'Nit: `rows`' }),
        comment({ author: 'ci-bot', bot: true, body: 'Coverage', createdAt: iso(NOW - HOUR) }),
        comment({ author: 'linus', path: 'src/a.js', line: 12 }),
      ],
    })), 'conversation');
    const h = html(s);
    assert.match(h, /<article class="comment"><div class="comment-meta"><strong>grace<\/strong> · 2h ago<\/div><div class="panel-text"><div>Nit: <code>rows<\/code><\/div><\/div><\/article>/);
    assert.match(h, /<article class="comment bot"><div class="comment-meta"><strong>ci-bot<\/strong><span class="bot-label">bot<\/span> · 1h ago<\/div>/);
    assert.match(h, /<strong>linus<\/strong> · 2h ago · <code class="comment-path">src\/a\.js:12<\/code><\/div>/);
  });

  test('no comments yet', () => {
    const h = html(panelTab(opened(ok({ description: null, comments: [] })), 'conversation'));
    assert.match(h, /<p class="panel-empty">No comments yet\.<\/p>/);
    assert.match(h, /<span class="pill">0<\/span>/);
  });

  test('escapes every PR- and comment-controlled string', () => {
    const x = '<img src=x onerror=alert(1)>';
    const s = panelTab(opened(ok({
      description: x,
      comments: [comment({ author: x, body: x, path: x, line: '<b>1</b>' })],
    }), { title: x, repoShort: x, number: x, author: { name: x }, source: x, target: x }), 'conversation');
    const h = html(s);
    assert.ok(!h.includes('<img'), h);
    assert.ok(!h.includes('<b>1'), h);
    assert.ok(h.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(!html(panelTab(s, 'description')).includes('<img'));
  });

  test('the rendered string depends only on the model (same input, same output)', () => {
    assert.equal(html(loaded()), html(loaded()));
  });
});
