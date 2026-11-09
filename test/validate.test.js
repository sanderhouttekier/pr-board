import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROJECT_RULES, CONFIG_RULES, validateProject, validateConfig } from '../src/validate.js';
import { FIXABLE_KINDS } from '../public/fix-prompt.js';

const readJson = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8'));
const PROJECT_SCHEMA = readJson('projects/project.schema.json');
const CONFIG_SCHEMA = readJson('config.schema.json');

// --- Schema sync -----------------------------------------------------------------------------
// Flattens a JSON Schema into the validator's rule-table notation: one entry per path, with
// `.name` for properties, `.*` for additionalProperties schemas, `[]` for items and `#i` for
// oneOf variants. `$ref`s are inlined. Any keyword this notation doesn't know fails the test,
// so a schema change can't slip past the rule table.
const KEPT = ['type', 'required', 'pattern', 'const', 'enum', 'minimum', 'maximum', 'minLength', 'minItems', 'minProperties', 'uniqueItems'];

function flatten(schema) {
  const out = {};
  const resolve = (node) => {
    while (node.$ref) {
      assert.equal(Object.keys(node).length, 1, `$ref with siblings: ${JSON.stringify(node)}`);
      assert.match(node.$ref, /^#\/\$defs\//);
      node = schema.$defs[node.$ref.slice('#/$defs/'.length)];
      assert.ok(node, 'unresolved $ref');
    }
    return node;
  };
  const join = (p, k) => (p === '' ? k : `${p}.${k}`);
  function walk(node, p) {
    node = resolve(node);
    const rule = {};
    for (const [k, v] of Object.entries(node)) {
      if (KEPT.includes(k)) rule[k] = v;
      else if (p === '' && ['$schema', '$id', 'title', '$defs'].includes(k)) continue;
      else if (k === 'additionalProperties') {
        if (v === false) rule.closed = true;
        else walk(v, join(p, '*'));
      } else if (k === 'propertyNames') {
        const names = resolve(v);
        assert.deepEqual(Object.keys(names).filter((x) => x !== 'type'), ['pattern'], `propertyNames at ${p}`);
        rule.keys = names.pattern;
      } else if (k === 'properties') {
        for (const [name, sub] of Object.entries(v)) walk(sub, join(p, name));
      } else if (k === 'items') walk(v, `${p}[]`);
      else if (k === 'oneOf') {
        rule.oneOf = v.length;
        v.forEach((sub, i) => walk(sub, `${p}#${i}`));
      } else assert.fail(`schema keyword the rule table can't express: ${k} at ${p || '(root)'}`);
    }
    out[p] = rule;
  }
  walk(schema, '');
  return out;
}

function assertInSync(rules, schema, name) {
  const flat = flatten(schema);
  for (const p of new Set([...Object.keys(flat), ...Object.keys(rules)])) {
    assert.ok(p in rules, `${name}: rule table lacks path \`${p}\``);
    assert.ok(p in flat, `${name}: rule table has path \`${p}\` the schema doesn't`);
    assert.deepEqual(rules[p], flat[p], `${name}: rule for \`${p}\` differs from the schema`);
  }
}

test('schema sync: the project rule table matches projects/project.schema.json path by path', () => {
  assertInSync(PROJECT_RULES, PROJECT_SCHEMA, 'project');
});

test('schema sync: the config rule table matches config.schema.json path by path', () => {
  assertInSync(CONFIG_RULES, CONFIG_SCHEMA, 'config');
});

test('schema sync: fixPrompts keys are FIXABLE_KINDS plus group', () => {
  assert.deepEqual(
    Object.keys(PROJECT_SCHEMA.properties.fixPrompts.properties).sort(),
    [...FIXABLE_KINDS, 'group'].sort(),
  );
});

// --- Shipped examples ------------------------------------------------------------------------

test('projects/example.json validates with no errors and no warnings', () => {
  assert.deepEqual(validateProject(readJson('projects/example.json')), { errors: [], warnings: [] });
});

test('config.example.json validates with no errors and no warnings', () => {
  assert.deepEqual(validateConfig(readJson('config.example.json')), { errors: [], warnings: [] });
});

// --- Rows of SPEC "Validation" -------------------------------------------------------------

const project = (extra = {}) => ({ hosts: { bitbucket: { workspace: 'acme' } }, ...extra });
const paths = (list) => list.map((e) => e.path);

test('unknown key: a warning in the SPEC wording, never an error', () => {
  const r = validateProject(project({ fixPrompts: { 'lock-mising': 'x' } }));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, [{ path: 'fixPrompts.lock-mising', message: 'Unknown key `fixPrompts.lock-mising`, ignored' }]);
});

