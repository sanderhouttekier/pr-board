// Autostart installer (SPEC "Autostart"): renders the unit for this OS, plans the OS tool calls,
// and applies the refusal rule. Every OS dependency (platform, execFile, fs, env, homedir, uid)
// is injected, so tests never spawn a real tool. Never reads, prints or renders a token:
// credentials are checked through secrets.resolvable(), which answers only ok/missing.
import path from 'node:path';
import { configDir as resolveConfigDir } from './configdir.js';
import { loadBoard } from './config.js';
import { createSecrets } from './secrets.js';

export const NAMES = Object.freeze({ label: 'io.github.sanderhouttekier.pr-board', service: 'pr-board.service', task: 'pr-board' });

const DEFAULT_PATH = {
  darwin: ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'],
  linux: ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'],
};

const unique = (list) => [...new Set(list.filter(Boolean))];

// PATH for the unit: the dir of `gh` and of node first, so the ones resolved at install time win.
// Windows appends the user's own %PATH% (expanded by cmd.exe when the task starts).
export function unitPath(platform, ghDir, execDir) {
  if (platform === 'win32') return [...unique([ghDir, execDir]), '%PATH%'].join(';');
  return unique([ghDir, execDir, ...(DEFAULT_PATH[platform] ?? DEFAULT_PATH.linux)]).join(':');
}

// The unit's env, none of it secret.
export function unitEnv({ configDir, path }) {
  return [
    ['PR_BOARD_CONFIG_DIR', configDir],
    ['PR_BOARD_AUTOSTARTED', '1'],
    ['PATH', path],
  ];
}

// --- renderers ------------------------------------------------------------------------------

// Text nodes only need &, < and >, so quotes stay readable in the plist and task XML.
const xmlText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderPlist({ execPath, server, repo, log, env }) {
  const s = (v) => `<string>${xmlText(v)}</string>`;
  const vars = env.map(([k, v]) => `    <key>${xmlText(k)}</key>${s(v)}`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${s(NAMES.label)}
  <key>ProgramArguments</key>
  <array>
    ${s(execPath)}
    ${s(server)}
  </array>
  <key>WorkingDirectory</key>${s(repo)}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key>${s(log)}
  <key>StandardErrorPath</key>${s(log)}
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
</dict>
</plist>
`;
}

// systemd: `%` starts a specifier, so it doubles everywhere; quoted words escape `\` and `"`.
const sdPercent = (s) => String(s).replace(/%/g, '%%');
const sdQuote = (s) => `"${sdPercent(String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'))}"`;

export function renderSystemd({ execPath, server, repo, env }) {
  return `[Unit]
Description=pr-board (local pull request board)
After=network-online.target

[Service]
Type=simple
ExecStart=${sdQuote(execPath)} ${sdQuote(server)}
WorkingDirectory=${sdPercent(repo)}
${env.map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`).join('\n')}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

// Desktop entry: quote an Exec argument (\ " ` $ get a backslash), then apply the string escape
// (\ doubles), then double `%` (field codes). Other keys get the string escape only.
const deString = (s) => String(s).replace(/\\/g, '\\\\');
const deArg = (s) => `"${deString(String(s).replace(/[\\"`$]/g, (c) => `\\${c}`)).replace(/%/g, '%%')}"`;

export function renderDesktop({ execPath, server, repo, env }) {
  const args = ['env', ...env.map(([k, v]) => deArg(`${k}=${v}`)), deArg(execPath), deArg(server)];
  return `[Desktop Entry]
Type=Application
Name=pr-board
Comment=Local pull request board
Exec=${args.join(' ')}
Path=${deString(repo)}
Terminal=false
X-GNOME-Autostart-enabled=true
`;
}

