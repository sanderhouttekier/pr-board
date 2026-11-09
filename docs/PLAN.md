# PR board: plan

The plan to turn the single-project board into the generic board in `docs/SPEC.md`. Section names in quotes point to the SPEC. The old plan (tasks 1 to 10, the single-project board) is done and lives in git history.

## How to run this plan

- **Branch.** All code groups commit to one branch, `feat/generic-board`, in a worktree of this repo. `main` keeps serving the live board and is never touched. Git is the handover: a worker starts from the branch tip, reads the commits of the groups it depends on, and leaves one commit or more with a message like `feat(config): personal config and project file loader`. No worker merges, rebases or pushes. There's no remote until group 12.
- **Test-first, always.** Red, green, refactor: write the failing test, watch it fail for the right reason, make it pass, then clean up. That holds for every behaviour change, and every worker brief says so. Sources are tested against fixtures in `test/fixtures/` through an injected `http`. OS code is tested through an injected `platform`, `env`, `homedir` and fake `execFile`. `npm test` makes no live call and spawns no OS tool.
- **Fixtures are made up.** They use the names from `projects/example.json` (owner `acme-corp`, workspace `acme`, repos `acme-*`, people like `ada`/`Ada Example`, cloud id `00000000-0000-4000-8000-000000000000`), keeping the shape of real responses. Never record a new fixture from a customer repo. Shape questions are settled by the GETs in group 4.
- **Rules from `CLAUDE.md` stay:** GET-only upstream through `src/http.js`; tokens only in `src/secrets.js`; `src/derive.js` pure; no npm dependencies, no build step; bind to `127.0.0.1`.
- **Each group ends** with `npm test` green, `filemap.md` updated for the files it added or moved, and a short note in its commit body of anything the next group must know.
- **Tiers** are savvy-flow worker tiers: light, medium, careful, heavy.

## Groups

| # | Group | Tier | After | Status |
|---|---|---|---|---|
| 1 | Made-up fixtures and the Ticket rename | medium | – | done |
| 2 | Config: dir, files, schemas, validator | careful | 1 | done |
| 3 | Secret provider chain | careful | 2 | done |
| 4 | Discovery, whitelist, aliases, descriptions | careful | 2 | done |
| 5 | Ticket matchers | medium | 2 | done |
| 6 | Shared package check on both hosts | heavy | 4, 5 | done |
| 7 | Multi-project collector, tiered polling, server | heavy | 3, 4, 5 | done |
| 8 | Fix prompt layering | medium | 6 | done |
| 9 | Page: picker, banners, Ticket groups | careful | 7, 8 | done |
| 10 | Cross-platform installer | medium | 2, 3 | done |
| 11 | Repo hygiene, CI and docs | light | 1–10 | done |
| 12 | Scrub, publish, parity, cutover | light (mostly human) | 11 | done |

Parallel lanes:
- after 2: groups 3, 4 and 5 touch separate files and can run at the same time;
- after 3: group 10 can run next to 6 to 9.

Two workers never edit the same file at once. When two lanes both have to touch `test/fixtures/`, each adds files and neither edits the other's.

---

## 1. Made-up fixtures and the Ticket rename

**Goal.** Remove customer data from the tests, and rename "feature" to "Ticket" before any real change, so later groups start clean. No behaviour changes except names.

**Files.**
- `test/fixtures/**` (rename files and rewrite values);
- `test/*.test.js`;
- `src/derive.js`, `src/collector.js`;
- `public/view.js`, `public/app.js`, `public/style.css` (class names, if any).

**Steps.**
1. Fixtures: rewrite every fixture to the made-up names (owners, workspaces, repo names, branch names, people, URLs, PR titles and Ticket prefixes `SHOP`/`OPS`). Keep the structure and every field the code reads. Rename the files to the made-up repo names, and update `index.json` / `routes.json`. Fix the tests' expectations accordingly. This is red then green: tests fail after the fixture change and pass after the expectation update, with no `src/` change.
2. Rename, test-first (red: change the tests to the new names, so they fail for the missing exports and fields; green: rename in code):
   - `featureKey` → `ticketKey`, `groupByFeature` → `groupByTicket`;
   - snapshot `features` → `tickets`;
   - group kind `feature` → `ticket`;
   - "By feature" → "By ticket";
   - the `localStorage` view value `feature` → `ticket` (an old stored value falls back to the default view).

   Keep the hardcoded key regex for now, but with the made-up prefixes added. Group 5 replaces it.