test('unknown key: at the top level and nested, in both files', () => {
  assert.deepEqual(paths(validateProject(project({ colour: 'red' })).warnings), ['colour']);
  const r = validateProject({ hosts: { bitbucket: { workspace: 'acme', team: 'x' } } });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(paths(r.warnings), ['hosts.bitbucket.team']);
  const c = validateConfig({ prot: 7419, credentials: { github: { ref: '', email: 'a@b.c' } } });
  assert.deepEqual(c.errors, []);
  assert.deepEqual(paths(c.warnings), ['prot', 'credentials.github.email']);
});

test('wrong type: an error with the JSON path', () => {
  const r = validateProject(project({ title: 5 }));
  assert.deepEqual(r.errors, [{ path: 'title', message: '`title` must be a string, got number' }]);
  assert.deepEqual(paths(validateProject({ hosts: [] }).errors), ['hosts']);
  assert.deepEqual(paths(validateConfig({ port: '7419' }).errors), ['port']);
  assert.deepEqual(paths(validateConfig({ port: 7419.5 }).errors), ['port']);
  assert.deepEqual(paths(validateConfig({ projects: [] }).errors), ['projects']);
});

test('wrong type at the root of either file', () => {
  assert.deepEqual(validateProject([]).errors, [{ path: '', message: 'The file must hold an object, got array' }]);
  assert.deepEqual(paths(validateConfig('x').errors), ['']);
  assert.deepEqual(paths(validateConfig(null).errors), ['']);
});

test('missing required key: hosts, owner, workspace, file', () => {
  assert.deepEqual(validateProject({}).errors, [{ path: 'hosts', message: 'Missing required key `hosts`' }]);
  assert.deepEqual(paths(validateProject({ hosts: { github: {} } }).errors), ['hosts.github.owner']);
  assert.deepEqual(paths(validateProject({ hosts: { bitbucket: {} } }).errors), ['hosts.bitbucket.workspace']);
  assert.deepEqual(paths(validateConfig({ projects: { acme: {} } }).errors), ['projects.acme.file']);
});

test('hosts needs at least one known host', () => {
  assert.deepEqual(paths(validateProject({ hosts: {} }).errors), ['hosts']);
  const r = validateProject({ hosts: { gitlab: { group: 'acme' } } });
  assert.deepEqual(paths(r.errors), ['hosts']);
  assert.deepEqual(paths(r.warnings), ['hosts.gitlab']);
});

test('patterns, ranges, lengths, uniqueness', () => {
  assert.deepEqual(paths(validateProject({ hosts: { github: { owner: 'acme corp' } } }).errors), ['hosts.github.owner']);
  assert.deepEqual(paths(validateConfig({ port: 70000, intervalSec: 10, ghPath: '' }).errors), ['port', 'intervalSec', 'ghPath']);
  assert.deepEqual(paths(validateConfig({ port: 0 }).errors), ['port']);
  assert.deepEqual(paths(validateProject(project({ repos: { bitbucket: ['acme-web', 'acme-web'] } })).errors), ['repos.bitbucket']);
  assert.deepEqual(paths(validateProject(project({ repos: { bitbucket: ['acme web'] } })).errors), ['repos.bitbucket[0]']);
  assert.deepEqual(paths(validateProject(project({ jira: { main: { cloudId: 'nope' } } })).errors), ['jira.main.cloudId']);
  assert.deepEqual(paths(validateProject(project({ title: '' })).errors), ['title']);
});

test('property names: aliases, jira sites and project ids', () => {
  assert.deepEqual(paths(validateProject(project({ aliases: { 'gitlab:acme-web': 'web' } })).errors), ['aliases.gitlab:acme-web']);
  assert.deepEqual(validateProject(project({ aliases: { 'bitbucket:acme-web': 'web' } })).errors, []);
  assert.deepEqual(paths(validateProject(project({ aliases: { 'acme-web': 'w e b' } })).errors), ['aliases.acme-web']);
  assert.deepEqual(paths(validateProject(project({ jira: { 'm a i n': { cloudId: '00000000-0000-4000-8000-000000000000' } } })).errors), ['jira.m a i n']);
  assert.deepEqual(paths(validateConfig({ projects: { Acme: { file: 'a.json' } } }).errors), ['projects.Acme']);
});

test('ticket matcher: both prefix and link is an error', () => {
  const r = validateProject(project({ tickets: [{ prefix: 'SHOP', browse: null, link: 'trello.com/c/' }] }));
  assert.deepEqual(r.errors, [{ path: 'tickets[0]', message: '`tickets[0]` needs exactly one of `prefix` or `link`' }]);
});

