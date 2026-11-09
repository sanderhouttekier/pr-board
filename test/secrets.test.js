import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envName, decodeCredBlob, createStore, createSecrets } from '../src/secrets.js';
import { WIN_CRED_SCRIPT, encodePowerShell } from '../src/winCred.ps1.js';

// Fake tokens: none of these may ever show up in an error.
const GH_TOKEN = 'ghp_FAKE_GITHUB_TOKEN_0001';
const BB_TOKEN = 'ATBB_FAKE_BITBUCKET_TOKEN_0002';
const JIRA_TOKEN = 'ATATT_FAKE_JIRA_TOKEN_0003';
const LEAK = 'ghp_FAKE_LEAKED_FROM_CHILD_9999';
const ALL_TOKENS = [GH_TOKEN, BB_TOKEN, JIRA_TOKEN, LEAK];

const b64 = (s) => Buffer.from(s).toString('base64');

// A child failure in the shape execFile gives, with a token in message and stdout.
function childError({ code = 1, stdout = '' } = {}) {
  const err = new Error(`Command failed: something\n${LEAK}`);
  err.code = code;
  err.stdout = `${stdout}${LEAK}`;
  err.stderr = LEAK;
  return err;
}

// Fake execFile: `handler(cmd, args, opts)` returns stdout (string) or throws. Records every call.
function fakeExec(handler) {
  const calls = [];
  const fn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const out = await handler(cmd, args, opts);
    return { stdout: out, stderr: '' };
  };
  fn.calls = calls;
  return fn;
}

// macOS `security`: table of service → token; anything else exits 44 like the real tool.
function macExec(table = {}, extra = () => { throw childError({ code: 1 }); }) {
  return fakeExec((cmd, args) => {
    if (cmd === 'security') {
      const ref = args[2];
      if (ref in table) return `${table[ref]}\n`;
      throw childError({ code: 44 });
    }
    return extra(cmd, args);
  });
}

function assertNoToken(err) {
  const blobs = [err.message, String(err.stack), JSON.stringify(err), String(err.cause ?? '')];
  for (const t of ALL_TOKENS) for (const b of blobs) assert.ok(!b.includes(t), `token leaked into error: ${b}`);
  assert.equal(err.cause, undefined);
}

// --- envName ---

test('envName: uppercases and turns every non-alphanumeric character into _', () => {
  assert.equal(envName('acme-bitbucket'), 'ACME_BITBUCKET');
  assert.equal(envName('pr-board.jira'), 'PR_BOARD_JIRA');
  assert.equal(envName('my token 2'), 'MY_TOKEN_2');
  assert.equal(envName('Acme_Jira9'), 'ACME_JIRA9');
  assert.equal(envName('a/b:c@d'), 'A_B_C_D');
});

// --- decodeCredBlob (Windows CredentialBlob bytes) ---

test('decodeCredBlob: UTF-16LE when the length is even and byte 1 is 0', () => {
  assert.equal(decodeCredBlob(Buffer.from(BB_TOKEN, 'utf16le')), BB_TOKEN);
});

test('decodeCredBlob: UTF-8 otherwise (odd length, or byte 1 not 0)', () => {
  assert.equal(decodeCredBlob(Buffer.from('abc', 'utf8')), 'abc');
  assert.equal(decodeCredBlob(Buffer.from('abcd', 'utf8')), 'abcd');
  assert.equal(decodeCredBlob(Buffer.from('tökén', 'utf8')), 'tökén');
  assert.equal(decodeCredBlob(Buffer.from([0x41, 0x00, 0x42])), 'A\0B', 'odd length stays UTF-8 even when byte 1 is 0');
});

test('decodeCredBlob: empty blob is an empty string', () => {
  assert.equal(decodeCredBlob(Buffer.alloc(0)), '');
});

// --- store providers ---