// Task Scheduler has no env for an Exec action, so cmd.exe sets it before starting node.
export function renderTask({ execPath, server, repo, env, userId }) {
  const sets = env.map(([k, v]) => `set "${k}=${v}"`);
  const args = `/d /c ${[...sets, `"${execPath}" "${server}"`].join(' && ')}`;
  const user = userId ? `\n      <UserId>${xmlText(userId)}</UserId>` : '';
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>pr-board (local pull request board)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>${user}
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">${user}
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
      <Arguments>${xmlText(args)}</Arguments>
      <WorkingDirectory>${xmlText(repo)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

// --- gh lookup and target -------------------------------------------------------------------

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

const isFile = (fs, p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

// Where `name` resolves on the installer's PATH (like `which`), or null. Used for the dir of `gh`.
export function findOnPath(name, { env, platform, fs }) {
  const p = pathFor(platform);
  if (!name) return null;
  if (p.isAbsolute(name)) return isFile(fs, name) ? name : null;
  if (name.includes('/') || (platform === 'win32' && name.includes('\\'))) return null;
  const dirs = String(env.PATH ?? env.Path ?? '').split(p.delimiter).filter(Boolean);
  const exts = platform === 'win32'
    ? ['', ...String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())]
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = p.join(dir, name + ext);
      if (isFile(fs, candidate)) return candidate;
    }
  }
  return null;
}

// Where the unit goes, and which kind it is.
export function unitTarget({ platform, env, homedir, fs, tmpdir }) {
  const p = pathFor(platform);
  switch (platform) {
    case 'darwin':
      return { kind: 'launchd', name: NAMES.label, file: p.join(homedir, 'Library', 'LaunchAgents', `${NAMES.label}.plist`) };
    case 'linux': {
      const xdg = env.XDG_CONFIG_HOME;
      const base = typeof xdg === 'string' && p.isAbsolute(xdg) ? xdg : p.join(homedir, '.config');
      if (fs.existsSync('/run/systemd/system')) return { kind: 'systemd', name: NAMES.service, file: p.join(base, 'systemd', 'user', NAMES.service) };
      return { kind: 'desktop', name: 'pr-board.desktop', file: p.join(base, 'autostart', 'pr-board.desktop') };
    }
    case 'win32':
      return { kind: 'task', name: NAMES.task, file: p.join(tmpdir, 'pr-board-task.xml') };
    default:
      throw new Error(`Autostart is not supported on ${platform}`);
  }
}

// --- command plans --------------------------------------------------------------------------
// A step is { mkdir } | { write, content, encoding? } | { run, args, optional? } | { remove }.

export function planInstall({ target, content, uid, log }) {
  const p = target.kind === 'task' ? path.win32 : path.posix;
  const sc = (...args) => ({ run: 'systemctl', args: ['--user', ...args] });
  switch (target.kind) {
    case 'launchd':
      return [
        { mkdir: p.dirname(target.file) },
        { mkdir: p.dirname(log) },
        { write: target.file, content },
        { run: 'launchctl', args: ['bootout', `gui/${uid}/${NAMES.label}`], optional: true },
        { run: 'launchctl', args: ['bootstrap', `gui/${uid}`, target.file] },
      ];
    case 'systemd':
      return [
        { mkdir: p.dirname(target.file) },
        { write: target.file, content },
        sc('daemon-reload'),
        sc('enable', '--now', NAMES.service),
        // enable --now leaves an already running board on the old unit; restart picks up the new one.
        sc('restart', NAMES.service),
      ];
    case 'desktop':
      return [{ mkdir: p.dirname(target.file) }, { write: target.file, content }];
    case 'task':
      return [
        { write: target.file, content, encoding: 'utf16le' },
        { run: 'schtasks', args: ['/create', '/xml', target.file, '/tn', NAMES.task, '/f'] },
        { remove: target.file },
        { run: 'schtasks', args: ['/run', '/tn', NAMES.task] },
      ];
    default:
      throw new Error(`Unknown unit kind ${target.kind}`);
  }
}

