// Token lookup per host and token reference (SPEC "Secrets"): OS store → derived env var →
// (global GitHub only) GH_TOKEN, GITHUB_TOKEN, `<ghPath> auth token`. Returns ready Authorization header values.
// The only module that touches tokens. Never log, persist or put a token, or any child's output, into an error.
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { WIN_CRED_SCRIPT, encodePowerShell } from './winCred.ps1.js';

const STORE_TIMEOUT_MS = 10_000;
const WIN_TIMEOUT_MS = 15_000;
const WIN_REFS_ENV = 'PR_BOARD_CRED_REFS';

// `acme-bitbucket` → `ACME_BITBUCKET`.
export function envName(ref) {
  return ref.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

// A Windows CredentialBlob: UTF-16LE when its length is even and byte 1 is 0, else UTF-8.
export function decodeCredBlob(buf) {
  const utf16 = buf.length > 0 && buf.length % 2 === 0 && buf[1] === 0;
  return buf.toString(utf16 ? 'utf16le' : 'utf8');
}

// Runs a child; any failure is an empty answer. The error is dropped unread: it may hold a secret.
async function quiet(execFile, cmd, args, opts) {
  try {
    return String((await execFile(cmd, args, opts)).stdout ?? '');
  } catch {
    return '';
  }
}

const clean = (s) => s.replace(/\0+$/, '').trim();

async function eachRef(refs, readOne) {
  const values = await Promise.all(refs.map(readOne));
  return Object.fromEntries(refs.map((r, i) => [r, values[i]]));
}

// Windows: one PowerShell call for every reference; powershell.exe, else pwsh when it's missing.
async function readWindows({ execFile, env }, refs) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(WIN_CRED_SCRIPT)];
  const opts = { windowsHide: true, timeout: WIN_TIMEOUT_MS, env: { ...env, [WIN_REFS_ENV]: JSON.stringify(refs) } };
  let stdout = '';
  for (const shell of ['powershell.exe', 'pwsh']) {
    try {
      stdout = String((await execFile(shell, args, opts)).stdout ?? '');
      break;
    } catch (err) {
      if (err?.code !== 'ENOENT') break;
    }
  }
  let parsed = {};
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Garbage on stdout: every reference misses.
  }
  const value = (r) => {
    const v = parsed?.[r];
    return typeof v === 'string' ? clean(decodeCredBlob(Buffer.from(v, 'base64'))) : '';
  };
  return Object.fromEntries(refs.map((r) => [r, value(r)]));
}

// The OS secret store for `platform`: { name, read(refs) → { ref: token | '' } }. Never rejects.
export function createStore({ execFile, platform, env }) {
  const opts = { timeout: STORE_TIMEOUT_MS };
  switch (platform) {
    case 'darwin':
      return {
        name: 'Keychain',
        read: (refs) => eachRef(refs, async (r) => clean(await quiet(execFile, 'security', ['find-generic-password', '-s', r, '-w'], opts))),
      };
    case 'linux':
      return {
        name: 'Secret Service',
        read: (refs) => eachRef(refs, async (r) => clean(await quiet(execFile, 'secret-tool', ['lookup', 'service', r], opts))),
      };
    case 'win32':
      return { name: 'Credential Manager', read: (refs) => readWindows({ execFile, env }, refs) };
    default:
      return { name: null, read: async (refs) => Object.fromEntries(refs.map((r) => [r, ''])) };
  }
}

const HOSTS = { github: 'GitHub', bitbucket: 'Bitbucket', jira: 'Jira' };
const ATLASSIAN = new Set(['bitbucket', 'jira']);
const AUTOSTART_NOTE = "This board was started at login: env vars from your shell profile aren't visible here. "
  + 'Store the token in Keychain (or Secret Service, or Credential Manager).';

// Collects the references asked for in one tick into one store read (one PowerShell call on Windows).
function batched(read) {
  let queue = null;
  return (ref) => {
    if (!queue) {
      const q = (queue = { refs: new Set() });
      q.result = Promise.resolve().then(() => {
        queue = null;
        return read([...q.refs]);
      });
    }
    queue.refs.add(ref);
    return queue.result.then((values) => values[ref] ?? '');
  };
}

