#!/usr/bin/env node
// Starts the board at login on this OS (SPEC "Autostart"). Usage: node scripts/install.js [--print | --uninstall | --url]
// Thin wrapper: all logic lives in src/install.js with injected OS dependencies.
import { execFile as execFileCb } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { main } from '../src/install.js';

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  process.stderr.write(`${process.execPath} is Node ${process.versions.node}; pr-board needs Node 22 or newer.\n`);
  process.exit(1);
}

process.exitCode = await main(process.argv.slice(2), {
  platform: process.platform,
  env: process.env,
  homedir: os.homedir(),
  uid: typeof process.getuid === 'function' ? process.getuid() : null,
  execPath: fs.realpathSync(process.execPath),
  repo: fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')),
  tmpdir: os.tmpdir(),
  fs,
  execFile: promisify(execFileCb),
  stdout: process.stdout,
  stderr: process.stderr,
});