3. Refactor: grep `src/ public/ test/` for `feature` (case-insensitive). Only git branch names like `feature/…` may remain.

**Done when** `npm test` is green and the deny-list grep from the private cutover doc returns nothing in `test/`, `src/` and `public/`, apart from the hardcoded config defaults in `src/config.js`, which group 2 removes.

---

## 2. Config: dir, files, schemas, validator

**Goal.** Load the personal config and the project files from the config dir, validate them against the two JSON Schemas with a hand-written validator, and isolate errors per project. SPEC "Config".

**Files.**
- new `src/configdir.js`, `src/validate.js`;
- rewritten `src/config.js`;
- new `config.schema.json`, `projects/project.schema.json`, `projects/example.json`, `config.example.json`;
- `test/configdir.test.js`, `test/validate.test.js`, `test/config.test.js`, `test/fixtures/config/` (broken and valid files);
- delete `config.local.example.json`.

**Steps.**
1. `configDir({ env, platform, homedir })`:
   - red: table tests for `PR_BOARD_CONFIG_DIR` (absolute, relative), Windows `APPDATA` (set, unset), `XDG_CONFIG_HOME` (absolute, relative, empty), and the macOS and Linux defaults;
   - green: implement it, then `ensureConfigDir(dir, { fs })` with mode `0700`.
2. Schemas: write both files exactly as in SPEC "JSON Schemas".
3. Validator:
   - red: a schema-sync test that reads both schema files and asserts the validator's rule table has the same paths, types, `required`, patterns, `const`, enums and `additionalProperties` behaviour; and a test that the `fixPrompts` keys equal `FIXABLE_KINDS` plus `group` (import `public/fix-prompt.js`);
   - green: `validateProject(json)` and `validateConfig(json)` return `{ errors: [{ path, message }], warnings: [...] }`.
   - Red, then green, per row of SPEC "Validation": an unknown key is a warning; a wrong type or missing required key is an error; a matcher with both `prefix` and `link`; a matcher naming an unknown Jira site; `kind` other than composer; an empty `fixPrompts` string is absent; a missing `email` on an Atlassian credential.
4. Loader, `loadBoard({ dir, fs, env })` → `{ settings, warnings, error, projects: [{ id, title, file, ok, error, warnings, project, credentials }] }`:
   - red: tests with fixture dirs: no `config.json` (empty board); broken top-level JSON (board error, no projects); one broken and one good project (the good one loads); relative `file` paths; default values; credentials merged per host (an override wins); `PORT` env;
   - green: implement.
5. Refactor: `src/server.js` uses `loadBoard`. Until group 7 lands, run only the first OK project through the existing collector, so `npm start` keeps working.

**Done when** `projects/example.json` and `config.example.json` validate with no warnings, and the schema-sync test fails when you change one schema file by hand.

---

## 3. Secret provider chain

**Goal.** Resolve a credential per host and token reference through the OS store, a derived env var and the global GitHub fallbacks, on three OSes, with no token ever leaving `src/secrets.js`. SPEC "Secrets".

**Files.**
- rewritten `src/secrets.js`;
- new `src/winCred.ps1.js` (the PowerShell script as a string, encoded at run time);
- `test/secrets.test.js`.

**Steps.**
1. `envName(ref)`: red, then green (`acme-bitbucket` → `ACME_BITBUCKET`, dots, spaces, digits).
2. Providers per platform, with an injected `execFile` and `platform`. Red, then green, per case:
   - macOS `security` args, exit 44 → miss, timeout set;
   - Linux `secret-tool lookup service R`, exit 1 and ENOENT → miss, timeout;
   - Windows: `powershell.exe` args, `-EncodedCommand` is UTF-16LE base64, `windowsHide`, one call for all references, JSON stdout parsed, `pwsh` fallback on ENOENT, and the UTF-16LE/UTF-8 blob decoding (test the decode as a pure function).
