# pr-board

Node 22, ESM, zero npm dependencies. A local collector and page for the open pull requests of one or more projects on GitHub and Bitbucket, with Jira status per Ticket.

## Commands

- Test: `npm test` (`node --test`)
- Run: `npm start`, then open http://127.0.0.1:7419
- Page work without tokens or network: `PORT=7431 node scripts/dev-stub.js` (add `--broken` for a project with a config error)
- Run at login: `node scripts/install.js` (`--print` renders the unit only, `--uninstall` removes it, `--url` prints the board URL)

## Rules

- Strictly read-only upstream: every GitHub, Bitbucket and Jira call goes through `src/http.js`, which only does GET. Never add another method, and never call `fetch` directly from a source.
- Tokens come only from the OS store, an env var or `gh auth token`, through `src/secrets.js` only. Never print, log, persist or put one in the snapshot.
- Test-first (red, green, refactor). Sources are tested against fixtures in `test/fixtures/` with an injected `http`; OS code with an injected `platform`, `env`, `homedir` and a fake `execFile`. No live calls and no OS tools (`security`, `secret-tool`, `powershell.exe`, `launchctl`, `systemctl`, `schtasks`, `gh`) in `npm test`.
- Fixtures and examples use only the made-up names from `projects/example.json` (owner `acme-corp`, workspace `acme`, repos `acme-*`, Tickets `SHOP`/`OPS`). Never record a fixture from a real project.
- `src/derive.js`, `public/view.js` and `public/fix-prompt.js` stay pure: no I/O, no imports in the two page modules, and no `Date.now()`. Pass `now` in.
- `FIXABLE_KINDS` in `public/fix-prompt.js` and the `fixPrompts` keys in `projects/project.schema.json` (plus `group`) stay in sync; a test checks it. The validator's rule tables mirror both schema files the same way.
- No npm dependencies. No build step. The page is vanilla JS in `public/`.
- Ticket links come from the matcher's `browse` template, never from an API host.
- Bind to `127.0.0.1` only.

## Docs

- `docs/SPEC.md`: what and how (config, secrets, sources, signals, polling, page, fix prompts)
- `docs/PLAN.md`: tasks and status
- `GLOSSARY.md`: domain terms
- `filemap.md`: where things live. Update it when you add or move files.
- `README.md`: setup and operation for humans. Update it when config keys, tokens or run steps change.
