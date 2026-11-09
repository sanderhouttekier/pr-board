// Loads the personal config and the project files from the config dir (SPEC "Config").
// Never throws on a config file: problems become a board error, or an error on one project.
// Never reads a token: credentials are references only (src/secrets.js resolves them).
import * as nodeFs from 'node:fs';
import path from 'node:path';
import { validateConfig, validateProject, isBlank } from './validate.js';

export const DEFAULT_SETTINGS = Object.freeze({
  port: 7419,
  intervalSec: 300,
  idleAfterSec: 900,
  idleIntervalSec: 3600,
  staleDays: 14,
  behindWarn: 20,
  ghPath: 'gh',
  mine: Object.freeze({}),
  fixNotes: Object.freeze({}),
});

const SCALARS = ['port', 'intervalSec', 'idleAfterSec', 'idleIntervalSec', 'staleDays', 'behindWarn', 'ghPath'];
const HOSTS = ['github', 'bitbucket', 'jira'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonBlank = (o, keys) => Object.fromEntries(keys.filter((k) => typeof o?.[k] === 'string' && !isBlank(o[k])).map((k) => [k, o[k]]));

function defaults(env) {
  const settings = { ...DEFAULT_SETTINGS, mine: {}, fixNotes: {} };
  return applyPortEnv(settings, env);
}

// PORT wins when it is a plain integer in the port range.
function applyPortEnv(settings, env) {
  const raw = env?.PORT;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n >= 1 && n <= 65535) settings.port = n;
  }
  return settings;
}

// { json } | { missing: true } | { error } — the error holds no file content.
function readJson(fs, file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { missing: true };
    return { error: `Can't read the file (${err?.code ?? 'unknown error'})` };
  }
  try {
    return { json: JSON.parse(String(text).replace(/^﻿/, '')) };
  } catch (err) {
    return { error: `Invalid JSON: ${err.message}` };
  }
}

// Which part of the board a config problem belongs to: a project entry, a global credential, or the board.
function scopeOf(p, projectIds) {
  for (const id of projectIds) {
    if (p === `projects.${id}` || p.startsWith(`projects.${id}.`)) return { project: id };
  }
  const cred = /^credentials\.(github|bitbucket|jira)(?:\.|$)/.exec(p);
  if (cred) return { credential: cred[1] };
  return { board: true };
}

// Per host: the project's override when it has one, else the global credential. Known fields only.
function mergeCredentials(global, override) {
  const out = {};
  for (const host of HOSTS) {
    const own = isObject(override?.[host]) ? override[host] : null;
    const src = own ?? (isObject(global?.[host]) ? global[host] : null);
    if (!src) continue;
    out[host] = { ref: src.ref, ...(src.email !== undefined && { email: src.email }), override: own !== null };
  }
  return out;
}

// The hosts a project needs a credential for.
function hostsUsed(project) {
  const used = Object.keys(project.hosts ?? {}).filter((h) => h === 'github' || h === 'bitbucket');
  if (isObject(project.jira) && Object.keys(project.jira).length > 0) used.push('jira');
  return used;
}

