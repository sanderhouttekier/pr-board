// GET-only fetch: timeout, ETag cache, JSON, pagination helper, rate-limit headers.
// This is the only module that talks to upstream APIs. It cannot issue any method but GET.
import { createHash } from 'node:crypto';

const MAX_PAGES = 20;
const EXCERPT_MAX = 200;
const METHOD_OVERRIDE_HEADERS = new Set(['x-http-method-override', 'x-http-method', 'x-method-override']);

export class HttpError extends Error {
  constructor({ status, url, body = '', message }) {
    super(message ?? `GET ${url} failed with ${status}${body ? `: ${body}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }

  toJSON() {
    return { name: this.name, message: this.message, status: this.status, url: this.url, body: this.body };
  }
}

function authIdentity(auth) {
  return createHash('sha256').update(auth ?? '').digest('hex');
}

// Remove the auth value (and its bare credential part) from text that may end up in an error.
function redact(text, auth) {
  if (!auth) return text;
  let out = text.split(auth).join('[redacted]');
  const cred = auth.replace(/^\S+\s+/, '');
  if (cred.length >= 6) out = out.split(cred).join('[redacted]');
  return out;
}

function nextFromLink(link) {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (m) return m[1];
  }
  return null;
}

function toNumber(v) {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function createHttp({ fetch = globalThis.fetch, timeoutMs = 20000, log = () => {}, maxCacheEntries = 2000 } = {}) {
  const cache = new Map(); // url + auth hash -> { etag, lastModified, text, link }; insertion order = LRU order

  function remember(key, entry) {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
  }
  const hosts = new Map();

  function hostStats(url) {
    const host = new URL(url).host;
    if (!hosts.has(host)) hosts.set(host, { requests: 0, notModified: 0, rateLimitRemaining: undefined, rateLimitReset: undefined });
    return hosts.get(host);
  }

  function assertGetOnly(method, headers) {
    if (method !== undefined && String(method).toUpperCase() !== 'GET') {
      throw new Error(`http.js only allows GET (got ${String(method)})`);
    }
    for (const name of Object.keys(headers ?? {})) {
      if (METHOD_OVERRIDE_HEADERS.has(name.toLowerCase())) throw new Error(`http.js only allows GET (header ${name} refused)`);
    }
  }

  // One GET; returns { text, link } using the conditional cache.
  async function request(url, { auth, headers = {}, method } = {}) {
    assertGetOnly(method, headers);
    const key = `${url}\u0000${authIdentity(auth)}`;
    const cached = cache.get(key);
    const sendHeaders = { ...headers };
    if (auth) sendHeaders.Authorization = auth;
    if (cached?.etag) sendHeaders['If-None-Match'] = cached.etag;
    if (cached?.lastModified) sendHeaders['If-Modified-Since'] = cached.lastModified;

    const stats = hostStats(url);
    stats.requests += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { method: 'GET', headers: sendHeaders, signal: controller.signal });
    } catch (err) {
      const timedOut = controller.signal.aborted;
      throw new HttpError({
        status: 0,
        url,
        message: timedOut ? `GET ${url} timeout after ${timeoutMs} ms` : `GET ${url} network error: ${redact(String(err?.message ?? err), auth)}`,
      });
    } finally {
      clearTimeout(timer);
    }

    const remaining = toNumber(res.headers.get('x-ratelimit-remaining'));
    const reset = toNumber(res.headers.get('x-ratelimit-reset'));
    if (remaining !== undefined) stats.rateLimitRemaining = remaining;
    if (reset !== undefined) stats.rateLimitReset = reset;

    if (res.status === 304 && cached) {
      stats.notModified += 1;
      remember(key, cached);
      log(`GET ${url} 304`);
      return { text: cached.text, link: res.headers.get('link') ?? cached.link };
    }
    if (res.status < 200 || res.status >= 300) {
      const raw = await res.text().catch(() => '');
      log(`GET ${url} ${res.status}`);
      throw new HttpError({ status: res.status, url, body: redact(raw, auth).slice(0, EXCERPT_MAX) });
    }

    const text = await res.text();
    const link = res.headers.get('link');
    const etag = res.headers.get('etag');
    const lastModified = res.headers.get('last-modified');
    if (etag || lastModified) remember(key, { etag, lastModified, text, link });
    log(`GET ${url} ${res.status}`);
    return { text, link };
  }

  function parse(text, url, as) {
    if (as === 'text') return text;
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError({ status: 200, url, message: `GET ${url} returned invalid JSON` });
    }
  }

  async function get(url, { as = 'json', ...opts } = {}) {
    const { text } = await request(url, opts);
    return parse(text, url, as);
  }

  // GitHub: array bodies, follow Link rel="next". Bitbucket: {values, next}.
  // Never follows a next link to another origin, so auth cannot leak.
  async function getAll(url, opts = {}) {
    const origin = new URL(url).origin;
    const out = [];
    let next = url;
    for (let page = 0; next && page < MAX_PAGES; page += 1) {
      if (new URL(next).origin !== origin) throw new HttpError({ status: 0, url: next, message: `Refusing next page on another origin than ${origin}` });
      const { text, link } = await request(next, opts);
      const body = parse(text, next, 'json');
      if (Array.isArray(body)) {
        out.push(...body);
        next = nextFromLink(link);
      } else {
        out.push(...(body?.values ?? []));
        next = body?.next ?? null;
      }
    }
    return out;
  }

  function stats() {
    return Object.fromEntries([...hosts].map(([h, s]) => [h, { ...s }]));
  }

  return { get, getAll, stats };
}