test('store macOS: security find-generic-password -s R -w with a 10 s timeout, trimmed', async () => {
  const exec = macExec({ 'pr-board-bitbucket': BB_TOKEN });
  const store = createStore({ execFile: exec, platform: 'darwin', env: {} });
  assert.equal(store.name, 'Keychain');
  assert.deepEqual(await store.read(['pr-board-bitbucket']), { 'pr-board-bitbucket': BB_TOKEN });
  assert.equal(exec.calls.length, 1);
  const [call] = exec.calls;
  assert.equal(call.cmd, 'security');
  assert.deepEqual(call.args, ['find-generic-password', '-s', 'pr-board-bitbucket', '-w']);
  assert.equal(call.opts.timeout, 10_000);
});

test('store macOS: exit 44 is a miss (empty string), and any other failure too', async () => {
  const exec = fakeExec((cmd, args) => {
    if (args[2] === 'gone') throw childError({ code: 44 });
    throw childError({ code: 'ETIMEDOUT' });
  });
  const store = createStore({ execFile: exec, platform: 'darwin', env: {} });
  assert.deepEqual(await store.read(['gone', 'slow']), { gone: '', slow: '' });
});

test('store Linux: secret-tool lookup service R with a 10 s timeout', async () => {
  const exec = fakeExec((cmd, args) => {
    if (cmd === 'secret-tool' && args.join(' ') === 'lookup service acme-jira') return JIRA_TOKEN;
    throw childError({ code: 1 });
  });
  const store = createStore({ execFile: exec, platform: 'linux', env: {} });
  assert.equal(store.name, 'Secret Service');
  assert.deepEqual(await store.read(['acme-jira']), { 'acme-jira': JIRA_TOKEN });
  assert.deepEqual(exec.calls[0].args, ['lookup', 'service', 'acme-jira']);
  assert.equal(exec.calls[0].opts.timeout, 10_000);
});

test('store Linux: exit 1 and ENOENT (not installed) are misses', async () => {
  const exec = fakeExec((cmd, args) => {
    if (args[2] === 'locked') throw childError({ code: 1 });
    throw childError({ code: 'ENOENT' });
  });
  const store = createStore({ execFile: exec, platform: 'linux', env: {} });
  assert.deepEqual(await store.read(['locked', 'none']), { locked: '', none: '' });
});

// Windows: the script gets the references from an env var and prints one JSON object of base64 blobs.
function winExec(blobs, { missing = [] } = {}) {
  return fakeExec((cmd, args, opts) => {
    if (missing.includes(cmd)) throw childError({ code: 'ENOENT' });
    const refs = JSON.parse(opts.env.PR_BOARD_CRED_REFS);
    const out = {};
    for (const r of refs) out[r] = r in blobs ? blobs[r].toString('base64') : null;
    return JSON.stringify(out);
  });
}

