import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  NAMES, unitPath, unitEnv, renderPlist, renderSystemd, renderDesktop, renderTask,
} from '../src/install.js';

// Fake tokens: none of these may ever show up in a rendered unit or in installer output.
const FAKE_TOKENS = ['ghp_FAKE_GITHUB_TOKEN_0001', 'ATBB_FAKE_BITBUCKET_TOKEN_0002', 'ATATT_FAKE_JIRA_TOKEN_0003'];

// --- names, PATH and env -------------------------------------------------------------------

test('names: launchd label, systemd unit, Windows task', () => {
  assert.deepEqual(NAMES, { label: 'io.github.sanderhouttekier.pr-board', service: 'pr-board.service', task: 'pr-board' });
});

test('unitPath: gh dir and node dir first, then the OS default, no duplicates', () => {
  assert.equal(unitPath('darwin', '/opt/homebrew/bin', '/Users/ada/.nvm/versions/node/v22.11.0/bin'),
    '/opt/homebrew/bin:/Users/ada/.nvm/versions/node/v22.11.0/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(unitPath('darwin', '/usr/local/bin', '/usr/local/bin'), '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(unitPath('darwin', null, '/usr/local/bin'), '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(unitPath('linux', '/usr/bin', '/home/ada/.local/node/bin'),
    '/usr/bin:/home/ada/.local/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin:/bin');
  assert.equal(unitPath('win32', 'C:\\Program Files\\GitHub CLI', 'C:\\Program Files\\nodejs'),
    'C:\\Program Files\\GitHub CLI;C:\\Program Files\\nodejs;%PATH%');
});

test('unitEnv: config dir, autostarted flag, PATH, in that order', () => {
  assert.deepEqual(unitEnv({ configDir: '/c', path: '/p' }), [
    ['PR_BOARD_CONFIG_DIR', '/c'],
    ['PR_BOARD_AUTOSTARTED', '1'],
    ['PATH', '/p'],
  ]);
});

// --- renderers (snapshot-style) -------------------------------------------------------------

const MAC = {
  execPath: '/Users/ada/.nvm/versions/node/v22.11.0/bin/node',
  repo: '/Users/ada/src/pr board & <co>',
  server: '/Users/ada/src/pr board & <co>/src/server.js',
  log: '/Users/ada/Library/Logs/pr-board.log',
  env: unitEnv({ configDir: '/Users/ada/.config/pr-board', path: '/opt/homebrew/bin:/usr/bin' }),
};

test('renderPlist: label, node + server, KeepAlive, ThrottleInterval 30, log, env, XML-escaped', () => {
  assert.equal(renderPlist(MAC), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.github.sanderhouttekier.pr-board</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/ada/.nvm/versions/node/v22.11.0/bin/node</string>
    <string>/Users/ada/src/pr board &amp; &lt;co&gt;/src/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/ada/src/pr board &amp; &lt;co&gt;</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>/Users/ada/Library/Logs/pr-board.log</string>
  <key>StandardErrorPath</key><string>/Users/ada/Library/Logs/pr-board.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PR_BOARD_CONFIG_DIR</key><string>/Users/ada/.config/pr-board</string>
    <key>PR_BOARD_AUTOSTARTED</key><string>1</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>
  </dict>
</dict>
</plist>
`);
});

const LINUX = {
  execPath: '/home/ada/.local/node/bin/node',
  repo: '/home/ada/src/pr "board" 100%',
  server: '/home/ada/src/pr "board" 100%/src/server.js',
  env: unitEnv({ configDir: '/home/ada/.config/pr-board', path: '/usr/bin:/home/ada/.local/node/bin' }),
};

test('renderSystemd: ExecStart, WorkingDirectory, env, Restart=on-failure, RestartSec=10, escaped', () => {
  assert.equal(renderSystemd(LINUX), `[Unit]
Description=pr-board (local pull request board)
After=network-online.target

[Service]
Type=simple
ExecStart="/home/ada/.local/node/bin/node" "/home/ada/src/pr \\"board\\" 100%%/src/server.js"
WorkingDirectory=/home/ada/src/pr "board" 100%%
Environment="PR_BOARD_CONFIG_DIR=/home/ada/.config/pr-board"
Environment="PR_BOARD_AUTOSTARTED=1"
Environment="PATH=/usr/bin:/home/ada/.local/node/bin"
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`);
});

test('renderDesktop: Exec through env, Path = repo, escaped per the desktop entry spec', () => {
  assert.equal(renderDesktop(LINUX), `[Desktop Entry]
Type=Application
Name=pr-board
Comment=Local pull request board
Exec=env "PR_BOARD_CONFIG_DIR=/home/ada/.config/pr-board" "PR_BOARD_AUTOSTARTED=1" "PATH=/usr/bin:/home/ada/.local/node/bin" "/home/ada/.local/node/bin/node" "/home/ada/src/pr \\\\"board\\\\" 100%%/src/server.js"
Path=/home/ada/src/pr "board" 100%
Terminal=false
X-GNOME-Autostart-enabled=true
`);
});

const WIN = {
  execPath: 'C:\\Program Files\\nodejs\\node.exe',
  repo: 'C:\\Users\\ada\\src\\pr-board & co',
  server: 'C:\\Users\\ada\\src\\pr-board & co\\src\\server.js',
  env: unitEnv({ configDir: 'C:\\Users\\ada\\AppData\\Roaming\\pr-board', path: 'C:\\gh;C:\\Program Files\\nodejs;%PATH%' }),
  userId: 'ACME\\ada',
};

test('renderTask: LogonTrigger for the user, RestartOnFailure 3 x PT1M, PT0S, battery false, env via cmd, escaped', () => {
  assert.equal(renderTask(WIN), `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>pr-board (local pull request board)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>ACME\\ada</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>ACME\\ada</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>/d /c set "PR_BOARD_CONFIG_DIR=C:\\Users\\ada\\AppData\\Roaming\\pr-board" &amp;&amp; set "PR_BOARD_AUTOSTARTED=1" &amp;&amp; set "PATH=C:\\gh;C:\\Program Files\\nodejs;%PATH%" &amp;&amp; "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\ada\\src\\pr-board &amp; co\\src\\server.js"</Arguments>
      <WorkingDirectory>C:\\Users\\ada\\src\\pr-board &amp; co</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`);
});

test('renderers: no token value in any rendered unit, even with tokens in the installer env', () => {
  const units = [renderPlist(MAC), renderSystemd(LINUX), renderDesktop(LINUX), renderTask(WIN)];
  for (const unit of units) for (const t of FAKE_TOKENS) assert.ok(!unit.includes(t), `token in unit:\n${unit}`);
  for (const unit of units) assert.doesNotMatch(unit, /TOKEN|Bearer|Basic /);
});

// --- fakes ----------------------------------------------------------------------------------

import { findOnPath, unitTarget, planInstall, planUninstall, applySteps, storeCommand, refusals, main } from '../src/install.js';
import { createSecrets } from '../src/secrets.js';

// In-memory fs: `files` maps path → content, `dirs` is a set. Records every write-side call.
function fakeFs(files = {}, dirs = []) {
  const state = { files: { ...files }, dirs: new Set(dirs), writes: [] };
  const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  return {
    state,
    existsSync: (p) => p in state.files || state.dirs.has(p),
    readFileSync: (p) => { if (p in state.files) return state.files[p]; throw enoent(p); },
    statSync: (p) => { if (p in state.files) return { isFile: () => true }; if (state.dirs.has(p)) return { isFile: () => false }; throw enoent(p); },
    mkdirSync: (p, opts) => { state.writes.push(['mkdir', p, opts]); state.dirs.add(p); },
    writeFileSync: (p, data, opts) => { state.writes.push(['write', p, opts]); state.files[p] = data; },
    rmSync: (p, opts) => { state.writes.push(['rm', p, opts]); delete state.files[p]; },
  };
}

// Fake promisified execFile: `handler(cmd, args)` returns stdout or throws. Records every call.
function fakeExec(handler = () => '') {
  const calls = [];
  const fn = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    return { stdout: await handler(cmd, args, opts), stderr: '' };
  };
  fn.calls = calls;
  return fn;
}

const out = () => {
  const lines = [];
  return { write: (s) => lines.push(s), text: () => lines.join('') };
};

// --- gh lookup and target -------------------------------------------------------------------

test('findOnPath: absolute path as is, else the first PATH dir holding it (PATHEXT on Windows)', () => {
  const fs = fakeFs({ '/opt/homebrew/bin/gh': '', '/usr/bin/gh': '', 'C:\\gh\\gh.exe': '' });
  assert.equal(findOnPath('gh', { env: { PATH: '/nope:/opt/homebrew/bin:/usr/bin' }, platform: 'darwin', fs }), '/opt/homebrew/bin/gh');
  assert.equal(findOnPath('/usr/bin/gh', { env: {}, platform: 'linux', fs }), '/usr/bin/gh');
  assert.equal(findOnPath('/missing/gh', { env: {}, platform: 'linux', fs }), null);
  assert.equal(findOnPath('gh', { env: { PATH: '/nope' }, platform: 'linux', fs }), null);
  assert.equal(findOnPath('gh', { env: { Path: 'C:\\x;C:\\gh', PATHEXT: '.COM;.EXE' }, platform: 'win32', fs }), 'C:\\gh\\gh.exe');
});

test('unitTarget: plist on macOS, systemd unit or .desktop on Linux, temp task XML on Windows', () => {
  assert.deepEqual(unitTarget({ platform: 'darwin', env: {}, homedir: '/Users/ada', fs: fakeFs() }),
    { kind: 'launchd', name: NAMES.label, file: '/Users/ada/Library/LaunchAgents/io.github.sanderhouttekier.pr-board.plist' });
  const systemd = fakeFs({}, ['/run/systemd/system']);
  assert.deepEqual(unitTarget({ platform: 'linux', env: {}, homedir: '/home/ada', fs: systemd }),
    { kind: 'systemd', name: NAMES.service, file: '/home/ada/.config/systemd/user/pr-board.service' });
  assert.deepEqual(unitTarget({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, homedir: '/home/ada', fs: systemd }).file,
    '/xdg/systemd/user/pr-board.service');
  assert.deepEqual(unitTarget({ platform: 'linux', env: { XDG_CONFIG_HOME: 'rel' }, homedir: '/home/ada', fs: fakeFs() }),
    { kind: 'desktop', name: 'pr-board.desktop', file: '/home/ada/.config/autostart/pr-board.desktop' });
  assert.deepEqual(unitTarget({ platform: 'win32', env: {}, homedir: 'C:\\Users\\ada', fs: fakeFs(), tmpdir: 'C:\\Temp' }),
    { kind: 'task', name: NAMES.task, file: 'C:\\Temp\\pr-board-task.xml' });
  assert.throws(() => unitTarget({ platform: 'aix', env: {}, homedir: '/', fs: fakeFs() }), /not supported/);
});

// --- command plans --------------------------------------------------------------------------

const runs = (steps) => steps.filter((s) => s.run).map((s) => [s.run, ...s.args]);

test('plan launchd: write plist, bootout (if loaded), bootstrap gui/<uid>; uninstall: bootout and delete', () => {
  const target = unitTarget({ platform: 'darwin', env: {}, homedir: '/Users/ada', fs: fakeFs() });
  const steps = planInstall({ target, content: 'PLIST', uid: 501, log: '/Users/ada/Library/Logs/pr-board.log' });
  assert.deepEqual(steps, [
    { mkdir: '/Users/ada/Library/LaunchAgents' },
    { mkdir: '/Users/ada/Library/Logs' },
    { write: target.file, content: 'PLIST' },
    { run: 'launchctl', args: ['bootout', 'gui/501/io.github.sanderhouttekier.pr-board'], optional: true },
    { run: 'launchctl', args: ['bootstrap', 'gui/501', target.file] },
  ]);
  assert.deepEqual(planUninstall({ target, uid: 501 }), [
    { run: 'launchctl', args: ['bootout', 'gui/501/io.github.sanderhouttekier.pr-board'], optional: true },
    { remove: target.file },
  ]);
});

test('plan systemd: daemon-reload, enable --now, restart; uninstall: disable --now, delete, daemon-reload', () => {
  const target = unitTarget({ platform: 'linux', env: {}, homedir: '/home/ada', fs: fakeFs({}, ['/run/systemd/system']) });
  const steps = planInstall({ target, content: 'UNIT', uid: 1000 });
  assert.deepEqual(steps.slice(0, 2), [{ mkdir: '/home/ada/.config/systemd/user' }, { write: target.file, content: 'UNIT' }]);
  assert.deepEqual(runs(steps), [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', '--now', 'pr-board.service'],
    ['systemctl', '--user', 'restart', 'pr-board.service'],
  ]);
  const un = planUninstall({ target, uid: 1000 });
  assert.deepEqual(un, [
    { run: 'systemctl', args: ['--user', 'disable', '--now', 'pr-board.service'], optional: true },
    { remove: target.file },
    { run: 'systemctl', args: ['--user', 'daemon-reload'] },
  ]);
});

test('plan .desktop: write the file only (starts at next login); uninstall deletes it', () => {
  const target = unitTarget({ platform: 'linux', env: {}, homedir: '/home/ada', fs: fakeFs() });
  assert.deepEqual(planInstall({ target, content: 'DESKTOP' }), [
    { mkdir: '/home/ada/.config/autostart' },
    { write: target.file, content: 'DESKTOP' },
  ]);
  assert.deepEqual(planUninstall({ target }), [{ remove: target.file }]);
});

test('plan task: UTF-16 temp XML, schtasks /create /xml /tn pr-board /f, /run, temp removed; uninstall: /end, /delete', () => {
  const target = unitTarget({ platform: 'win32', env: {}, homedir: 'C:\\Users\\ada', fs: fakeFs(), tmpdir: 'C:\\Temp' });
  assert.deepEqual(planInstall({ target, content: 'XML' }), [
    { write: 'C:\\Temp\\pr-board-task.xml', content: 'XML', encoding: 'utf16le' },
    { run: 'schtasks', args: ['/create', '/xml', 'C:\\Temp\\pr-board-task.xml', '/tn', 'pr-board', '/f'] },
    { remove: 'C:\\Temp\\pr-board-task.xml' },
    { run: 'schtasks', args: ['/run', '/tn', 'pr-board'] },
  ]);
  assert.deepEqual(planUninstall({ target }), [
    { run: 'schtasks', args: ['/end', '/tn', 'pr-board'], optional: true },
    { run: 'schtasks', args: ['/delete', '/tn', 'pr-board', '/f'] },
  ]);
});

test('applySteps: mkdir 0700-free recursive, write, run, remove; optional failures are swallowed, others throw', async () => {
  const fs = fakeFs();
  const exec = fakeExec((cmd, args) => { if (args[0] === 'bootout') throw new Error('not loaded'); return ''; });
  await applySteps([
    { mkdir: '/a' },
    { write: '/a/f', content: 'X' },
    { write: '/a/w', content: 'Y', encoding: 'utf16le' },
    { run: 'launchctl', args: ['bootout', 'x'], optional: true },
    { run: 'launchctl', args: ['bootstrap', 'y'] },
    { remove: '/a/f' },
  ], { execFile: exec, fs });
  assert.deepEqual(exec.calls, [['launchctl', 'bootout', 'x'], ['launchctl', 'bootstrap', 'y']]);
  assert.equal(fs.state.files['/a/f'], undefined);
  assert.deepEqual(fs.state.files['/a/w'], Buffer.from('\ufeffY', 'utf16le'));
  assert.deepEqual(fs.state.writes[0], ['mkdir', '/a', { recursive: true }]);
  const failing = fakeExec(() => { throw Object.assign(new Error('boom'), { stderr: 'Bootstrap failed: 5\n' }); });
  await assert.rejects(applySteps([{ run: 'launchctl', args: ['bootstrap', 'y'] }], { execFile: failing, fs }),
    /`launchctl bootstrap y` failed: Bootstrap failed: 5/);
});

// --- refusal rule ---------------------------------------------------------------------------

test('storeCommand: this OS\'s command from "Storing a token", ref quoted only when needed', () => {
  assert.equal(storeCommand('darwin', 'acme-bitbucket'),
    'security add-generic-password -U -a "$USER" -s acme-bitbucket -w "$(pbpaste)" (copy the token first), then pbcopy < /dev/null');
  assert.equal(storeCommand('darwin', "my ref's"),
    `security add-generic-password -U -a "$USER" -s 'my ref'\\''s' -w "$(pbpaste)" (copy the token first), then pbcopy < /dev/null`);
  assert.equal(storeCommand('linux', 'acme-jira'), 'secret-tool store --label=acme-jira service acme-jira (it prompts)');
  assert.equal(storeCommand('win32', 'acme-jira'), 'cmdkey /generic:acme-jira /user:token /pass (it prompts)');
  assert.equal(storeCommand('win32', 'my ref'), 'cmdkey /generic:"my ref" /user:token /pass (it prompts)');
});

// The config dir as the injected (POSIX) platform sees it, and the file paths as loadBoard builds
// them with the host's own path module (so the fake fs also matches on a Windows host).
const CFG = '/cfg';
const CONFIG_JSON = path.join(CFG, 'config.json');
const ACME_JSON = path.resolve(CFG, 'projects/acme.json');
const re = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const project = (extra = {}) => JSON.stringify({
  title: 'Acme',
  hosts: { github: { owner: 'acme-corp' }, bitbucket: { workspace: 'acme' } },
  tickets: [{ prefix: 'SHOP', browse: null, jira: 'main' }],
  jira: { main: { cloudId: '00000000-0000-4000-8000-000000000000' } },
  ...extra,
});
const boardFiles = (config, projects = { [ACME_JSON]: project() }) => ({ [CONFIG_JSON]: JSON.stringify(config), ...projects });
const BASE = {
  credentials: {
    github: { ref: '' },
    bitbucket: { ref: 'acme-bitbucket', email: 'ada@acme.example' },
    jira: { ref: 'acme-jira', email: 'ada@acme.example' },
  },
  projects: { acme: { file: 'projects/acme.json' } },
};

// Keychain holds `store`, gh answers `gh` (or fails), env holds tokens that must not count.
function macTools({ store = {}, gh = 'ghp_FAKE_GITHUB_TOKEN_0001' } = {}) {
  return fakeExec((cmd, args) => {
    if (cmd === 'security') { if (args[2] in store) return `${store[args[2]]}\n`; throw Object.assign(new Error('x'), { code: 44 }); }
    if (cmd === 'gh') { if (gh) return `${gh}\n`; throw new Error('not logged in'); }
    return '';
  });
}

async function check(config, { tools = macTools(), env = {}, projects, platform = 'darwin' } = {}) {
  const { loadBoard } = await import('../src/config.js');
  const fs = fakeFs(boardFiles(config, projects));
  const board = loadBoard({ dir: CFG, fs, env });
  const secrets = createSecrets({ execFile: tools, env, platform, settings: board.settings });
  return refusals({ board, secrets, platform });
}

const ALL_IN_STORE = { 'acme-bitbucket': 'ATBB_FAKE_BITBUCKET_TOKEN_0002', 'acme-jira': 'ATATT_FAKE_JIRA_TOKEN_0003' };

test('refusal: everything in the store and the global GitHub from gh → no refusal', async () => {
  assert.deepEqual(await check(BASE, { tools: macTools({ store: ALL_IN_STORE }) }), []);
});

test('refusal: no config.json, or a config with no projects → no refusal', async () => {
  assert.deepEqual(await check({ port: 7420 }), []);
});

test('refusal: a broken project names the file and the error', async () => {
  const lines = await check(BASE, { tools: macTools({ store: ALL_IN_STORE }), projects: { [ACME_JSON]: '{ nope' } });
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`^Project \`acme\`: ${re(ACME_JSON)}: Invalid JSON`));
});