function loadProject({ id, entry, dir, fs, configFile, entryErrors, entryWarnings, credentialErrors, globalCredentials }) {
  const withFile = (file) => (list) => list.map(({ path: p, message }) => ({ file, path: p, message }));
  const warnings = withFile(configFile)(entryWarnings);
  const result = { id, title: id, file: null, ok: false, error: null, warnings, project: null, credentials: null };
  const stop = (file, errors) => ({ ...result, error: { file, errors } });

  if (entryErrors.length) {
    if (isObject(entry) && typeof entry.file === 'string' && entry.file !== '') result.file = path.resolve(dir, entry.file);
    return stop(configFile, entryErrors);
  }

  const file = path.resolve(dir, entry.file);
  result.file = file;
  result.credentials = mergeCredentials(globalCredentials, entry.credentials);

  const read = readJson(fs, file);
  if (read.missing) return stop(file, [{ path: '', message: 'File not found' }]);
  if (read.error) return stop(file, [{ path: '', message: read.error }]);

  const json = read.json;
  if (isObject(json) && typeof json.title === 'string' && json.title !== '') result.title = json.title;
  const { errors, warnings: fileWarnings } = validateProject(json);
  result.warnings = [...warnings, ...withFile(file)(fileWarnings)];
  if (errors.length) return stop(file, errors);

  // A broken global credential stops only the projects that inherit it for a host they use.
  const inherited = hostsUsed(json).filter((h) => !result.credentials[h]?.override && credentialErrors[h]?.length);
  if (inherited.length) return stop(configFile, inherited.flatMap((h) => credentialErrors[h]));

  const project = { ...json };
  if (isObject(json.fixPrompts)) project.fixPrompts = nonBlank(json.fixPrompts, Object.keys(json.fixPrompts));
  return { ...result, ok: true, project };
}

/**
 * Loads the board from a config dir.
 * → { settings, warnings, error, projects: [{ id, title, file, ok, error, warnings, project, credentials }] }
 * `error` (board or project) is null or { file, errors: [{ path, message }] }; warnings are { file, path, message }.
 */
export function loadBoard({ dir, fs = nodeFs, env = process.env }) {
  const configFile = path.join(dir, 'config.json');
  const empty = (error = null, warnings = []) => ({ settings: defaults(env), warnings, error, projects: [] });

  const read = readJson(fs, configFile);
  if (read.missing) return empty();
  if (read.error) return empty({ file: configFile, errors: [{ path: '', message: read.error }] });

  const config = read.json;
  const { errors, warnings } = validateConfig(config);
  const projectIds = isObject(config) && isObject(config.projects) ? Object.keys(config.projects) : [];
  // Longest id first, so `projects.acme-x.file` never lands on project `acme`.
  const scopeIds = [...projectIds].sort((a, b) => b.length - a.length);
  const split = (list) => {
    const out = { board: [], project: {}, credential: {} };
    for (const item of list) {
      const s = scopeOf(item.path, scopeIds);
      if (s.project) (out.project[s.project] ??= []).push(item);
      else if (s.credential) (out.credential[s.credential] ??= []).push(item);
      else out.board.push(item);
    }
    return out;
  };
  const e = split(errors);
  const w = split(warnings);
  const boardWarnings = [...w.board, ...Object.values(w.credential).flat()].map((x) => ({ file: configFile, ...x }));
  if (e.board.length) return empty({ file: configFile, errors: e.board }, boardWarnings);

  const settings = defaults({});
  for (const key of SCALARS) if (config[key] !== undefined) settings[key] = config[key];
  settings.mine = isObject(config.mine) ? nonBlank(config.mine, ['github', 'bitbucket']) : {};
  settings.fixNotes = isObject(config.fixNotes) ? nonBlank(config.fixNotes, ['github', 'bitbucket', 'all']) : {};
  applyPortEnv(settings, env);

  const projects = projectIds.map((id) => loadProject({
    id,
    entry: config.projects[id],
    dir,
    fs,
    configFile,
    entryErrors: e.project[id] ?? [],
    entryWarnings: w.project[id] ?? [],
    credentialErrors: e.credential,
    globalCredentials: config.credentials,
  }));

  return { settings, warnings: boardWarnings, error: null, projects };
}

// --- Display strings (snapshot, tabs, logs) -----------------------------------------------

/** A board or project error as one line: the file path, then every message. null stays null. */
export function describeError(error) {
  if (!error) return null;
  return `${error.file}: ${error.errors.map((e) => e.message).join('; ')}`;
}

/** A config warning as one line: the file name and the message. A string is already one. */
export function describeWarning(warning) {
  if (typeof warning === 'string') return warning;
  return `${path.basename(warning.file)}: ${warning.message}`;
}