export function planUninstall({ target, uid }) {
  switch (target.kind) {
    case 'launchd':
      return [{ run: 'launchctl', args: ['bootout', `gui/${uid}/${NAMES.label}`], optional: true }, { remove: target.file }];
    case 'systemd':
      return [
        { run: 'systemctl', args: ['--user', 'disable', '--now', NAMES.service], optional: true },
        { remove: target.file },
        { run: 'systemctl', args: ['--user', 'daemon-reload'] },
      ];
    case 'desktop':
      return [{ remove: target.file }];
    case 'task':
      return [
        { run: 'schtasks', args: ['/end', '/tn', NAMES.task], optional: true },
        { run: 'schtasks', args: ['/delete', '/tn', NAMES.task, '/f'] },
      ];
    default:
      throw new Error(`Unknown unit kind ${target.kind}`);
  }
}

// Runs the steps in order. The OS tools here never see a token, so their stderr is safe to show.
export async function applySteps(steps, { execFile, fs }) {
  for (const step of steps) {
    if (step.mkdir) fs.mkdirSync(step.mkdir, { recursive: true });
    else if (step.write) {
      const data = step.encoding === 'utf16le' ? Buffer.from(`﻿${step.content}`, 'utf16le') : step.content;
      fs.writeFileSync(step.write, data);
    } else if (step.remove) fs.rmSync(step.remove, { force: true });
    else if (step.run) {
      try {
        await execFile(step.run, step.args, { windowsHide: true });
      } catch (err) {
        if (step.optional) continue;
        const detail = String(err?.stderr ?? '').trim() || err?.message || 'unknown error';
        throw new Error(`\`${[step.run, ...step.args].join(' ')}\` failed: ${detail}`);
      }
    }
  }
}

// --- refusal rule ---------------------------------------------------------------------------

const STORE = { darwin: 'Keychain', linux: 'Secret Service', win32: 'Credential Manager' };
const HOST_LABEL = { github: 'GitHub', bitbucket: 'Bitbucket', jira: 'Jira' };

