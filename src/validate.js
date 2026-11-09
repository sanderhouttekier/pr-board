// Hand-written validator for the project file and the personal config (SPEC "Validation").
// Pure: no I/O. The rule tables mirror projects/project.schema.json and config.schema.json path
// by path; test/validate.test.js flattens both schemas and asserts they match these tables.
//
// Rule-table notation: one entry per path. `a.b` is a property, `a.*` the schema for any other
// key (additionalProperties), `a[]` the array items, `a#i` the i-th oneOf variant. A rule holds
// the schema keywords type, required, pattern, const, enum, minimum, maximum, minLength,
// minItems, minProperties and uniqueItems, plus `closed` (additionalProperties: false),
// `keys` (propertyNames pattern) and `oneOf` (the number of variants).
//
// Unlike a strict schema validator, an unknown key in a closed object is a warning, not an error.

const NAME = '^[A-Za-z0-9._-]+$';
const REPO_REF = '^((github|bitbucket):)?[A-Za-z0-9._-]+$';

const str = (extra = {}) => ({ type: 'string', ...extra });
const int = (extra = {}) => ({ type: 'integer', ...extra });
const obj = (extra = {}) => ({ type: 'object', ...extra });
const closed = (extra = {}) => ({ type: 'object', ...extra, closed: true });
const arr = (extra = {}) => ({ type: 'array', ...extra });

const FIX_PROMPT_KEYS = ['conflict', 'ci-failed', 'base-retarget', 'base-no-pr', 'lock-unpin', 'lock-missing', 'lock-pinned', 'group'];

export const PROJECT_RULES = {
  '': closed({ required: ['hosts'] }),
  $schema: str(),
  title: str({ minLength: 1 }),
  hosts: closed({ minProperties: 1 }),
  'hosts.github': closed({ required: ['owner'] }),
  'hosts.github.owner': str({ pattern: NAME }),
  'hosts.bitbucket': closed({ required: ['workspace'] }),
  'hosts.bitbucket.workspace': str({ pattern: NAME }),
  repos: closed(),
  'repos.github': arr({ uniqueItems: true }),
  'repos.github[]': str({ pattern: NAME }),
  'repos.bitbucket': arr({ uniqueItems: true }),
  'repos.bitbucket[]': str({ pattern: NAME }),
  aliases: obj({ keys: REPO_REF }),
  'aliases.*': str({ pattern: NAME }),
  tickets: arr(),
  'tickets[]': { oneOf: 2 },
  'tickets[]#0': closed({ required: ['prefix', 'browse'] }),
  'tickets[]#0.prefix': str({ pattern: '^[A-Za-z][A-Za-z0-9]*$' }),
  'tickets[]#0.browse': { oneOf: 2 },
  'tickets[]#0.browse#0': str({ pattern: '^https://.*\\{key\\}' }),
  'tickets[]#0.browse#1': { type: 'null' },
  'tickets[]#0.jira': str({ pattern: NAME }),
  'tickets[]#1': closed({ required: ['link'] }),
  'tickets[]#1.link': str({ pattern: '^[A-Za-z0-9.-]+\\.[A-Za-z]+/.+/$' }),
  jira: obj({ keys: NAME }),
  'jira.*': closed({ required: ['cloudId'] }),
  'jira.*.cloudId': str({ pattern: '^[0-9a-fA-F-]{36}$' }),
  sharedPackages: arr(),
  'sharedPackages[]': closed({ required: ['repo', 'kind', 'package', 'consumers'] }),
  'sharedPackages[].repo': str({ pattern: REPO_REF }),
  'sharedPackages[].kind': { const: 'composer' },
  'sharedPackages[].package': str({ pattern: '^[a-z0-9_.-]+/[a-z0-9_.-]+$' }),
  'sharedPackages[].consumers': arr({ minItems: 1 }),
  'sharedPackages[].consumers[]': str({ pattern: REPO_REF }),
  fixPrompts: closed(),
  ...Object.fromEntries(FIX_PROMPT_KEYS.map((k) => [`fixPrompts.${k}`, str()])),
};

