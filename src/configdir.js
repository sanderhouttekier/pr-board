// Resolves the one config dir the board reads everything from (SPEC "Config dir").
// Pure over the injected env, platform and homedir; path flavour follows the injected platform.
import * as nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = 'pr-board';

const nonEmpty = (v) => typeof v === 'string' && v !== '';

export function configDir({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const absolute = (v) => nonEmpty(v) && p.isAbsolute(v);

  if (absolute(env.PR_BOARD_CONFIG_DIR)) return p.normalize(env.PR_BOARD_CONFIG_DIR);
  if (platform === 'win32') {
    const base = absolute(env.APPDATA) ? env.APPDATA : p.join(homedir, 'AppData', 'Roaming');
    return p.join(base, APP);
  }
  const base = absolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : p.join(homedir, '.config');
  return p.join(base, APP);
}

// Creates the dir (and parents) with mode 0700 when missing; an existing dir is left as it is.
// The mode is ignored on Windows.
export function ensureConfigDir(dir, { fs = nodeFs } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