test('refusal: an Atlassian credential with no store entry prints the ref and the store command', async () => {
  const lines = await check(BASE, { tools: macTools({ store: { 'acme-jira': 'ATATT_FAKE_JIRA_TOKEN_0003' } }) });
  assert.deepEqual(lines, [
    'Project `acme`: no Bitbucket token in Keychain entry `acme-bitbucket` (env vars don\'t count for a board started at login). Store it: '
      + storeCommand('darwin', 'acme-bitbucket'),
  ]);
});

test('refusal: an env-var-only token still refuses', async () => {
  const env = { ACME_BITBUCKET: 'ATBB_FAKE_BITBUCKET_TOKEN_0002', ACME_JIRA: 'ATATT_FAKE_JIRA_TOKEN_0003', GH_TOKEN: 'ghp_FAKE_GITHUB_TOKEN_0001' };
  const lines = await check(BASE, { env, tools: macTools({ gh: '' }) });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^Project `acme`: no GitHub token from `gh auth token`/);
  assert.match(lines[1], /`acme-bitbucket`/);
  assert.match(lines[2], /no Jira token in Keychain entry `acme-jira`/);
  for (const t of FAKE_TOKENS) assert.ok(!lines.join('\n').includes(t));
});

test('refusal: a missing email is named (the validator catches it in config.json)', async () => {
  const config = { ...BASE, credentials: { ...BASE.credentials, jira: { ref: 'acme-jira' } } };
  const lines = await check(config, { tools: macTools({ store: ALL_IN_STORE }) });
  assert.deepEqual(lines, [`Project \`acme\`: ${CONFIG_JSON}: ` + 'credentials.jira.email: Missing required key `credentials.jira.email`']);
});

