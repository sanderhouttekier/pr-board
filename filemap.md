# filemap

## Repo root and docs

- `README.md` — setup and operation for humans: quick start, project file, personal config, tokens and scopes, repos and the Bitbucket cap, fix prompts, run at login, refresh, page, troubleshooting
- `CLAUDE.md` — agent rules and commands
- `GLOSSARY.md` — domain terms (Board, Project, Ticket, Shared package, Token reference, …)
- `filemap.md` — this file: where things live
- `LICENSE` — MIT
- `package.json` — name `pr-board`, Node >= 22, `npm test` and `npm start`; no dependencies
- `.gitignore` — local-only paths (`.scratch/`, `.worktrees/`, a stray `config.json` / `config.local.json` at the root, logs)
- `.gitattributes` — `* text=auto eol=lf`
- `.github/workflows/test.yml` — CI: `npm test` on Ubuntu, macOS and Windows with Node 22, `contents: read`, no secrets
- `docs/SPEC.md` — config, secrets, sources, derived signals, polling, server, page, fix prompts, CI
- `docs/PLAN.md` — task groups and status
- `docs/screenshot.png` — the page over the dev stub's made-up `acme` project (README)

## Config

- `config.schema.json` — JSON Schema of the personal config
- `config.example.json` — sample personal config (copy to `<config dir>/config.json`); its `acme` project points at `projects/acme.json`
- `projects/project.schema.json` — JSON Schema of a project file
- `projects/example.json` — the made-up `acme` project file; tests and the README depend on it
- `src/configdir.js` — `configDir({ env, platform, homedir })` (SPEC "Config dir") and `ensureConfigDir` (mode 0700)
- `src/validate.js` — hand-written validator: rule tables mirroring both schemas, `validateProject` / `validateConfig` → `{ errors, warnings }`
- `src/config.js` — `loadBoard({ dir, fs, env })`: personal config + project files → settings, warnings, board error, per-project results with merged credentials; `DEFAULT_SETTINGS`; `describeError` / `describeWarning` (one-line strings for the snapshot, tabs and logs)

## Secrets and upstream

- `src/secrets.js` — token provider chain (SPEC "Secrets"): `createSecrets({ execFile, env, platform, settings })` → `auth(host, credential)` (header value) and `resolvable(host, credential, { autostart })` (installer); `createStore` per OS (Keychain, Secret Service, Credential Manager), `envName`, `decodeCredBlob`
- `src/winCred.ps1.js` — `WIN_CRED_SCRIPT` (PowerShell `CredReadW` reader, refs in via `PR_BOARD_CRED_REFS`, JSON out) and `encodePowerShell` (UTF-16LE base64 for `-EncodedCommand`)
- `src/http.js` — GET-only fetch with ETag cache and pagination
- `src/limit.js` — `mapLimit`: bounded concurrency helper for sources
- `src/discover.js` — repo discovery per host (`discoverGithub`, `discoverBitbucket`), `repoSet` (pure: whitelist, aliases, `host:name` refs, duplicate alias values, Bitbucket cap of 40, `repoUrl`), `resolveRepoRef`, `createDiscovery` (hourly cache per host and owner)
- `src/sources/github.js` — GitHub PRs of a project's repo set → normalized PRs (owner from the project, `defaultBranch`, `description` from `body`, `locks: []`); `githubLockReader` (the shared package check's GitHub reads: raw contents at a sha, branch head, merged PRs in the window, compare commits, PR by source branch)
- `src/sources/bitbucket.js` — Bitbucket PRs of a project's repo set → normalized PRs (workspace from the project, `defaultBranch`, `description` else `summary.raw`, `locks: []`); `bitbucketLockReader` (the shared package check's Bitbucket reads: `/src` at a sha, branch head, merged PRs in the window, commits the lock lacks, PR by source branch)
- `src/sources/jira.js` — `collectJira(keysBySite, { sites, … })`: Ticket key → Jira status/summary through the gateway per site, url from the `browse` template; `jiraSites(project)`
- `src/sharedPackages.js` — `createSharedPackageCheck({ http, readers? })` → `lockCheck(prs, { project, repos, auth, now, matchers, log })`: `locks` per PR from `sharedPackages` over the host lock readers, with its own caches