test('store Windows: powershell.exe args, UTF-16LE base64 -EncodedCommand, windowsHide, 15 s timeout', async () => {
  const exec = winExec({ 'acme-bitbucket': Buffer.from(BB_TOKEN, 'utf16le') });
  const store = createStore({ execFile: exec, platform: 'win32', env: { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows' } });
  assert.equal(store.name, 'Credential Manager');
  assert.deepEqual(await store.read(['acme-bitbucket']), { 'acme-bitbucket': BB_TOKEN });
  const [call] = exec.calls;
  assert.equal(call.cmd, 'powershell.exe');
  assert.deepEqual(call.args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  const encoded = call.args.at(-1);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), WIN_CRED_SCRIPT);
  assert.equal(encoded, encodePowerShell(WIN_CRED_SCRIPT));
  assert.equal(call.opts.windowsHide, true);
  assert.equal(call.opts.timeout, 15_000);
  assert.equal(call.opts.env.PATH, 'C:\\Windows', 'the child keeps the rest of the env');
});

test('store Windows: one call for every reference, misses and UTF-8 blobs decoded', async () => {
  const exec = winExec({ a: Buffer.from(GH_TOKEN, 'utf16le'), b: Buffer.from('xyz', 'utf8') });
  const store = createStore({ execFile: exec, platform: 'win32', env: {} });
  assert.deepEqual(await store.read(['a', 'b', 'c']), { a: GH_TOKEN, b: 'xyz', c: '' });
  assert.equal(exec.calls.length, 1);
  assert.deepEqual(JSON.parse(exec.calls[0].opts.env.PR_BOARD_CRED_REFS), ['a', 'b', 'c']);
});

test('store Windows: falls back to pwsh when powershell.exe is missing', async () => {
  const exec = winExec({ a: Buffer.from(GH_TOKEN, 'utf16le') }, { missing: ['powershell.exe'] });
  const store = createStore({ execFile: exec, platform: 'win32', env: {} });
  assert.deepEqual(await store.read(['a']), { a: GH_TOKEN });
  assert.deepEqual(exec.calls.map((c) => c.cmd), ['powershell.exe', 'pwsh']);
  assert.deepEqual(exec.calls[1].args, exec.calls[0].args);
});

test('store Windows: both shells missing, a failing script or garbage stdout are all misses', async () => {
  for (const handler of [
    () => { throw childError({ code: 'ENOENT' }); },
    () => { throw childError({ code: 1 }); },
    () => `not json ${LEAK}`,
    () => JSON.stringify({ a: 42 }),
  ]) {
    const store = createStore({ execFile: fakeExec(handler), platform: 'win32', env: {} });
    assert.deepEqual(await store.read(['a']), { a: '' });
  }
});

test('store Windows: a non-ENOENT failure of powershell.exe does not try pwsh', async () => {
  const exec = fakeExec(() => { throw childError({ code: 1 }); });
  await createStore({ execFile: exec, platform: 'win32', env: {} }).read(['a']);
  assert.equal(exec.calls.length, 1);
});

test('store: other platforms have no store and spawn nothing', async () => {
  const exec = fakeExec(() => { throw new Error('must not run'); });
  const store = createStore({ execFile: exec, platform: 'freebsd', env: {} });
  assert.equal(store.name, null);
  assert.deepEqual(await store.read(['a']), { a: '' });
  assert.equal(exec.calls.length, 0);
});

test('winCred script: reads generic credentials through CredReadW, names from PR_BOARD_CRED_REFS, JSON out', () => {
  assert.match(WIN_CRED_SCRIPT, /CredReadW/);
  assert.match(WIN_CRED_SCRIPT, /CredFree/);
  assert.match(WIN_CRED_SCRIPT, /\$env:PR_BOARD_CRED_REFS/);
  assert.match(WIN_CRED_SCRIPT, /ConvertTo-Json/);
  assert.doesNotMatch(WIN_CRED_SCRIPT, /Write-Host|Out-File/);
});

// --- the chain: createSecrets(...).auth(host, credential) ---

const settings = { ghPath: '/opt/bin/gh' };
const globalGithub = { ref: '', override: false };
const bbCred = { ref: 'acme-bitbucket', email: 'ada@acme.example', override: true };
const jiraCred = { ref: 'pr-board-jira', email: 'ada@example.com', override: false };
const basic = (email, token) => `Basic ${b64(`${email}:${token}`)}`;

// gh answers with `gh` output when given; anything not handled fails like a missing tool.
function chainExec({ store = {}, gh } = {}) {
  return macExec(store, (cmd, args) => {
    if (cmd === settings.ghPath && args.join(' ') === 'auth token' && gh !== undefined) return `${gh}\n`;
    throw childError({ code: 1 });
  });
}

const cmds = (exec) => exec.calls.map((c) => [c.cmd, ...c.args].join(' '));

test('auth: store hit gives the header, no env var or gh needed', async () => {
  const exec = chainExec({ store: { 'acme-bitbucket': BB_TOKEN } });
  const s = createSecrets({ execFile: exec, env: { ACME_BITBUCKET: 'from-env' }, platform: 'darwin', settings });
  assert.equal(await s.auth('bitbucket', bbCred), basic('ada@acme.example', BB_TOKEN));
  assert.deepEqual(cmds(exec), ['security find-generic-password -s acme-bitbucket -w']);
});

test('auth: store miss, then the derived env var', async () => {
  const exec = chainExec();
  const s = createSecrets({ execFile: exec, env: { PR_BOARD_JIRA: ` ${JIRA_TOKEN}\n` }, platform: 'darwin', settings });
  assert.equal(await s.auth('jira', jiraCred), basic('ada@example.com', JIRA_TOKEN));
});

test('auth: GitHub is a Bearer header; a global ref tries the store and env var first', async () => {
  const exec = chainExec({ store: { 'pr-board-github': GH_TOKEN } });
  const s = createSecrets({ execFile: exec, env: { GH_TOKEN: 'nope' }, platform: 'darwin', settings });
  assert.equal(await s.auth('github', { ref: 'pr-board-github', override: false }), `Bearer ${GH_TOKEN}`);
  assert.deepEqual(cmds(exec), ['security find-generic-password -s pr-board-github -w']);
});

test('auth: global GitHub with an empty ref: GH_TOKEN, then GITHUB_TOKEN, then gh auth token', async () => {
  let exec = chainExec({ gh: 'gho_from_gh' });
  let s = createSecrets({ execFile: exec, env: { GH_TOKEN: GH_TOKEN, GITHUB_TOKEN: 'second' }, platform: 'darwin', settings });
  assert.equal(await s.auth('github', globalGithub), `Bearer ${GH_TOKEN}`);
  assert.equal(exec.calls.length, 0, 'empty ref: no store lookup, and GH_TOKEN wins before gh');

  s = createSecrets({ execFile: exec, env: { GH_TOKEN: '', GITHUB_TOKEN: GH_TOKEN }, platform: 'darwin', settings });
  assert.equal(await s.auth('github', globalGithub), `Bearer ${GH_TOKEN}`);
  assert.equal(exec.calls.length, 0);

  exec = chainExec({ gh: GH_TOKEN });
  s = createSecrets({ execFile: exec, env: {}, platform: 'darwin', settings });
  assert.equal(await s.auth('github', globalGithub), `Bearer ${GH_TOKEN}`);
  assert.deepEqual(cmds(exec), ['/opt/bin/gh auth token']);
  assert.equal(exec.calls[0].opts.timeout, 10_000);
});

test('auth: ghPath defaults to gh', async () => {
  const exec = fakeExec((cmd, args) => {
    if (cmd === 'gh' && args.join(' ') === 'auth token') return GH_TOKEN;
    throw childError();
  });
  const s = createSecrets({ execFile: exec, env: {}, platform: 'darwin' });
  assert.equal(await s.auth('github', globalGithub), `Bearer ${GH_TOKEN}`);
});

test('auth: a GitHub override that misses never reads GH_TOKEN / GITHUB_TOKEN and never calls gh', async () => {
  const exec = chainExec({ gh: LEAK });
  const env = new Proxy({ GH_TOKEN: LEAK, GITHUB_TOKEN: LEAK }, {
    get(target, key) {
      if (key === 'GH_TOKEN' || key === 'GITHUB_TOKEN') throw new Error(`read ${String(key)}`);
      return target[key];
    },
  });
  const s = createSecrets({ execFile: exec, env, platform: 'darwin', settings });
  await assert.rejects(s.auth('github', { ref: 'acme-github', override: true }), (err) => {
    assert.equal(err.message, 'No GitHub token for `acme-github`: tried Keychain entry `acme-github`, env var `ACME_GITHUB`.');
    assertNoToken(err);
    return true;
  });
  assert.deepEqual(cmds(exec), ['security find-generic-password -s acme-github -w']);
});

test('auth: an Atlassian Basic header uses the email from the credential', async () => {
  const exec = chainExec({ store: { 'pr-board-jira': JIRA_TOKEN } });
  const s = createSecrets({ execFile: exec, env: {}, platform: 'darwin', settings });
  assert.equal(await s.auth('jira', jiraCred), basic('ada@example.com', JIRA_TOKEN));
  // Same ref, other email (another project): the header follows the credential.
  assert.equal(await s.auth('jira', { ...jiraCred, email: 'bob@example.com' }), basic('bob@example.com', JIRA_TOKEN));
});

test('auth: a missing email is its own error, and nothing is looked up', async () => {
  const exec = chainExec({ store: { 'acme-bitbucket': BB_TOKEN } });
  const s = createSecrets({ execFile: exec, env: {}, platform: 'darwin', settings });
  await assert.rejects(s.auth('bitbucket', { ref: 'acme-bitbucket', override: true }), (err) => {
    assert.equal(err.message, 'No email for the Bitbucket credential `acme-bitbucket` in config.json');
    assertNoToken(err);
    return true;
  });
  await assert.rejects(s.auth('jira', { ref: 'pr-board-jira', email: '', override: false }), /^Error: No email for the Jira credential `pr-board-jira` in config.json$/);
  assert.equal(exec.calls.length, 0);
});

test('auth: a host with no credential at all says so', async () => {
  const s = createSecrets({ execFile: chainExec(), env: {}, platform: 'darwin', settings });
  await assert.rejects(s.auth('bitbucket', { ref: '', override: false }), /^Error: No Bitbucket credential in config.json$/);
  await assert.rejects(s.auth('github', { ref: '', override: true }), /^Error: No GitHub token: the credential override in config.json has an empty ref$/);
});

test('auth: "no token" lists every source tried, in order, with the store name per OS, never a value', async () => {
  const cases = [
    ['darwin', 'bitbucket', bbCred, 'No Bitbucket token for `acme-bitbucket`: tried Keychain entry `acme-bitbucket`, env var `ACME_BITBUCKET`.'],
    ['linux', 'jira', jiraCred, 'No Jira token for `pr-board-jira`: tried Secret Service entry `pr-board-jira`, env var `PR_BOARD_JIRA`.'],
    ['win32', 'bitbucket', bbCred, 'No Bitbucket token for `acme-bitbucket`: tried Credential Manager entry `acme-bitbucket`, env var `ACME_BITBUCKET`.'],
    ['darwin', 'github', globalGithub, 'No GitHub token: tried env var `GH_TOKEN`, env var `GITHUB_TOKEN`, `/opt/bin/gh auth token`.'],
    ['darwin', 'github', { ref: 'pr-board-github', override: false },
      'No GitHub token for `pr-board-github`: tried Keychain entry `pr-board-github`, env var `PR_BOARD_GITHUB`, env var `GH_TOKEN`, env var `GITHUB_TOKEN`, `/opt/bin/gh auth token`.'],
    ['freebsd', 'bitbucket', bbCred, 'No Bitbucket token for `acme-bitbucket`: tried env var `ACME_BITBUCKET`.'],
  ];
  for (const [platform, host, cred, message] of cases) {
    // Every child fails with a token in its message and stdout; the gh child prints only whitespace.
    const exec = fakeExec((cmd) => {
      if (cmd === settings.ghPath) return '  \n';
      throw childError({ code: platform === 'darwin' ? 44 : 1 });
    });
    const s = createSecrets({ execFile: exec, env: { GH_TOKEN: '', ACME_BITBUCKET: '   ' }, platform, settings });
    await assert.rejects(s.auth(host, cred), (err) => {
      assert.equal(err.message, message);
      assertNoToken(err);
      return true;
    });
  }
});

test('auth: PR_BOARD_AUTOSTARTED=1 adds the shell-profile sentence', async () => {
  const s = createSecrets({ execFile: chainExec(), env: { PR_BOARD_AUTOSTARTED: '1' }, platform: 'darwin', settings });
  await assert.rejects(s.auth('bitbucket', bbCred), (err) => {
    assert.equal(err.message,
      'No Bitbucket token for `acme-bitbucket`: tried Keychain entry `acme-bitbucket`, env var `ACME_BITBUCKET`. '
      + 'This board was started at login: env vars from your shell profile aren\'t visible here. '
      + 'Store the token in Keychain (or Secret Service, or Credential Manager).');
    return true;
  });
  const plain = createSecrets({ execFile: chainExec(), env: { PR_BOARD_AUTOSTARTED: '0' }, platform: 'darwin', settings });
  await assert.rejects(plain.auth('bitbucket', bbCred), (err) => !err.message.includes('started at login'));
});

test('auth: cached per (host, ref) after success; concurrent calls share one lookup', async () => {
  const exec = chainExec({ store: { 'acme-bitbucket': BB_TOKEN } });
  const s = createSecrets({ execFile: exec, env: {}, platform: 'darwin', settings });
  await Promise.all([s.auth('bitbucket', bbCred), s.auth('bitbucket', bbCred)]);
  await s.auth('bitbucket', bbCred);
  assert.equal(exec.calls.length, 1);
  await s.auth('jira', { ...jiraCred, ref: 'acme-bitbucket' });
  assert.equal(exec.calls.length, 2, 'another host is another cache entry');
});

test('auth: the global GitHub fallback is never served from cache to an override with the same ref', async () => {
  const exec = chainExec({ gh: GH_TOKEN });
  const s = createSecrets({ execFile: exec, env: {}, platform: 'darwin', settings });
  assert.equal(await s.auth('github', { ref: 'shared-ref', override: false }), `Bearer ${GH_TOKEN}`);
  await assert.rejects(s.auth('github', { ref: 'shared-ref', override: true }), /No GitHub token for `shared-ref`/);
});

test('auth: a failed lookup is dropped from the cache, so the next call retries', async () => {
  const store = {};
  const exec = chainExec({ store });
  const s = createSecrets({ execFile: exec, env: {}, platform: 'darwin', settings });
  await assert.rejects(s.auth('bitbucket', bbCred));
  store['acme-bitbucket'] = BB_TOKEN;
  assert.equal(await s.auth('bitbucket', bbCred), basic('ada@acme.example', BB_TOKEN));
  assert.equal(exec.calls.length, 2);
});

test('auth: concurrent lookups on Windows share one PowerShell call', async () => {
  const exec = winExec({ 'acme-bitbucket': Buffer.from(BB_TOKEN, 'utf16le'), 'pr-board-jira': Buffer.from(JIRA_TOKEN, 'utf8') });
  const s = createSecrets({ execFile: exec, env: {}, platform: 'win32', settings });
  const [bb, jira] = await Promise.all([s.auth('bitbucket', bbCred), s.auth('jira', jiraCred)]);
  assert.equal(bb, basic('ada@acme.example', BB_TOKEN));
  assert.equal(jira, basic('ada@example.com', JIRA_TOKEN));
  assert.equal(exec.calls.length, 1);
  assert.deepEqual(JSON.parse(exec.calls[0].opts.env.PR_BOARD_CRED_REFS).sort(), ['acme-bitbucket', 'pr-board-jira']);
});

test('auth: a child error message or stdout holding a token never surfaces', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const exec = fakeExec(() => { throw childError({ code: 1, stdout: LEAK }); });
    const s = createSecrets({ execFile: exec, env: {}, platform, settings });
    for (const [host, cred] of [['github', globalGithub], ['bitbucket', bbCred]]) {
      await assert.rejects(s.auth(host, cred), (err) => {
        assertNoToken(err);
        return true;
      });
    }
  }
});