test('refusal: resolvable answering missing email gets its own line', async () => {
  const board = { error: null, projects: [{ id: 'acme', ok: true, project: { hosts: { bitbucket: {} } }, credentials: { bitbucket: { ref: 'acme-bitbucket', override: false } } }] };
  const secrets = { resolvable: async () => ({ ok: false, missing: 'email' }) };
  assert.deepEqual(await refusals({ board, secrets, platform: 'linux' }), ['Project `acme`: no email for the Bitbucket credential `acme-bitbucket` in config.json.']);
});

test('refusal: resolvable is asked with autostart: true and the merged credential', async () => {
  const asked = [];
  const board = { error: null, projects: [{ id: 'acme', ok: true, project: { hosts: { github: {} } }, credentials: {} }] };
  const secrets = { resolvable: async (...a) => { asked.push(a); return { ok: true, missing: null }; } };
  assert.deepEqual(await refusals({ board, secrets, platform: 'darwin' }), []);
  assert.deepEqual(asked, [['github', { ref: '', override: false }, { autostart: true }]]);
});

test('refusal: credential overrides are checked, and jira only counts when a matcher names a site', async () => {
  const config = { ...BASE, projects: { acme: { file: 'projects/acme.json', credentials: { bitbucket: { ref: 'acme-own', email: 'a@b.c' } } } } };
  const noJira = { [ACME_JSON]: project({ tickets: [{ prefix: 'OPS', browse: null }], jira: undefined }) };
  const lines = await check(config, { tools: macTools({ store: ALL_IN_STORE }), projects: noJira });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /no Bitbucket token in Keychain entry `acme-own`/);
});