3. The chain, `createSecrets({ execFile, env, platform, settings })` → `auth(host, credential)`, which returns a header value. Red, then green:
   - store hit;
   - store miss then env hit;
   - the global GitHub path (`GH_TOKEN`, `GITHUB_TOKEN`, `gh auth token`);
   - an override miss never calls `gh` and never reads `GH_TOKEN`;
   - an Atlassian Basic header built from the config `email`;
   - a missing email gives its own error;
   - a "no token" error lists the sources tried in order, never with a value (assert the token string doesn't appear in any error);
   - `PR_BOARD_AUTOSTARTED=1` adds the shell-profile sentence;
   - the cache per `(host, ref)` is dropped on failure, so the next call retries;
   - a child's error message containing a fake token never surfaces.
4. `resolvable(host, credential, { autostart: true })` for the installer: the store, plus `gh` for the global GitHub only, never env vars. Red, then green.
5. Refactor: drop the `acct` parsing.

**Done when** every case above has a test, and `grep -n "console\|log(" src/secrets.js` shows nothing that could print a value.

---

## 4. Discovery, whitelist, aliases, descriptions

**Goal.** Repos per project and host come from discovery or the whitelist, with aliases, the Bitbucket cap, the default branch, and PR descriptions. SPEC "Repos" and "Source rules".

**Before coding (human in the loop).** Run the five settling GETs from the research once, with the user's tokens and the user's OK. Run them through a throwaway script in the scratchpad that uses `src/secrets.js` and `src/http.js` and prints only the status, header names and the JSON key paths, never values or tokens:
1. `GET /orgs/{org}/repos?per_page=100&type=sources` with a fine-grained PAT: does it list exactly the selected repos?
2. `GET /user` with the `gh` token: the `X-OAuth-Scopes` header.
3. `GET /search/issues?q=is:pr+is:open+archived:false+org:{org}&per_page=1`: informational only, not used in v1.
4. `GET /2.0/repositories/{ws}?pagelen=100&fields=values.slug,values.parent.full_name,values.updated_on,values.mainbranch.name,next`: does it work with an API token that has `read:repository:bitbucket`?
5. `GET /2.0/repositories/{ws}/{repo}/pullrequests?state=OPEN&pagelen=1&fields=values.id,values.description,values.summary.raw`: is `description` there?

Write the answers into the group's first commit body. Hand-write made-up fixtures in those shapes.

**Files.**
- new `src/discover.js`;
- `src/sources/github.js`, `src/sources/bitbucket.js`, `src/sources/jira.js`;
- `test/discover.test.js`, `test/github.test.js`, `test/bitbucket.test.js`, `test/jira.test.js`, new fixtures.

**Steps.**
1. `discoverGithub` / `discoverBitbucket({ http, auth, owner })`. Red, then green:
   - pagination;
   - forks, archived and disabled repos dropped;
   - the GitHub user-owner fallback on a 404;
   - `default_branch` / `mainbranch.name` kept;
   - Bitbucket sorted by `-updated_on`.
2. `repoSet(discovered, project, host)` (pure). Red, then green:
   - whitelist order;
   - a whitelist miss gives a warning;
   - no whitelist → all discovered;
   - the Bitbucket cap of 40 with the exact warning text from the SPEC;
   - no cap on GitHub;
   - aliases → `repoShort`;
   - `host:name` references;
   - an ambiguous plain reference gives a warning;
   - `repoUrl` per host.
3. Discovery cache: at most once an hour per project and host, with an injected `now`. Red, then green.
4. Sources take `{ project, repos, http, auth, cache, now, log, me }` instead of the global config. Red: the existing source tests, moved to the new arguments. Green: drop `config.github.owner` and `config.bitbucket.workspace`. Every normalized PR gains `owner`, `defaultBranch` and `description` (GitHub `body`; Bitbucket `description`, else `summary.raw`, per settling GET 5).
5. Jira: `collectJira(keysBySite, { sites, http, auth, cache, now })` with the cloud id per site and URLs from the `browse` templates. Red: two sites, a 404, a null `browse`. Green.

**Done when** no source reads a hardcoded owner, workspace or Jira URL.

---

## 5. Ticket matchers

**Goal.** Ticket keys come from the project's matchers, and the hardcoded key regex is gone. SPEC "Tickets".

**Files.** `src/derive.js`, `test/derive.test.js`.

**Steps.**
1. `ticketKey(pr, matchers)` → `{ key, label, url, jiraSite } | null`. Red, then green, as table tests:
   - `SHOP-42`, `SHOP 42`, `shop_42` and `SHOP42` in a branch all give `SHOP-42`;
   - a boundary: `xSHOP-42` doesn't match, `feat/shop_42` does;
   - the branch wins over the title;
   - leftmost across prefixes;
   - `#42` and `42` never match;
   - a link matcher on the description: the key URL, `#95` from `95-name`, the id segment as the label without digits;
   - a prefix beats a link;
   - `browse` null → `url` null;
   - `{key}` substitution.
2. `enrich(prs, ctx)` with `ctx.matchers`: red (`ticketKey` on enriched PRs, and the description absent from the output), green.
3. `ticketsFor(prs)` builds the `tickets` map skeleton (`label`, `url`) that Jira fills in. Red, then green.
4. Refactor: remove `KEY_RE`, and widen "main branch" to include `defaultBranch` (red: a stacked test where the target is a non-standard default branch).

**Done when** `derive.js` holds no prefix and still has no I/O and no clock.

---

## 6. Shared package check on both hosts

**Goal.** Lock signals derived from `sharedPackages`, for consumers and shared package repos on either host. SPEC "Shared package check".

**Files.**
- new `src/sharedPackages.js` (host-agnostic orchestration over two small host readers);
- `src/sources/github.js`, `src/sources/bitbucket.js` (readers: file at sha, merged PRs, commits the lock lacks, PR by source branch);
- `src/derive.js` (lock signals from `locks`);
- `test/sharedPackages.test.js` and fixtures.

**Steps.**
1. Readers per host, red then green against fixtures:
   - GitHub contents API raw (`composer.json`, `composer.lock` at sha);
   - GitHub merged PRs in the window plus compare;
   - Bitbucket as today, with the default branch from discovery instead of `develop`.
2. `lockInfo(pr, entry, readers)`. Red, then green:
   - the constraint `dev-develop` against a default `main` (pinned);
   - pinned with the PR open, merged or missing;
   - missing PRs with the same Ticket key only;
   - a lock ref that already contains the merge;
   - a failed read → null, not cached;
   - a consumer on Bitbucket with the shared package on GitHub;
   - two entries consumed by one repo → two `locks`.
3. Signals in `derive.js` from `locks`, with labels from the shared package's short name. Red (labels from the SPEC table, one set per entry), then green.
4. Refactor: remove `config.pkg` and every hardcoded package name.

**Done when** the example project's `acme-backend` PR shows "lock bump due: shared #7" from fixtures.

---

## 7. Multi-project collector, tiered polling, server

**Goal.** One collector per project with viewed, hourly and paused rates, isolated project errors, per-credential identities, and the new routes. SPEC "Collector and polling" and "Server".

**Files.** `src/collector.js`, new `src/board.js` (owns the collectors, open/closed state and touches), `src/server.js`, `test/collector.test.js`, new `test/board.test.js`, `test/server.test.js`.

**Steps.**
1. `createCollector({ project, settings, secrets, http, sources, now, timers, log })`. Red, then green:
   - the existing collector tests moved to the per-project arguments;
   - credentials resolved per host from the project;
   - identity per `(host, ref)`;
   - log lines prefixed with the id;
   - a project with an error never runs a round and reports its error in the snapshot.
2. `createBoard({ projects, settings, … })` with fake timers. Red, then green, per row of the rates table:
   - viewed → `intervalSec`;
   - open but not viewed → `idleIntervalSec`;
   - closed → ticks skip rounds, with no auth call;
   - one log line on close and one on open;
   - a snapshot touch of a project that's stale or has no data → an immediate round;
   - the first request after closing → a round for each project older than `idleIntervalSec` or without data;
   - closed at start;
   - the 15 s follow-up only for viewed projects;
   - no overlapping rounds per project.
3. `projectSummary` for tabs: count = mine, not release, with an attention signal; `ageMin`; rate; error; warnings. Red, then green.
4. Server routes from the SPEC table. Red, then green:
   - `/` redirect;
   - `/p/<id>` serves `index.html`;
   - `/api/projects` marks open but not viewed;
   - `/api/p/<id>/snapshot` marks viewed;
   - `POST /api/p/<id>/refresh` returns 202;
   - an unknown id → 404 JSON on API routes;
   - the old `/api/snapshot` and `/api/refresh` → 404;
   - the Host/Origin guard still holds.
5. Snapshot shape per SPEC: `project`, `rate`, `tickets`, `fix`, `rateLimit`, no `description`. Red, then green.

**Done when** `npm start` with `config.example.json` and stubbed sources serves two tabs, and the existing guard tests are green.

---

## 8. Fix prompt layering

**Goal.** Host-generic defaults, project conventions, fix notes and the derived "Fix all" order, with no project names in `public/fix-prompt.js`. SPEC "Fix prompts".

**Files.** `public/fix-prompt.js`, `test/fix-prompt.test.js`.

**Steps.**
1. Red: write the two canonical examples from the SPEC as golden tests (exact strings), built from PRs run through `derive.enrich` with the example project. They fail on today's output.
2. Green, per kind, with a test each: the default text from the SPEC table, the GitHub vs Bitbucket CI text, and the host label from the owner or workspace.
3. Red, then green:
   - a `Project convention:` line under the right step only;
   - an empty or whitespace convention → no line;
   - an unknown key ignored here (the warning comes from the validator);
   - `My setup:` with `all` first and then the hosts present only;
   - no notes → no paragraph;
   - the bundle order: shared package repos, then consumers, then the rest, keeping board order within a tier;
   - the ordering line with and without shared packages;
   - `fixPrompts.group` after the ordering line;
   - the fixed closing text.
4. Refactor: remove `PKG_REPO`, `LOCKING_REPOS` and every owner or workspace string. `promptFor(pr, ctx)` and `bundlePrompt(prs, label, ctx)` take `ctx` = the snapshot's `fix`.

**Done when** the golden tests pass and `fix-prompt.js` has no imports and no project names.

---

## 9. Page: picker, banners, Ticket groups

**Goal.** The page serves several projects: tabs with counts and age, per-project URLs, project error and warning banners, Ticket group headers, and fix prompts built with the project's `ctx`. SPEC "Page".

**Files.** `public/view.js`, `public/app.js`, `public/index.html`, `public/style.css`, `test/view.test.js`.

**Steps.**
1. Red, then green in `view.js`, which stays pure:
   - tabs only with two or more projects;
   - `Title (N)` with N hidden at 0;
   - `· 40 min` only on the hourly rate;
   - the error mark;
   - `aria-current`;
   - the header title and "every 5 min" / "hourly";
   - the project error replacing the content;
   - the warnings list;
   - a Ticket header with label, link, and Jira status only for Jira matchers;
   - fix drawers calling `promptFor(pr, snapshot.fix)`.
2. `app.js`: read the id from `location.pathname`, poll `/api/p/<id>/snapshot` and `/api/projects` (30 s, 3 s while refreshing, paused while hidden), and send refresh to the project route. The browser glue has no unit test; verify it in the browser.
3. Verify in the browser against `config.example.json` with stubbed sources (`npm start` and a fixture-backed source flag, or the dev stub group 7 left behind). Check light and dark, and below 900 px and 560 px.

**Done when** the view tests are green and the worker has checked two tabs in the browser and reported a screenshot.

---

## 10. Cross-platform installer

**Goal.** `node scripts/install.js` with `--print`, `--uninstall` and `--url` on macOS, Linux (systemd, and the XDG autostart fallback) and Windows, applying the refusal rule. SPEC "Autostart".

**Files.**
- new `scripts/install.js` (thin CLI);
- new `src/install.js` (pure renderers and the plan of OS commands);
- `test/install.test.js`;
- delete `scripts/install-launchd.sh`, `scripts/uninstall-launchd.sh` and `test/launchd.test.js`.

**Steps.**
1. Renderers. Red, then green, as snapshot-style string tests:
   - plist (label, `execPath`, `KeepAlive`, `ThrottleInterval`, log path, env with `PR_BOARD_CONFIG_DIR`, `PR_BOARD_AUTOSTARTED`, `PATH` including the dir of `gh`, and XML escaping);
   - the systemd unit;
   - the `.desktop` file;
   - the task XML (`LogonTrigger`, `RestartOnFailure`, `ExecutionTimeLimit` PT0S, battery false).

   No secret in any of them: a test asserts the rendered text contains no value from a fake token.
2. The command plan per platform, given an injected `platform`, `execFile` and `fs`. Red, then green: the exact `launchctl`, `systemctl --user` and `schtasks` calls for install and `--uninstall`; systemd detection; `--print` runs nothing.
3. The refusal rule. Red, then green:
   - a broken project → refuse;
   - an Atlassian credential with no store entry → refuse, printing the reference and this OS's store command;
   - a missing email → refuse;
   - the global GitHub resolved by `gh` → OK;
   - an env-var-only token → refuse;
   - no `--force` flag exists;
   - `--print` doesn't check.
4. Verify on macOS: install, `curl http://127.0.0.1:7419/api/projects`, uninstall, install again. Linux and Windows stay untested.

**Done when** the tests are green on macOS, and the old shell scripts are gone.

---

## 11. Repo hygiene, CI and docs

**Goal.** The tree is ready to publish: generic rules, README, licence, CI and package metadata.

**Files.**
- `CLAUDE.md`: generic rules. Drop the Jira host rule (links come from `browse`), and rewrite the secrets rule as "OS store, env var or `gh auth token`, through `src/secrets.js` only".
- `README.md` (outline below);
- `filemap.md`;
- `LICENSE`;
- `package.json`: `"name": "pr-board"`, `"license": "MIT"`, and drop `private`;
- `.gitattributes`;
- `.github/workflows/test.yml`;
- `.gitignore`;
- `GLOSSARY.md` stays.

**Steps.**
1. The CI workflow from SPEC "CI". It can't run before group 12, so check it by hand: valid YAML, Node 22, the three OSes, `contents: read`.
2. Write the README from the outline. Every command in it must match the code.
3. Run `npm test` and the scrub grep from group 12 step 1. Fix what it finds in the tree.

**README outline.**
1. **PR board**: what it shows, read-only, local only, and a screenshot made with the example project.
2. **Requirements**: Node 22; macOS tested; Linux and Windows "untested, help welcome".
3. **Quick start**: clone, then create the config dir (path per OS), then copy `config.example.json` to `config.json` and `projects/example.json` to `projects/<yours>.json`, then edit, then `npm start`, then open `/`.
4. **Project file**: a key table (`hosts`, `repos`, `aliases`, `tickets`, `jira`, `sharedPackages`, `fixPrompts`), with `$schema` for autocomplete.
5. **Personal config**: a key table, credentials, credential overrides, `fixNotes` (put your tooling in your own agent instructions first, and use `fixNotes` only as a fallback).
6. **Tokens**:
   - the chain;
   - store commands per OS;
   - derived env var names;
   - scopes per host: a GitHub fine-grained PAT (contents, pull requests, actions, metadata), and Bitbucket `read:repository`, `read:pullrequest`, `read:pipeline` and `read:user`, plus Jira `read:jira-work`;
   - `gh`'s plain-text fallback;
   - WSL is headless Linux.
7. **Repos and the Bitbucket rate limit**: discovery, whitelist, aliases, the cap of 40 and its warning.
8. **Fix prompts**: a table of key, when the signal fires, and what the default already says; conventions append, never replace.
9. **Run at login**: `node scripts/install.js` and its flags, the refusal rule, logs per OS, and restarting after a config change.
10. **How it refreshes**: viewed every 5 min, others hourly while a page is open, nothing when closed.
11. **What the page shows**: tabs, attention chips, by Ticket and by repo, signals, and ready.
12. **Troubleshooting**: "no token" errors, 401s, the Bitbucket 429 and cap, unknown mergeable, config errors per tab.
13. **Development**: `CLAUDE.md`, `docs/SPEC.md`, `filemap.md`, `npm test`.

**Done when** the tree passes the scrub grep and `npm test`, and the README matches the code.

---

## 12. Scrub, publish, parity, cutover

**Goal.** The generic board is public as `pr-board` and replaces the live board. SPEC "Migration from the single-project board". The real project file, references, deny list and commands are in the author's private cutover doc, which isn't in this repo.

**Steps** (the user runs or approves each one; a light worker can prepare commands and check output):
1. **Scrub**: grep every tracked file on `feat/generic-board` (`git grep -niE` with the deny list from the private doc). It must return nothing. Also check `git ls-files` for anything unexpected, such as `.scratch/` or `config.json`.
2. **Publish**: create the public repo `pr-board` on the user's personal GitHub, then commit the tracked tree as one squashed commit (for example, `git archive` into a fresh `git init`) and push. This is a public, irreversible step: ask first. After the push, CI must be green on all three OSes, and a red Windows or Linux job is fixed in `pr-board` itself.
3. **Parity**: clone `pr-board`, write `config.json` and the real project file into the config dir from the private doc, and run `PORT=7420 npm start` next to the live board on 7419. Compare the PRs, groups and signals. Each difference is either fixed in `pr-board` (test-first) or explained in the private doc.
4. **Cutover**: run the old repo's uninstall script, `node scripts/install.js` from the clone (port 7419), and check that the board reloads after a login. The old repo becomes a frozen archive.

**Done when** the board on 7419 runs from the `pr-board` clone under the new label and the old agent is gone.
