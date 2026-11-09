import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, chmodSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configDir, ensureConfigDir } from '../src/configdir.js';

const MAC = { platform: 'darwin', homedir: '/Users/ada' };
const LINUX = { platform: 'linux', homedir: '/home/ada' };
const WIN = { platform: 'win32', homedir: 'C:\\Users\\ada' };

const cases = [
  ['macOS default', { ...MAC, env: {} }, '/Users/ada/.config/pr-board'],
  ['Linux default', { ...LINUX, env: {} }, '/home/ada/.config/pr-board'],
  ['PR_BOARD_CONFIG_DIR absolute wins', { ...MAC, env: { PR_BOARD_CONFIG_DIR: '/tmp/board', XDG_CONFIG_HOME: '/x' } }, '/tmp/board'],
  ['PR_BOARD_CONFIG_DIR relative is ignored', { ...LINUX, env: { PR_BOARD_CONFIG_DIR: 'board' } }, '/home/ada/.config/pr-board'],
  ['PR_BOARD_CONFIG_DIR empty is ignored', { ...LINUX, env: { PR_BOARD_CONFIG_DIR: '' } }, '/home/ada/.config/pr-board'],
  ['XDG_CONFIG_HOME absolute', { ...LINUX, env: { XDG_CONFIG_HOME: '/home/ada/cfg' } }, '/home/ada/cfg/pr-board'],
  ['XDG_CONFIG_HOME on macOS too', { ...MAC, env: { XDG_CONFIG_HOME: '/Users/ada/cfg' } }, '/Users/ada/cfg/pr-board'],
  ['XDG_CONFIG_HOME relative is ignored', { ...LINUX, env: { XDG_CONFIG_HOME: 'cfg' } }, '/home/ada/.config/pr-board'],
  ['XDG_CONFIG_HOME empty is ignored', { ...LINUX, env: { XDG_CONFIG_HOME: '' } }, '/home/ada/.config/pr-board'],
  ['Windows APPDATA set', { ...WIN, env: { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' } }, 'C:\\Users\\ada\\AppData\\Roaming\\pr-board'],
  ['Windows APPDATA unset', { ...WIN, env: {} }, 'C:\\Users\\ada\\AppData\\Roaming\\pr-board'],
  ['Windows APPDATA empty', { ...WIN, env: { APPDATA: '' } }, 'C:\\Users\\ada\\AppData\\Roaming\\pr-board'],
  ['Windows ignores XDG_CONFIG_HOME', { ...WIN, env: { XDG_CONFIG_HOME: 'C:\\cfg' } }, 'C:\\Users\\ada\\AppData\\Roaming\\pr-board'],
  ['Windows PR_BOARD_CONFIG_DIR absolute', { ...WIN, env: { PR_BOARD_CONFIG_DIR: 'D:\\board', APPDATA: 'C:\\x' } }, 'D:\\board'],
  ['Windows PR_BOARD_CONFIG_DIR relative is ignored', { ...WIN, env: { PR_BOARD_CONFIG_DIR: 'board', APPDATA: 'C:\\x' } }, 'C:\\x\\pr-board'],
];

for (const [name, input, expected] of cases) {
  test(`configDir: ${name}`, () => {
    assert.equal(configDir(input), expected);
  });
}

test('ensureConfigDir: creates a missing dir (and parents) with mode 0700', { skip: process.platform === 'win32' }, () => {
  const base = mkdtempSync(join(tmpdir(), 'pr-board-cfgdir-'));
  const dir = join(base, 'nested', 'pr-board');
  assert.equal(ensureConfigDir(dir, { fs }), dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('ensureConfigDir: leaves an existing dir and its mode alone', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-board-cfgdir-'));
  chmodSync(dir, 0o755);
  ensureConfigDir(dir, { fs });
  assert.equal(statSync(dir).mode & 0o777, 0o755);
});

test('ensureConfigDir: asks the injected fs for a recursive mkdir with mode 0700', () => {
  const calls = [];
  const fake = { mkdirSync: (p, opts) => calls.push([p, opts]) };
  ensureConfigDir('/cfg/pr-board', { fs: fake });
  assert.deepEqual(calls, [['/cfg/pr-board', { recursive: true, mode: 0o700 }]]);
});