// --- CLI ------------------------------------------------------------------------------------

const REPO = '/Users/ada/src/pr-board';
function deps({ files = {}, dirs = [], tools = macTools({ store: ALL_IN_STORE }), env = {}, platform = 'darwin' } = {}) {
  const stdout = out();
  const stderr = out();
  const fs = fakeFs({ '/opt/homebrew/bin/gh': '', ...files }, dirs);
  return {
    stdout, stderr, fs, tools,
    d: {
      platform, env: { PR_BOARD_CONFIG_DIR: CFG, PATH: '/opt/homebrew/bin:/usr/bin', ...env }, homedir: '/Users/ada', uid: 501,
      execPath: '/Users/ada/.nvm/versions/node/v22.11.0/bin/node', repo: REPO, tmpdir: '/tmp',
      fs, execFile: tools, stdout, stderr,
    },
  };
}

test('main --print: renders the unit with the resolved config dir and gh dir, runs and writes nothing, no check', async () => {
  const t = deps({ files: boardFiles(BASE, { [ACME_JSON]: '{ broken' }), tools: macTools({ gh: '' }) });
  assert.equal(await main(['--print'], t.d), 0);
  assert.deepEqual(t.tools.calls, []);
  assert.deepEqual(t.fs.state.writes, []);
  const plist = t.stdout.text();
  assert.match(plist, /<string>\/Users\/ada\/src\/pr-board\/src\/server\.js<\/string>/);
  assert.match(plist, new RegExp(`<key>PR_BOARD_CONFIG_DIR</key><string>${re(CFG)}</string>`));
  assert.match(plist, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/Users\/ada\/\.nvm\/versions\/node\/v22\.11\.0\/bin:\/usr\/local\/bin/);
  assert.match(plist, /<string>\/Users\/ada\/Library\/Logs\/pr-board\.log<\/string>/);
});