## Board and server

- `src/derive.js` — pure: Ticket keys (`ticketKey`, `ticketsFor`), `isMainBranch`, `lockPin`, signals (lock signals from `locks`, one set per entry), grouping, ready
- `src/collector.js` — one project's rounds (no timers): credentials per host from the loadBoard entry, discovery + repo sets, sources, the injected `lockCheck` (default `passThroughLocks`), Jira keys per site, `derive.enrich`, last good data, the project snapshot; `createIdentities` (viewer identity per `(host, ref)`, shared), `resolveSharedPackages` (`fix.sharedPackages`), `stamp` (log time)
- `src/board.js` — `createBoard`: a collector per project, open/viewed state, the rates table (viewed / hourly / paused ticks), touches, the 15 s follow-up, close/open log lines; `projectSummary` (tab data)
- `src/server.js` — HTTP server on 127.0.0.1 (port from config): `/` redirect, `/p/<id>` (index.html), `GET /api/projects`, `GET /api/p/<id>/snapshot`, `POST /api/p/<id>/refresh`, `GET /lib/derive.js`, static `public/`; 404 JSON on API routes; Host/Origin guard; `bootstrap` (config dir → `loadBoard` → `createBoard` with the shared package check)

## Page

- `public/index.html` — page shell: static title `Pull requests`, stylesheet, `app.js` module, `<main id="app">`
- `public/app.js` — browser glue: project id from `/p/<id>`, polls `/api/p/<id>/snapshot` and `/api/projects` together (30 s, 3 s while refreshing, paused while hidden), refresh via `POST /api/p/<id>/refresh`, snapshot 404 → unknown-project state, `document.title`, UI state (incl. open fix drawers, copy feedback), delegated clicks, clipboard copy of `vm.fixPrompts` with textarea fallback, `localStorage` key `pr-board:ui` for Mine/view
- `public/view.js` — pure, no imports: `createView(derive, fixPrompt)` → `viewModel(snapshot, ui, board)` (project tabs from `/api/projects`, header title and rate, project/board error, warnings, filters, Ticket groups with label/link/Jira status, branch/Other groups, collapse, repo rows, fix buttons/drawers, `fixPrompts` built with `snapshot.fix` as ctx), `stateModel(board, id)` (no projects, unknown project) and `render(vm)` (escaped HTML string, inline SVG icons)
- `public/fix-prompt.js` — pure, no imports, no project names: `FIXABLE_KINDS`, `fixableSignals`, `fixSeverity`, `promptFor(pr, ctx)` and `bundlePrompt(prs, groupLabel, ctx)` build the "Fix" clipboard prompt for blocked PRs from host-generic default steps, `ctx.fixPrompts` conventions, `ctx.fixNotes` ("My setup") and the "Fix all" order from `ctx.sharedPackages` (`ctx` = the snapshot's `fix`)
- `public/style.css` — tokens (light/dark), project tabs, layout, banners (incl. `.banner.error`), warnings list, cards, PR row grid, chips, narrow-screen rules

## Scripts

- `scripts/install.js` — thin CLI over `src/install.js` (`--print`, `--uninstall`, `--url`); wires the real platform, fs, `execFile`, env, homedir, uid
- `src/install.js` — autostart installer (SPEC "Autostart"): renderers (`renderPlist`, `renderSystemd`, `renderDesktop`, `renderTask`), `unitPath`/`unitEnv`, `findOnPath` (dir of `gh`), `unitTarget`, `planInstall`/`planUninstall` (OS tool calls as steps) and `applySteps`, the refusal rule (`refusals`, `storeCommand`), and `main(argv, deps)` with every OS dependency injected
- `scripts/dev-stub.js` — `PORT=7431 node scripts/dev-stub.js [--broken]`: the real server and board over two made-up projects (`acme` from `projects/example.json`, `nova`) with stub sources, secrets and http; `devStubBoard()` for the test

## Tests

node:test suites; no live calls and no OS tools.

- `test/configdir.test.js` — config dir table tests per OS, `ensureConfigDir`
- `test/validate.test.js` — schema-sync tests (rule tables vs both schema files, `fixPrompts` keys vs `FIXABLE_KINDS`), the shipped examples, each row of SPEC "Validation"
- `test/config.test.js` — `loadBoard` (empty, broken, mixed boards, relative/absolute files, defaults, credential merge, `PORT`) and the describe helpers
- `test/secrets.test.js` — store providers per OS with a fake `execFile`, blob decoding, the chain, error texts, cache, no-leak checks, `resolvable`
- `test/http.test.js` — GET-only enforcement, ETag cache, pagination over a fake `fetch`
- `test/limit.test.js` — `mapLimit` concurrency and order
- `test/discover.test.js` — discovery against fixtures through the real `http.js` over a fake `fetch` (pagination), `repoSet` table tests, the discovery cache
- `test/github.test.js` — GitHub source and lock reader tests against fixtures with a fake `http`
- `test/bitbucket.test.js` — Bitbucket source (normalization, CI, conflicts, behind, caching, stacked) and its lock reader against fixtures
- `test/jira.test.js` — Jira source tests (two sites, 404, null `browse`, cache, errors)
- `test/sharedPackages.test.js` — `lockCheck` with fake readers (consumers, pinned, missing, cache, cross-host, two entries, repo refs) and the example project end to end (fixtures → `lockCheck` → `enrich`)
- `test/derive.test.js` — Ticket matchers, main and release branches, every signal, worst, ready, `enrich`, `groupByTicket`, `groupByRepo`, `attentionCounts`
- `test/collector.test.js` — collector tests with stub sources, discoverers, secrets and http (snapshot shape, credentials per host, identity per `(host, ref)`, prefixed log lines, a project with an error, warnings, lock check, fix context, no overlap, last-good data, partial errors, discovery and repo warnings, Jira keys per site)
- `test/board.test.js` — board tests with fake timers and a fake clock: every row of the rates table and every touch rule, follow-up, overlap, `list`/`snapshot`/`refresh`, `projectSummary`
- `test/server.test.js` — routes over a stub board (redirect, project pages, API, 404 JSON, old routes gone, Host/Origin guard), `bootstrap` with stub upstream
- `test/view.test.js` — view model and render tests with the real `derive.js` injected: tabs, header, banners, warnings, Ticket headers, fix ctx, no-projects and unknown-project states
- `test/fix-prompt.test.js` — the SPEC's two canonical examples as golden tests (ctx from `projects/example.json` + `config.example.json`), fixable filtering, severity, per-kind default steps, host labels, conventions, fix notes, bundle order and ordering line, on PRs run through `derive.enrich`
- `test/install.test.js` — renderer snapshots and no-token check, gh lookup, targets, command plans per OS, `applySteps`, refusal rule (with the real `createSecrets` over a fake `execFile`), CLI flags
- `test/dev-stub.test.js` — the dev stub serves both projects with fixture-shaped PRs and no upstream

### Fixtures (made up, names from `projects/example.json`)

- `test/fixtures/github/` — GitHub responses in the shape of real ones (`acme-corp/acme-api`, `acme-corp/acme-status`); `index.json` maps API path → file; `discover-org-1.json`/`discover-org-2.json` (org repo listing, two pages, archived and disabled repos) `discover-user.json` (public user listing with a fork) and `discover-own-1.json`/`discover-own-2.json` (`/user/repos`, two pages: another owner's repo, a fork, an archived one); `lock-index.json` maps the lock reader's paths to `lock-*.json` (consumer `acme-api` composer files, `acme-corp/acme-shared` closed PRs, branch, compare, head lookup)
- `test/fixtures/bitbucket/` — Bitbucket GET bodies (workspace `acme`: `acme-backend`, `acme-web`, `acme-shared`) plus `routes.json` mapping each request URL to its file; `shared-merged-shop-42.json` (merged shared #7 for SHOP-42, used by the example project test); `discover-1.json`/`discover-2.json` (workspace repo listing, two pages, a fork)
- `test/fixtures/jira/` — issue bodies (`SHOP-42`, `OPS-7`, a 404)
- `test/fixtures/config/` — `broken/` (invalid `config.json`) and `board/` (config with good, broken-JSON, invalid, missing and broken-entry projects)