function credentialRules(p) {
  const atlassian = (host) => ({
    [`${p}.${host}`]: closed({ required: ['ref', 'email'] }),
    [`${p}.${host}.ref`]: str({ minLength: 1 }),
    [`${p}.${host}.email`]: str({ pattern: '^[^@\\s]+@[^@\\s]+$' }),
  });
  return {
    [p]: closed(),
    [`${p}.github`]: closed({ required: ['ref'] }),
    [`${p}.github.ref`]: str(),
    ...atlassian('bitbucket'),
    ...atlassian('jira'),
  };
}

export const CONFIG_RULES = {
  '': closed(),
  $schema: str(),
  port: int({ minimum: 1, maximum: 65535 }),
  intervalSec: int({ minimum: 30 }),
  idleAfterSec: int({ minimum: 60 }),
  idleIntervalSec: int({ minimum: 300 }),
  staleDays: int({ minimum: 1 }),
  behindWarn: int({ minimum: 1 }),
  ghPath: str({ minLength: 1 }),
  ...credentialRules('credentials'),
  projects: obj({ keys: '^[a-z0-9][a-z0-9-]*$' }),
  'projects.*': closed({ required: ['file'] }),
  'projects.*.file': str({ minLength: 1 }),
  ...credentialRules('projects.*.credentials'),
  mine: closed(),
  'mine.github': str(),
  'mine.bitbucket': str(),
  fixNotes: closed(),
  'fixNotes.github': str(),
  'fixNotes.bitbucket': str(),
  'fixNotes.all': str(),
};

// --- Engine --------------------------------------------------------------------------------

export const isBlank = (v) => typeof v === 'string' && v.trim() === '';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const code = (s) => `\`${s}\``;
const joinRule = (p, k) => (p === '' ? k : `${p}.${k}`);
const joinPath = joinRule;
// A key that could be mistaken for rule-table syntax never matches a named rule.
const plainKey = (k) => /^[^.*#[\]]+$/.test(k);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function hasType(v, type) {
  const t = typeOf(v);
  return t === type || (type === 'number' && t === 'integer');
}

// For messages: "got number" for any number, integer or not.
const shown = (v) => (typeof v === 'number' ? 'number' : typeOf(v));

const withArticle = (t) => (/^[aeiou]/.test(t) ? `an ${t}` : `a ${t}`);

function walk(rules, value, rp, at, out, blankAbsent) {
  const rule = rules[rp];
  const subject = at === '' ? 'The file' : code(at);
  const err = (message, path = at) => out.errors.push({ path, message });

  if (rule.oneOf) return walkOneOf(rules, value, rp, at, out, blankAbsent);

  if (rule.type && !hasType(value, rule.type)) {
    return err(at === '' ? `The file must hold ${withArticle(rule.type)}, got ${shown(value)}`
      : `${subject} must be ${withArticle(rule.type)}, got ${shown(value)}`);
  }
  if ('const' in rule && value !== rule.const) return err(`${subject} must be ${code(rule.const)}`);
  if (rule.enum && !rule.enum.includes(value)) return err(`${subject} must be one of ${rule.enum.map(code).join(', ')}`);

  if (typeof value === 'string') {
    if (rule.minLength !== undefined && value.length < rule.minLength) {
      return err(rule.minLength === 1 ? `${subject} must not be empty` : `${subject} must be at least ${rule.minLength} characters`);
    }
    if (rule.pattern !== undefined && !new RegExp(rule.pattern, 'u').test(value)) return err(`${subject} doesn't match ${rule.pattern}`);
  }
  if (typeof value === 'number') {
    if (rule.minimum !== undefined && value < rule.minimum) return err(`${subject} must be at least ${rule.minimum}`);
    if (rule.maximum !== undefined && value > rule.maximum) return err(`${subject} must be at most ${rule.maximum}`);
  }
  if (Array.isArray(value)) {
    if (rule.minItems !== undefined && value.length < rule.minItems) return err(`${subject} needs at least ${rule.minItems} item(s)`);
    if (rule.uniqueItems) {
      const seen = new Set();
      const dup = value.map((v) => JSON.stringify(v)).find((v) => (seen.has(v) ? true : (seen.add(v), false)));
      if (dup !== undefined) return err(`${subject} lists ${dup} more than once`);
    }
    const itemRule = `${rp}[]`;
    if (rules[itemRule]) value.forEach((v, i) => walk(rules, v, itemRule, `${at}[${i}]`, out, blankAbsent));
  }
  if (isObject(value)) walkObject(rules, value, rule, rp, at, out, blankAbsent);
}