test('main: install writes the plist and boots it in gui/<uid>, then prints the URL with the configured port', async () => {
  const t = deps({ files: boardFiles({ ...BASE, port: 7420 }) });
  assert.equal(await main([], t.d), 0, t.stderr.text());
  const plist = '/Users/ada/Library/LaunchAgents/io.github.sanderhouttekier.pr-board.plist';
  assert.match(t.fs.state.files[plist], /<key>Label<\/key><string>io\.github\.sanderhouttekier\.pr-board<\/string>/);
  assert.deepEqual(t.tools.calls.filter((c) => c[0] === 'launchctl'), [
    ['launchctl', 'bootout', 'gui/501/io.github.sanderhouttekier.pr-board'],
    ['launchctl', 'bootstrap', 'gui/501', plist],
  ]);
  assert.match(t.stdout.text(), /URL: http:\/\/127\.0\.0\.1:7420/);
  for (const tok of FAKE_TOKENS) assert.ok(!(t.stdout.text() + t.stderr.text() + t.fs.state.files[plist]).includes(tok));
});

test('main: a refusal exits 1, writes nothing, runs no OS tool, prints the misses and never a token', async () => {
  const t = deps({ files: boardFiles(BASE), tools: macTools({ store: { 'acme-jira': 'ATATT_FAKE_JIRA_TOKEN_0003' } }) });
  assert.equal(await main([], t.d), 1);
  assert.deepEqual(t.fs.state.writes, []);
  assert.deepEqual(t.tools.calls.filter((c) => c[0] === 'launchctl'), []);
  assert.match(t.stderr.text(), /acme-bitbucket/);
  assert.match(t.stderr.text(), /security add-generic-password/);
  for (const tok of FAKE_TOKENS) assert.ok(!(t.stdout.text() + t.stderr.text()).includes(tok));
});