test('auth: an unknown host is an error', async () => {
  const s = createSecrets({ execFile: chainExec(), env: {}, platform: 'darwin', settings });
  await assert.rejects(s.auth('gitlab', { ref: 'x', override: false }), /Unknown host/);
});

// --- resolvable(host, credential, { autostart: true }) for the installer ---

// Any env read throws: an autostarted board doesn't see env vars, so they must not count.
const noEnv = new Proxy({}, { get(_, key) { throw new Error(`env read: ${String(key)}`); } });

test('resolvable autostart: a store hit counts, and the answer never holds the token', async () => {
  const s = createSecrets({ execFile: chainExec({ store: { 'acme-bitbucket': BB_TOKEN } }), env: noEnv, platform: 'darwin', settings });
  const res = await s.resolvable('bitbucket', bbCred, { autostart: true });
  assert.deepEqual(res, { ok: true, missing: null });
  assert.ok(!JSON.stringify(res).includes(BB_TOKEN));
});

test('resolvable autostart: env vars never count, even when they hold the token', async () => {
  const env = { ACME_BITBUCKET: BB_TOKEN, GH_TOKEN: GH_TOKEN, GITHUB_TOKEN: GH_TOKEN, PR_BOARD_GITHUB: GH_TOKEN };
  const s = createSecrets({ execFile: chainExec(), env, platform: 'darwin', settings });
  assert.deepEqual(await s.resolvable('bitbucket', bbCred, { autostart: true }), { ok: false, missing: 'token' });
  assert.deepEqual(await s.resolvable('github', { ref: 'pr-board-github', override: false }, { autostart: true }), { ok: false, missing: 'token' });
});