function walkObject(rules, value, rule, rp, at, out, blankAbsent) {
  const anyRule = joinRule(rp, '*');
  let known = 0;
  for (const [k, v] of Object.entries(value)) {
    const keyPath = joinPath(at, k);
    if (blankAbsent.has(rp) && isBlank(v)) continue;
    const named = plainKey(k) ? joinRule(rp, k) : null;
    if (named && rules[named]) {
      known++;
      walk(rules, v, named, keyPath, out, blankAbsent);
    } else if (rules[anyRule] || rule.keys) {
      known++;
      if (rule.keys && !new RegExp(rule.keys, 'u').test(k)) {
        out.errors.push({ path: keyPath, message: `Key ${code(keyPath)} doesn't match ${rule.keys}` });
      } else if (rules[anyRule]) walk(rules, v, anyRule, keyPath, out, blankAbsent);
    } else if (rule.closed) {
      out.warnings.push({ path: keyPath, message: `Unknown key ${code(keyPath)}, ignored` });
    }
  }
  for (const r of rule.required ?? []) {
    if (!Object.hasOwn(value, r)) {
      const p = joinPath(at, r);
      out.errors.push({ path: p, message: `Missing required key ${code(p)}` });
    }
  }
  if (rule.minProperties !== undefined && known < rule.minProperties) {
    const prefix = rp === '' ? '' : `${rp}.`;
    const names = Object.keys(rules).filter((p) => p.startsWith(prefix) && plainKey(p.slice(prefix.length))).map((p) => p.slice(prefix.length));
    out.errors.push({ path: at, message: `${code(at)} needs at least ${rule.minProperties} of ${names.map(code).join(', ')}` });
  }
}

// Picks the variant by type; among object variants, by which one's first required key is present.
function walkOneOf(rules, value, rp, at, out, blankAbsent) {
  const variants = Array.from({ length: rules[rp].oneOf }, (_, i) => ({ rp: `${rp}#${i}`, rule: rules[`${rp}#${i}`] }));
  let candidates = variants.filter((v) => !v.rule.type || hasType(value, v.rule.type));
  if (candidates.length === 0) {
    const types = [...new Set(variants.map((v) => v.rule.type).filter(Boolean))];
    return out.errors.push({ path: at, message: `${code(at)} must be ${types.map(withArticle).join(' or ')}, got ${shown(value)}` });
  }
  if (candidates.length > 1 && isObject(value)) {
    const keys = candidates.map((v) => v.rule.required?.[0]);
    const present = candidates.filter((v, i) => keys[i] !== undefined && Object.hasOwn(value, keys[i]));
    if (present.length !== 1) {
      return out.errors.push({ path: at, message: `${code(at)} needs exactly one of ${keys.map(code).join(' or ')}` });
    }
    candidates = present;
  }
  if (candidates.length > 1) {
    // Not reachable with the shipped schemas; accept the first variant that fits.
    for (const v of candidates) {
      const trial = { errors: [], warnings: [] };
      walk(rules, value, v.rp, at, trial, blankAbsent);
      if (trial.errors.length === 0) return out.warnings.push(...trial.warnings);
    }
  }
  walk(rules, value, candidates[0].rp, at, out, blankAbsent);
}

function run(rules, json, blankAbsent) {
  const out = { errors: [], warnings: [] };
  walk(rules, json, '', '', out, new Set(blankAbsent));
  return out;
}

export function validateProject(json) {
  const out = run(PROJECT_RULES, json, ['fixPrompts']);
  // Cross-reference the schema can't express: a matcher's `jira` must name a site under `jira`.
  if (isObject(json) && Array.isArray(json.tickets)) {
    const sites = isObject(json.jira) ? json.jira : {};
    json.tickets.forEach((m, i) => {
      if (isObject(m) && typeof m.jira === 'string' && !Object.hasOwn(sites, m.jira)) {
        const path = `tickets[${i}].jira`;
        out.errors.push({ path, message: `${code(path)} names no site under ${code('jira')}: ${code(m.jira)}` });
      }
    });
  }
  return out;
}

export function validateConfig(json) {
  return run(CONFIG_RULES, json, ['fixNotes']);
}