test('main: a board error (broken config.json) refuses too', async () => {
  const t = deps({ files: { [CONFIG_JSON]: '{' } });
  assert.equal(await main([], t.d), 1);
  assert.match(t.stderr.text(), /config\.json: Invalid JSON/);
  assert.deepEqual(t.fs.state.writes, []);
});

test('main --uninstall: bootout and delete, no check', async () => {
  const plist = '/Users/ada/Library/LaunchAgents/io.github.sanderhouttekier.pr-board.plist';
  const t = deps({ files: { [plist]: 'x', ...boardFiles(BASE, { [ACME_JSON]: '{' }) } });
  assert.equal(await main(['--uninstall'], t.d), 0);
  assert.deepEqual(t.tools.calls, [['launchctl', 'bootout', 'gui/501/io.github.sanderhouttekier.pr-board']]);
  assert.equal(t.fs.state.files[plist], undefined);
});

test('main --url: the configured port (PORT in the installer env is ignored), nothing else', async () => {
  const t = deps({ files: boardFiles({ port: 7555 }), env: { PORT: '9999' } });
  assert.equal(await main(['--url'], t.d), 0);
  assert.equal(t.stdout.text(), 'http://127.0.0.1:7555\n');
  assert.deepEqual(t.tools.calls, []);
});