test('resolvable autostart: gh auth token counts for the global GitHub only', async () => {
  const exec = chainExec({ gh: GH_TOKEN });
  const s = createSecrets({ execFile: exec, env: noEnv, platform: 'darwin', settings });
  assert.deepEqual(await s.resolvable('github', globalGithub, { autostart: true }), { ok: true, missing: null });
  assert.deepEqual(cmds(exec), ['/opt/bin/gh auth token']);
  assert.deepEqual(await s.resolvable('github', { ref: 'acme-github', override: true }, { autostart: true }), { ok: false, missing: 'token' });
  assert.ok(!cmds(exec).slice(1).some((c) => c.startsWith('/opt/bin/gh')), 'an override never asks gh');
});

test('resolvable: a missing email is reported as such, with no lookup', async () => {
  const exec = chainExec({ store: { 'acme-bitbucket': BB_TOKEN } });
  const s = createSecrets({ execFile: exec, env: noEnv, platform: 'darwin', settings });
  assert.deepEqual(await s.resolvable('bitbucket', { ref: 'acme-bitbucket', override: true }, { autostart: true }), { ok: false, missing: 'email' });
  assert.deepEqual(await s.resolvable('jira', { ref: '', override: false }, { autostart: true }), { ok: false, missing: 'token' });
  assert.equal(exec.calls.length, 0);
});

test('resolvable: without autostart, the full chain counts (env vars too)', async () => {
  const s = createSecrets({ execFile: chainExec(), env: { ACME_BITBUCKET: BB_TOKEN }, platform: 'darwin', settings });
  assert.deepEqual(await s.resolvable('bitbucket', bbCred), { ok: true, missing: null });
});

test('resolvable: never fills or reads the auth cache', async () => {
  const store = { 'acme-bitbucket': BB_TOKEN };
  const exec = chainExec({ store });
  const s = createSecrets({ execFile: exec, env: {}, platform: 'darwin', settings });
  await s.resolvable('bitbucket', bbCred, { autostart: true });
  delete store['acme-bitbucket'];
  await assert.rejects(s.auth('bitbucket', bbCred), /No Bitbucket token/);
});