/**
 * createSecrets({ execFile, env, platform, settings }) → { auth, resolvable }
 * - auth(host, { ref, email?, override }) → Promise<header value>; rejects with an Error naming the sources tried.
 * - resolvable(host, credential, { autostart }) → Promise<{ ok, missing: null | 'email' | 'token' }>, never a token.
 */
export function createSecrets({ execFile = promisify(execFileCb), env = process.env, platform = process.platform, settings } = {}) {
  const store = createStore({ execFile, platform, env });
  const readStore = batched(store.read);
  const ghPath = settings?.ghPath || 'gh';
  const cache = new Map(); // `${host}\0${ref}\0${global GitHub?}` → in-flight token promise

  const isGlobalGithub = (host, credential) => host === 'github' && !credential.override;
  const fromEnv = (name) => async () => env[name] ?? '';

  // The providers for a credential, in chain order. `autostart` keeps only what an autostarted board sees.
  function providers(host, credential, { autostart = false } = {}) {
    const { ref } = credential;
    const list = [];
    if (ref && store.name) list.push({ label: `${store.name} entry \`${ref}\``, get: () => readStore(ref) });
    if (ref && !autostart) list.push({ label: `env var \`${envName(ref)}\``, get: fromEnv(envName(ref)) });
    if (isGlobalGithub(host, credential)) {
      if (!autostart) for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) list.push({ label: `env var \`${name}\``, get: fromEnv(name) });
      list.push({ label: `\`${ghPath} auth token\``, get: () => quiet(execFile, ghPath, ['auth', 'token'], { timeout: STORE_TIMEOUT_MS }) });
    }
    return list;
  }

  async function firstToken(list) {
    for (const p of list) {
      const token = clean(String(await p.get()));
      if (token) return token;
    }
    return '';
  }

  // Throws the config-level problems: unknown host, no credential, missing email.
  function check(host, credential) {
    const label = HOSTS[host];
    if (!label) throw new Error(`Unknown host ${String(host)}`);
    if (!credential.ref && !isGlobalGithub(host, credential)) {
      throw new Error(host === 'github' && credential.override
        ? 'No GitHub token: the credential override in config.json has an empty ref'
        : `No ${label} credential in config.json`);
    }
    if (ATLASSIAN.has(host) && !credential.email) throw new Error(`No email for the ${label} credential \`${credential.ref}\` in config.json`);
    return label;
  }

  async function lookup(host, credential, label) {
    const list = providers(host, credential);
    const token = await firstToken(list);
    if (token) return token;
    const name = credential.ref ? ` for \`${credential.ref}\`` : '';
    let message = `No ${label} token${name}: tried ${list.map((p) => p.label).join(', ')}.`;
    if (env.PR_BOARD_AUTOSTARTED === '1') message += ` ${AUTOSTART_NOTE}`;
    throw new Error(message);
  }

  async function auth(host, credential = {}) {
    const label = check(host, credential);
    const key = `${host}\0${credential.ref}\0${isGlobalGithub(host, credential) ? 'global' : ''}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = lookup(host, credential, label);
      cache.set(key, pending);
      // A failed lookup leaves the cache, so the next poll retries (e.g. a keyring still locked at login).
      pending.catch(() => {
        if (cache.get(key) === pending) cache.delete(key);
      });
    }
    const token = await pending;
    return ATLASSIAN.has(host) ? `Basic ${Buffer.from(`${credential.email}:${token}`).toString('base64')}` : `Bearer ${token}`;
  }

  // For the installer's refusal rule. With `autostart`, only the store (and `gh` for the global GitHub) counts.
  async function resolvable(host, credential = {}, { autostart = false } = {}) {
    try {
      check(host, credential);
    } catch (err) {
      if (!HOSTS[host]) throw err;
      return { ok: false, missing: ATLASSIAN.has(host) && credential.ref && !credential.email ? 'email' : 'token' };
    }
    const token = await firstToken(providers(host, credential, { autostart }));
    return token ? { ok: true, missing: null } : { ok: false, missing: 'token' };
  }

  return { auth, resolvable };
}