test('ticket matcher: neither prefix nor link is an error', () => {
  assert.deepEqual(paths(validateProject(project({ tickets: [{ browse: null }] })).errors), ['tickets[0]']);
  assert.deepEqual(paths(validateProject(project({ tickets: ['SHOP'] })).errors), ['tickets[0]']);
});

test('ticket matcher: prefix rules (browse required, https with {key}, or null)', () => {
  assert.deepEqual(paths(validateProject(project({ tickets: [{ prefix: 'SHOP' }] })).errors), ['tickets[0].browse']);
  assert.deepEqual(paths(validateProject(project({ tickets: [{ prefix: 'SHOP', browse: 'http://x/{key}' }] })).errors), ['tickets[0].browse']);
  assert.deepEqual(paths(validateProject(project({ tickets: [{ prefix: 'SHOP', browse: 5 }] })).errors), ['tickets[0].browse']);
  assert.deepEqual(paths(validateProject(project({ tickets: [{ prefix: '1SHOP', browse: null }] })).errors), ['tickets[0].prefix']);
  assert.deepEqual(validateProject(project({ tickets: [{ prefix: 'OPS', browse: null }, { link: 'trello.com/c/' }] })), { errors: [], warnings: [] });
  assert.deepEqual(paths(validateProject(project({ tickets: [{ link: 'trello.com/c' }] })).errors), ['tickets[0].link']);
});

test('ticket matcher: jira naming a site that is not under jira is an error', () => {
  const matcher = { prefix: 'SHOP', browse: null, jira: 'main' };
  const none = validateProject(project({ tickets: [matcher] }));
  assert.deepEqual(none.errors, [{ path: 'tickets[0].jira', message: '`tickets[0].jira` names no site under `jira`: `main`' }]);
  const other = validateProject(project({ tickets: [matcher], jira: { other: { cloudId: '00000000-0000-4000-8000-000000000000' } } }));
  assert.deepEqual(paths(other.errors), ['tickets[0].jira']);
  const ok = validateProject(project({ tickets: [matcher], jira: { main: { cloudId: '00000000-0000-4000-8000-000000000000' } } }));
  assert.deepEqual(ok.errors, []);
});

test('shared package: kind other than composer is an error', () => {
  const pkg = { repo: 'acme-shared', kind: 'npm', package: 'acme/shared', consumers: ['acme-backend'] };
  const r = validateProject(project({ sharedPackages: [pkg] }));
  assert.deepEqual(r.errors, [{ path: 'sharedPackages[0].kind', message: '`sharedPackages[0].kind` must be `composer`' }]);
  assert.deepEqual(paths(validateProject(project({ sharedPackages: [{ ...pkg, kind: 'composer', consumers: [] }] })).errors), ['sharedPackages[0].consumers']);
  assert.deepEqual(paths(validateProject(project({ sharedPackages: [{ repo: 'acme-shared' }] })).errors),
    ['sharedPackages[0].kind', 'sharedPackages[0].package', 'sharedPackages[0].consumers']);
});

test('empty or whitespace fixPrompts / fixNotes values are absent: no error, no warning', () => {
  assert.deepEqual(validateProject(project({ fixPrompts: { conflict: '', group: '   \n' } })), { errors: [], warnings: [] });
  assert.deepEqual(validateProject(project({ fixPrompts: { 'lock-mising': '  ' } })), { errors: [], warnings: [] });
  assert.deepEqual(validateConfig({ fixNotes: { all: '', github: ' ', typo: '' } }), { errors: [], warnings: [] });
  assert.deepEqual(paths(validateProject(project({ fixPrompts: { conflict: 5 } })).errors), ['fixPrompts.conflict']);
});

test('Atlassian credential without email is an error, globally and per project', () => {
  assert.deepEqual(validateConfig({ credentials: { bitbucket: { ref: 'pr-board-bitbucket' } } }).errors,
    [{ path: 'credentials.bitbucket.email', message: 'Missing required key `credentials.bitbucket.email`' }]);
  assert.deepEqual(paths(validateConfig({ projects: { acme: { file: 'a.json', credentials: { jira: { ref: 'x' } } } } }).errors),
    ['projects.acme.credentials.jira.email']);
  assert.deepEqual(paths(validateConfig({ credentials: { jira: { ref: '', email: 'you@example.com' } } }).errors), ['credentials.jira.ref']);
  assert.deepEqual(paths(validateConfig({ credentials: { jira: { ref: 'x', email: 'not-an-email' } } }).errors), ['credentials.jira.email']);
  assert.deepEqual(validateConfig({ credentials: { github: { ref: '' } } }).errors, []);
});