test('main: no --force, and any unknown flag prints usage and exits 2 without touching anything', async () => {
  for (const argv of [['--force'], ['--nope'], ['--print', '--uninstall']]) {
    const t = deps({ files: boardFiles(BASE) });
    assert.equal(await main(argv, t.d), 2);
    assert.match(t.stderr.text(), /usage/i);
    assert.deepEqual(t.tools.calls, []);
    assert.deepEqual(t.fs.state.writes, []);
  }
});

test('main on Linux with systemd: unit file + systemctl --user; Windows: task XML + schtasks', async () => {
  const linux = deps({ platform: 'linux', dirs: ['/run/systemd/system'], files: boardFiles({ port: 7420 }), env: { PATH: '/usr/bin' } });
  linux.d.homedir = '/home/ada';
  assert.equal(await main([], linux.d), 0, linux.stderr.text());
  assert.match(linux.fs.state.files['/home/ada/.config/systemd/user/pr-board.service'], /Restart=on-failure/);
  assert.deepEqual(linux.tools.calls[0], ['systemctl', '--user', 'daemon-reload']);

  const win = deps({ platform: 'win32', files: { 'C:\\cfg\\config.json': '{}', 'C:\\gh\\gh.exe': '' },
    env: { PR_BOARD_CONFIG_DIR: 'C:\\cfg', Path: 'C:\\gh', PATHEXT: '.EXE', USERDOMAIN: 'ACME', USERNAME: 'ada' } });
  Object.assign(win.d, { homedir: 'C:\\Users\\ada', tmpdir: 'C:\\Temp', execPath: 'C:\\node\\node.exe', repo: 'C:\\src\\pr-board' });
  assert.equal(await main([], win.d), 0, win.stderr.text());
  assert.deepEqual(win.tools.calls[0], ['schtasks', '/create', '/xml', 'C:\\Temp\\pr-board-task.xml', '/tn', 'pr-board', '/f']);
  const xmlWrite = win.fs.state.writes.find((w) => w[0] === 'write');
  assert.equal(xmlWrite[1], 'C:\\Temp\\pr-board-task.xml');
  assert.equal(win.fs.state.files['C:\\Temp\\pr-board-task.xml'], undefined, 'temp XML removed');
});