const posixQuote = (s) => (/^[A-Za-z0-9._@:+=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
const winQuote = (s) => (/^[A-Za-z0-9._@:+=-]+$/.test(s) ? s : `"${s}"`);

// This OS's command from SPEC "Storing a token", for one reference.
export function storeCommand(platform, ref) {
  switch (platform) {
    case 'darwin':
      return `security add-generic-password -U -a "$USER" -s ${posixQuote(ref)} -w "$(pbpaste)" (copy the token first), then pbcopy < /dev/null`;
    case 'linux':
      return `secret-tool store --label=${posixQuote(ref)} service ${posixQuote(ref)} (it prompts)`;
    case 'win32':
      return `cmdkey /generic:${winQuote(ref)} /user:token /pass (it prompts)`;
    default:
      return `no OS secret store is supported on ${platform}`;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// SPEC "Refusal rule": github/bitbucket when under `hosts`, jira when any matcher names a Jira site.
function hostsUsed(project) {
  const used = ['github', 'bitbucket'].filter((h) => isObject(project.hosts) && h in project.hosts);
  if (Array.isArray(project.tickets) && project.tickets.some((m) => isObject(m) && typeof m.jira === 'string' && m.jira !== '')) used.push('jira');
  return used;
}

const errorLines = (prefix, error) => error.errors.map((e) => `${prefix}${error.file}: ${e.path ? `${e.path}: ` : ''}${e.message}`);

/**
 * The refusal rule: one line per miss (empty when the install may go ahead). Never a token.
 * Only sources an autostarted board sees count: the OS store, and `gh auth token` for the global GitHub.
 */
export async function refusals({ board, secrets, platform }) {
  if (board.error) return errorLines('', board.error);
  const lines = [];
  for (const entry of board.projects) {
    const prefix = `Project \`${entry.id}\`: `;
    if (!entry.ok) {
      lines.push(...errorLines(prefix, entry.error));
      continue;
    }
    for (const host of hostsUsed(entry.project)) {
      const credential = entry.credentials?.[host] ?? { ref: '', override: false };
      const { ok, missing } = await secrets.resolvable(host, credential, { autostart: true });
      if (ok) continue;
      const label = HOST_LABEL[host];
      const { ref } = credential;
      if (missing === 'email') lines.push(`${prefix}no email for the ${label} credential \`${ref}\` in config.json.`);
      else if (!ref && host === 'github' && !credential.override) {
        lines.push(`${prefix}no GitHub token from \`gh auth token\`. Run \`gh auth login\`, or set credentials.github.ref in config.json and store the token: ${storeCommand(platform, '<ref>')}`);
      } else if (!ref) lines.push(`${prefix}no ${label} credential in config.json.`);
      else {
        lines.push(`${prefix}no ${label} token in ${STORE[platform] ?? 'the OS store'} entry \`${ref}\` (env vars don't count for a board started at login). Store it: ${storeCommand(platform, ref)}`);
      }
    }
  }
  return lines;
}

// --- CLI ------------------------------------------------------------------------------------

const USAGE = 'usage: node scripts/install.js [--print | --uninstall | --url]\n';

/**
 * The installer. deps: { platform, env, homedir, uid, execPath, repo, tmpdir, fs, execFile, stdout, stderr }.
 * → exit code (0 done, 1 refused or failed, 2 usage).
 */
export async function main(argv, deps) {
  const { platform, env, homedir, uid, execPath, repo, tmpdir, fs, execFile, stdout, stderr } = deps;
  const say = (s) => stdout.write(`${s}\n`);
  const fail = (s) => { stderr.write(`${s}\n`); return 1; };

  const flag = argv.length === 0 ? 'install' : argv.length === 1 && { '--print': 'print', '--uninstall': 'uninstall', '--url': 'url' }[argv[0]];
  if (!flag) {
    stderr.write(USAGE);
    return 2;
  }

  const dir = resolveConfigDir({ env, platform, homedir });
  // The unit sets no PORT, so the installer's own PORT must not change the URL it prints.
  const boardEnv = { ...env };
  delete boardEnv.PORT;
  const loadAll = () => loadBoard({ dir, fs, env: boardEnv });

  if (flag === 'url') {
    say(`http://127.0.0.1:${loadAll().settings.port}`);
    return 0;
  }

  let target;
  try {
    target = unitTarget({ platform, env, homedir, fs, tmpdir });
  } catch (err) {
    return fail(err.message);
  }

  if (flag === 'uninstall') {
    try {
      await applySteps(planUninstall({ target, uid }), { execFile, fs });
    } catch (err) {
      return fail(err.message);
    }
    say(`Removed ${target.name}${target.kind === 'task' ? '' : ` (${target.file})`}`);
    return 0;
  }

  const p = pathFor(platform);
  const board = loadAll();
  const gh = findOnPath(board.settings.ghPath, { env, platform, fs });
  const unit = {
    execPath,
    repo,
    server: p.join(repo, 'src', 'server.js'),
    log: p.join(homedir, 'Library', 'Logs', 'pr-board.log'),
    env: unitEnv({ configDir: dir, path: unitPath(platform, gh && p.dirname(gh), p.dirname(execPath)) }),
    userId: env.USERNAME ? (env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME) : null,
  };
  const content = { launchd: renderPlist, systemd: renderSystemd, desktop: renderDesktop, task: renderTask }[target.kind](unit);

  if (flag === 'print') {
    stdout.write(content);
    return 0;
  }

  const secrets = createSecrets({ execFile, env, platform, settings: board.settings });
  const misses = await refusals({ board, secrets, platform });
  if (misses.length) {
    stderr.write(`Not installed: a board started at login couldn't run every project (${dir}).\n`);
    for (const line of misses) stderr.write(`- ${line}\n`);
    return 1;
  }

  try {
    await applySteps(planInstall({ target, content, uid, log: unit.log }), { execFile, fs });
  } catch (err) {
    return fail(err.message);
  }
  say(`Installed ${target.name}${target.kind === 'task' ? '' : ` (${target.file})`}`);
  say(`URL: http://127.0.0.1:${board.settings.port}`);
  if (target.kind === 'launchd') say(`Log: ${unit.log}`);
  if (target.kind === 'systemd') say(`Log: journalctl --user -u ${NAMES.service}`);
  if (target.kind === 'desktop') say('Starts at your next login (no crash restart). Run `npm start` to start it now.');
  return 0;
}
