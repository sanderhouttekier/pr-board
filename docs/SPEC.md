# PR board: spec

A local page that keeps the open pull requests of one or more projects in view. It groups them by Ticket and by repository, and shows the status that decides whether each PR can be merged: CI, conflicts, commits behind, stacked-PR traps, lock updates due on a shared package, and the Jira status of the Ticket.

Terms follow `GLOSSARY.md`. Decisions behind this spec live in the map `.scratch/generic-board/map.md` and its tickets (local only, never published).

Paths marked **untested** come from docs, not from a real machine. In v1 that means every Windows path and the Linux secret and autostart paths. The README invites help to test them.

## Goals

- One board for any number of projects on GitHub and Bitbucket, with Jira status where a project uses Jira. It runs on macOS, Linux and Windows.
- A project picker: each project is a tab with its own URL (`/p/<id>`). There's no "all projects" view.
- Two views per project: **by Ticket** (`SHOP-42` with its PRs in every repo) and **by repository**.
- Per PR: CI result, mergeability, commits behind its base, age, stacked-PR trap and shared package signals.
- Per Ticket group: the Jira status (when the Ticket's tracker is Jira) and "ready N of M".
- A "Mine" / "All" toggle, and a fix prompt for every PR with a fixable signal.
- Every PR row links to the PR in the browser, where the person merges.
- It refreshes on its own, slows down for projects nobody is looking at, makes no calls when no page is open, and can start at login.

## Non-goals

- No writes to GitHub, Bitbucket or Jira, ever. The collector only sends GET requests upstream (enforced in `src/http.js`).
- No merging, commenting or retargeting from the page.
- No hosting and no multi-user use: the board binds to `127.0.0.1` only.
- No reviewer or approval signals.
- No npm dependencies and no build step.
- No token in any file the board reads or writes (see "Secrets").
- Out of scope for v1: an "all projects" view, raw-regex ticket matchers, `#N` or bare-number ticket keys, auto-detected prefixes, lock readers other than composer, a secrets file, a setup command, and a WSL bridge to Windows Credential Manager.

## Stack

- Node 22 (ESM, global `fetch`, `node:test`, `node:http`), with no dependencies.
- Plain HTML, CSS and JS for the page, served by the same process.
- OS tools through `child_process.execFile` (never a shell): `security` (macOS), `secret-tool` (Linux), `powershell.exe` (Windows), `gh`, `launchctl`, `systemctl`, `schtasks`.
- Licence: MIT, `Copyright (c) 2026 Sander Houttekier`.

## Config

### Config dir

The board resolves one config dir and reads everything from it. Node has no API for this, so `src/configdir.js` does it by hand with injected `env`, `platform` and `homedir`:

1. `PR_BOARD_CONFIG_DIR`, when it's set and absolute.
2. Windows: `%APPDATA%\pr-board`, falling back to `<homedir>\AppData\Roaming\pr-board`. **Untested.**
3. macOS and Linux: `$XDG_CONFIG_HOME/pr-board` when `XDG_CONFIG_HOME` is set and absolute (empty or relative values are ignored), else `~/.config/pr-board`. The Linux path is **untested**.

When the dir is missing, the board creates it with mode `0700` (the mode is ignored on Windows). The installer bakes the resolved dir into the autostart unit as `PR_BOARD_CONFIG_DIR`, so a terminal and a service never read different dirs.

Layout:

```
<config dir>/
  config.json          personal config
  projects/acme.json   project files (or anywhere: paths are configurable)
```

The rule is: what describes the project goes in the project file, which can be shared. What is about you goes in the personal config.

### Personal config (`config.json`)

All keys are optional. With no `config.json` at all, the board starts with no projects and the page says how to add one.

```json
{
  "$schema": "https://raw.githubusercontent.com/sanderhouttekier/pr-board/main/config.schema.json",
  "port": 7419,
  "intervalSec": 300,
  "idleAfterSec": 900,
  "idleIntervalSec": 3600,
  "staleDays": 14,
  "behindWarn": 20,
  "ghPath": "gh",
  "credentials": {
    "github": { "ref": "" },
    "bitbucket": { "ref": "pr-board-bitbucket", "email": "you@example.com" },
    "jira": { "ref": "pr-board-jira", "email": "you@example.com" }
  },
  "projects": {
    "acme": {
      "file": "projects/acme.json",
      "credentials": {
        "bitbucket": { "ref": "acme-bitbucket", "email": "you@acme.example" }
      }
    }
  },
  "fixNotes": {
    "bitbucket": "Read pipelines through the Atlassian MCP.",
    "all": ""
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `port` | `7419` | Local port. The `PORT` env var wins when it's a valid number. |
| `intervalSec` | `300` | Round interval for the project being viewed. |
| `idleAfterSec` | `900` | After this long without a request, a project counts as not viewed, and the board counts as closed when no request of any kind arrived. |
| `idleIntervalSec` | `3600` | Round interval for projects that aren't viewed while the board is open. |
| `staleDays` | `14` | A PR not updated for longer gets "stale". |
| `behindWarn` | `20` | From this many commits behind, "behind" is a warning. |
| `ghPath` | `"gh"` | The `gh` binary (a name on `PATH` or an absolute path). |
| `credentials.<host>` | none | Global token reference per host (`github`, `bitbucket`, `jira`). `email` is required for `bitbucket` and `jira`, and not allowed for `github`. An empty or missing GitHub `ref` means "use `GH_TOKEN`, `GITHUB_TOKEN`, then `gh auth token`". |
| `projects.<id>.file` | required | Path to the project file. A relative path resolves against the config dir. |
| `projects.<id>.credentials.<host>` | none | Credential override for that project. Same shape as the global one. |
| `mine.github`, `mine.bitbucket` | detected | Override the "mine" identity (login, or Bitbucket account uuid) for every project. |
| `fixNotes.github`, `.bitbucket`, `.all` | none | Fix notes (see "Fix prompts"). |

The project id is the key under `projects`. It must match `^[a-z0-9][a-z0-9-]*$`, and it becomes the URL `/p/<id>`. Tabs follow the order of the keys.

### Project file

```json
{
  "$schema": "https://raw.githubusercontent.com/sanderhouttekier/pr-board/main/projects/project.schema.json",
  "title": "Acme",
  "hosts": {
    "github": { "owner": "acme-corp" },
    "bitbucket": { "workspace": "acme" }
  },
  "repos": {
    "bitbucket": ["acme-shared", "acme-backend", "acme-worker", "acme-web"]
  },
  "aliases": {
    "acme-shared": "shared",
    "acme-backend": "backend",
    "acme-worker": "worker",
    "acme-web": "web"
  },
  "tickets": [
    { "prefix": "SHOP", "browse": "https://jira.example.com/browse/{key}", "jira": "main" },
    { "prefix": "OPS", "browse": null },
    { "link": "trello.com/c/" }
  ],
  "jira": {
    "main": { "cloudId": "00000000-0000-4000-8000-000000000000" }
  },
  "sharedPackages": [
    {
      "repo": "acme-shared",
      "kind": "composer",
      "package": "acme/shared",
      "consumers": ["acme-backend", "acme-worker"]
    }
  ],
  "fixPrompts": {
    "lock-missing": "Edit only `reference` and `time` of the package in composer.lock, and only if its composer.json is unchanged between the two commits; otherwise stop and tell me. Git only, no local composer run.",
    "lock-unpin": "Edit only `reference` and `time` of the package in composer.lock, and only if its composer.json is unchanged between the two commits; otherwise stop and tell me. Git only, no local composer run.",
    "group": "Wait for CI on the shared package before you update a lock."
  }
}
```

This is `projects/example.json` in the repo, the only project file the repo ships. Tests and the README depend on it.

| Key | Required | Meaning |
|---|---|---|
| `title` | no (default: the id) | Tab and page title. |
| `hosts.github.owner` | at least one host | GitHub org or user. One owner per host in v1. |
| `hosts.bitbucket.workspace` | at least one host | The Bitbucket workspace. |
| `repos.<host>` | no | Whitelist of repo names. Without it, the board discovers the repos (see "Repos"). |
| `aliases` | no | Repo name → short name shown on rows. Without an alias, the short name is the repo name. |
| `tickets` | no | Ticket matchers, in order (see "Tickets"). Without them, every PR is "Other" or in a branch group. |
| `jira.<site>.cloudId` | when a matcher names the site | The Jira site whose status is fetched. |
| `sharedPackages` | no | Turns on the shared package check (see "Shared package check"). |
| `fixPrompts.<kind>` | no | Project conventions for fix prompts (see "Fix prompts"). |

A repo reference (`aliases` keys, `sharedPackages.repo`, `consumers`) is a plain repo name. When a project has the same name on both hosts, write `github:<name>` or `bitbucket:<name>`. A plain name that matches both gives a warning, and the reference is ignored.

### JSON Schemas

The repo ships `config.schema.json` (personal config) and `projects/project.schema.json` (project file). Both use draft 2020-12 and are referenced through `"$schema"` for editor autocomplete. `additionalProperties: false` makes an editor flag unknown keys. The board itself only warns about them (see "Validation").

`projects/project.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://raw.githubusercontent.com/sanderhouttekier/pr-board/main/projects/project.schema.json",
  "title": "PR board project file",
  "type": "object",
  "required": ["hosts"],
  "additionalProperties": false,
  "properties": {
    "$schema": { "type": "string" },
    "title": { "type": "string", "minLength": 1 },
    "hosts": {
      "type": "object",
      "minProperties": 1,
      "additionalProperties": false,
      "properties": {
        "github": {
          "type": "object", "required": ["owner"], "additionalProperties": false,
          "properties": { "owner": { "$ref": "#/$defs/name" } }
        },
        "bitbucket": {
          "type": "object", "required": ["workspace"], "additionalProperties": false,
          "properties": { "workspace": { "$ref": "#/$defs/name" } }
        }
      }
    },
    "repos": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "github": { "$ref": "#/$defs/repoList" },
        "bitbucket": { "$ref": "#/$defs/repoList" }
      }
    },
    "aliases": {
      "type": "object",
      "propertyNames": { "$ref": "#/$defs/repoRef" },
      "additionalProperties": { "type": "string", "pattern": "^[A-Za-z0-9._-]+$" }
    },
    "tickets": {
      "type": "array",
      "items": { "oneOf": [{ "$ref": "#/$defs/prefixMatcher" }, { "$ref": "#/$defs/linkMatcher" }] }
    },
    "jira": {
      "type": "object",
      "propertyNames": { "$ref": "#/$defs/name" },
      "additionalProperties": {
        "type": "object", "required": ["cloudId"], "additionalProperties": false,
        "properties": { "cloudId": { "type": "string", "pattern": "^[0-9a-fA-F-]{36}$" } }
      }
    },
    "sharedPackages": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["repo", "kind", "package", "consumers"],
        "additionalProperties": false,
        "properties": {
          "repo": { "$ref": "#/$defs/repoRef" },
          "kind": { "const": "composer" },
          "package": { "type": "string", "pattern": "^[a-z0-9_.-]+/[a-z0-9_.-]+$" },
          "consumers": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/repoRef" } }
        }
      }
    },
    "fixPrompts": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "conflict": { "type": "string" },
        "ci-failed": { "type": "string" },
        "base-retarget": { "type": "string" },
        "base-no-pr": { "type": "string" },
        "lock-unpin": { "type": "string" },
        "lock-missing": { "type": "string" },
        "lock-pinned": { "type": "string" },
        "group": { "type": "string" }
      }
    }
  },
  "$defs": {
    "name": { "type": "string", "pattern": "^[A-Za-z0-9._-]+$" },
    "repoRef": { "type": "string", "pattern": "^((github|bitbucket):)?[A-Za-z0-9._-]+$" },
    "repoList": { "type": "array", "items": { "$ref": "#/$defs/name" }, "uniqueItems": true },
    "prefixMatcher": {
      "type": "object",
      "required": ["prefix", "browse"],
      "additionalProperties": false,
      "properties": {
        "prefix": { "type": "string", "pattern": "^[A-Za-z][A-Za-z0-9]*$" },
        "browse": { "oneOf": [{ "type": "string", "pattern": "^https://.*\\{key\\}" }, { "type": "null" }] },
        "jira": { "$ref": "#/$defs/name" }
      }
    },
    "linkMatcher": {
      "type": "object",
      "required": ["link"],
      "additionalProperties": false,
      "properties": { "link": { "type": "string", "pattern": "^[A-Za-z0-9.-]+\\.[A-Za-z]+/.+/$" } }
    }
  }
}
```

`config.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://raw.githubusercontent.com/sanderhouttekier/pr-board/main/config.schema.json",
  "title": "PR board personal config",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "$schema": { "type": "string" },
    "port": { "type": "integer", "minimum": 1, "maximum": 65535 },
    "intervalSec": { "type": "integer", "minimum": 30 },
    "idleAfterSec": { "type": "integer", "minimum": 60 },
    "idleIntervalSec": { "type": "integer", "minimum": 300 },
    "staleDays": { "type": "integer", "minimum": 1 },
    "behindWarn": { "type": "integer", "minimum": 1 },
    "ghPath": { "type": "string", "minLength": 1 },
    "credentials": { "$ref": "#/$defs/credentials" },
    "projects": {
      "type": "object",
      "propertyNames": { "pattern": "^[a-z0-9][a-z0-9-]*$" },
      "additionalProperties": {
        "type": "object",
        "required": ["file"],
        "additionalProperties": false,
        "properties": {
          "file": { "type": "string", "minLength": 1 },
          "credentials": { "$ref": "#/$defs/credentials" }
        }
      }
    },
    "mine": {
      "type": "object",
      "additionalProperties": false,
      "properties": { "github": { "type": "string" }, "bitbucket": { "type": "string" } }
    },
    "fixNotes": {
      "type": "object",
      "additionalProperties": false,
      "properties": { "github": { "type": "string" }, "bitbucket": { "type": "string" }, "all": { "type": "string" } }
    }
  },
  "$defs": {
    "credentials": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "github": {
          "type": "object", "required": ["ref"], "additionalProperties": false,
          "properties": { "ref": { "type": "string" } }
        },
        "bitbucket": { "$ref": "#/$defs/atlassian" },
        "jira": { "$ref": "#/$defs/atlassian" }
      }
    },
    "atlassian": {
      "type": "object", "required": ["ref", "email"], "additionalProperties": false,
      "properties": { "ref": { "type": "string", "minLength": 1 }, "email": { "type": "string", "pattern": "^[^@\\s]+@[^@\\s]+$" } }
    }
  }
}
```

### Validation

The validator (`src/validate.js`) is hand-written, because there are no dependencies. It walks a rule table with the same paths, types, patterns and required keys as the two schemas. A test keeps the two in sync: it reads both schema files and asserts that the validator's rule table matches them path by path. A second test asserts that the `fixPrompts` keys in the schema equal `FIXABLE_KINDS` plus `group`.

| Problem | Effect |
|---|---|
| Project file: invalid JSON, missing file, wrong type, missing required key (`hosts`, `owner`, `workspace`, `file`), a matcher with both or neither of `prefix`/`link`, a matcher `jira` that names no site under `jira`, `kind` other than `composer` | That project stops. Its tab shows the error (file path, JSON path, what's wrong), and the other projects keep running. |
| Personal config: invalid JSON or a wrong type at the top level | The board still starts and serves the page with one error banner and no projects. It never crashes on a config file. |
| Personal config: a broken `projects.<id>` entry or credential | Only that project stops, with the error on its tab. |
| An unknown key in either file, including an unknown `fixPrompts` key | A warning on the tab ("Unknown key `fixPrompts.lock-mising`, ignored"). Warnings from the personal config show on every tab. |
| An empty or whitespace-only `fixPrompts` or `fixNotes` value | Treated as absent, with no warning. |
| An ambiguous repo reference, a whitelisted repo that discovery didn't return, a shared package repo or consumer that isn't in the project, duplicate alias values | A warning on the tab, and the reference is ignored. These are known only after the first round. |

Config is read at start. Changes need a restart, as today.

## Secrets

### Rule

A token comes only from the OS secret store, an env var, or `gh auth token`. The board never reads a token from a file of its own, and never writes one to config, project files, rendered units, logs, errors or the snapshot. `src/secrets.js` is the only module that touches tokens.

A **token reference** (`ref`) is the entry name in the store. There's no naming rule. The **credential** for a host in a project is the project's credential override when it has one, else the global one. The Atlassian email comes from the credential's `email`, never from a store or env var.

### Provider chain

For a credential with reference `R` on host `H`, the providers run in this order, and the first non-empty answer wins:

1. **OS store** (only when `R` is non-empty):
   - macOS: `security find-generic-password -s R -w`, with a 10 s timeout. Not found exits 44.
   - Linux: `secret-tool lookup service R`, with a 10 s timeout. Any failure exits 1 with empty stdout, and ENOENT (not installed) is silent. **Untested.**
   - Windows: `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <b64>`, with `windowsHide: true` and a 15 s timeout. A P/Invoke `CredReadW` script reads every needed reference in one call: the names go in through an env var, and the values come back as one JSON object on stdout. A blob is decoded as UTF-16LE when its length is even and byte 1 is 0, else as UTF-8. `pwsh` is the fallback when `powershell.exe` is missing. **Untested** (timing and blob encoding).
2. **Env var** (only when `R` is non-empty): the name is derived from `R`: uppercase, and every non-alphanumeric character becomes `_` (`acme-bitbucket` → `ACME_BITBUCKET`). It holds the token only.
3. **Global GitHub identity only** (`H` is `github` and the credential is the global one): `GH_TOKEN`, then `GITHUB_TOKEN`, then `<ghPath> auth token`.

A credential override that misses never falls through to step 3. A project with an override gets either its own token or a "no token" error, never your global GitHub identity.

Every child runs through an injected `execFile`, never a shell. Any child error is swallowed, because its message or stdout may hold a secret. Results are cached in memory per `(host, ref)` as the in-flight promise. A failed lookup is dropped from the cache, so the next poll retries; that heals a Linux keyring that's still locked at login.

Auth headers: GitHub `Bearer <token>`. Bitbucket and Jira `Basic base64(<email>:<token>)`.

### "No token" errors

When the chain finds nothing, the project's source error (tab, banner, log) lists the sources it tried, in order, and never a value. For example:

> No Bitbucket token for `acme-bitbucket`: tried Keychain entry `acme-bitbucket`, env var `ACME_BITBUCKET`.

When the board runs autostarted (env `PR_BOARD_AUTOSTARTED=1`, set by the installer), the error adds: "This board was started at login: env vars from your shell profile aren't visible here. Store the token in Keychain (or Secret Service, or Credential Manager)." A missing `email` on an Atlassian credential is its own error: "No email for the Bitbucket credential `acme-bitbucket` in config.json".

### Storing a token (README)

| OS | Command |
|---|---|
| macOS | `security add-generic-password -U -a "$USER" -s <ref> -w "$(pbpaste)"`, then `pbcopy < /dev/null`. Don't use the interactive `-w` prompt: it cuts Atlassian tokens (about 192 chars) at 128. |
| Linux (**untested**) | `secret-tool store --label=<ref> service <ref>`. It prompts. Never pipe the token with a trailing newline, because the newline gets stored. |
| Windows (**untested**) | `cmdkey /generic:<ref> /user:token /pass`. It prompts. |

GitHub needs no store entry when `gh` is logged in. `gh` without a keyring (or with `--insecure-storage`) keeps its token in a plain-text file of its own. That's `gh`'s storage and the person's choice, and the README says so. WSL counts as headless Linux: run the board from a terminal with env vars, or run it natively on Windows.

## Autostart

`node scripts/install.js` replaces `scripts/install-launchd.sh` and `scripts/uninstall-launchd.sh`. It switches on an injected `process.platform`, renders a unit from `process.execPath` and the absolute path of `src/server.js`, and shells out (`execFile`) to the OS tool.

| | macOS | Linux (**untested**) | Windows (**untested**) |
|---|---|---|---|
| Name | launchd label `io.github.sanderhouttekier.pr-board` | `pr-board.service` | task `pr-board` |
| File | `~/Library/LaunchAgents/io.github.sanderhouttekier.pr-board.plist` | `$XDG_CONFIG_HOME/systemd/user/pr-board.service` (default `~/.config/systemd/user/`) | task XML in a temp file |
| Activate | `launchctl bootout` (if loaded), then `launchctl bootstrap gui/<uid> <plist>` | `systemctl --user daemon-reload`, then `systemctl --user enable --now pr-board.service` | `schtasks /create /xml <file> /tn pr-board /f` |
| Restart | `KeepAlive`, `ThrottleInterval` 30 | `Restart=on-failure`, `RestartSec=10` | `RestartOnFailure` (Count 3, Interval PT1M), `ExecutionTimeLimit` PT0S, both battery settings false, `LogonTrigger` for the current user |
| Logs | `~/Library/Logs/pr-board.log` | the journal (`journalctl --user -u pr-board`) | none in v1 |
| Remove | `bootout` and delete | `disable --now`, delete, `daemon-reload` | `schtasks /delete /tn pr-board /f` |

On Linux without systemd (no `/run/systemd/system`), the installer writes `~/.config/autostart/pr-board.desktop` instead, with no crash restart. **Untested.** On Windows, the console window and non-admin task creation are **untested**.

Every unit sets the working directory to the repo and these env vars, none of them secret:
- `PR_BOARD_CONFIG_DIR`: the resolved config dir;
- `PR_BOARD_AUTOSTARTED=1`;
- `PATH`: the OS default plus the directory of `gh` (resolved at install time) and of `process.execPath`.

Flags:
- `--print` renders the unit to stdout and runs no check and no OS tool;
- `--uninstall` removes the unit;
- `--url` prints the board URL with the configured port.

Run it again after switching Node versions.

### Refusal rule

Before it writes anything, the installer loads the personal config and every project file. It refuses (exit 1, writes nothing) when:

- a project file fails validation (it names the file and the error); or
- any host used by a configured project doesn't resolve from a source an autostarted board will see. Those sources are the OS store and, for the global GitHub identity, `gh auth token`. Env vars don't count. A project uses `github` or `bitbucket` when it's under `hosts`, and `jira` when any matcher names a Jira site. Credential overrides are included.

For each miss, it prints the token reference and this OS's store command from "Storing a token", or the missing `email`. It never prints a token. There's no `--force`. `--print` still renders.

## Repos

### Discovery

At most once an hour per project and host (cached, with ETags), the source lists the repos the token can see:

- GitHub: `GET /orgs/{owner}/repos?type=sources&per_page=100`, all pages. On a 404 (the owner is a user, not an org), it first uses `GET /user/repos?affiliation=owner&per_page=100`, all pages, and keeps the repos whose `owner.login` is the owner (case-insensitive), so the token holder's own private repos are included; a fine-grained PAT lists only its selected repos there. If that keeps none (the token is someone else's), it uses `GET /users/{owner}/repos?type=owner&per_page=100`, which lists public repos only. Either way it drops forks, `archived` and `disabled` repos. It keeps `name` and `default_branch`. A fine-grained PAT needs Metadata: read.
- Bitbucket: `GET /2.0/repositories/{workspace}?pagelen=100&sort=-updated_on&fields=values.slug,values.parent.full_name,values.updated_on,values.mainbranch.name,next`, all pages. It drops forks (those with a `parent`). The token needs `read:repository:bitbucket` on top of `read:pullrequest:bitbucket`.

The repo set of a project per host is:
- **with `repos.<host>`** (the whitelist): exactly those repos, in that order. A whitelisted repo that discovery didn't return gives a warning ("`acme-web` not found, or the token can't see it") and is skipped.
- **without it**: every discovered repo. On Bitbucket, at most **40** repos, the most recently updated first (a constant in v1, not a config key). When the cap bites, the tab warns: "Showing 40 of 112 Bitbucket repos (rate limit). Add a repo list to choose which." GitHub has no cap.

Why the cap: Bitbucket allows about 1,000 requests an hour for an API token on `/2.0/repositories/*`, which is every Bitbucket call the board makes. 40 PR lists at 5-minute rounds is about 480 an hour plus details. The README advises a whitelist for large workspaces. A 429 shows as a source error with the last good data, like any failure.

Per repo, the board knows `host`, `repo`, `repoShort` (alias or name), `repoUrl` (the open-PR list page) and `defaultBranch`.

### PR descriptions

Link matchers need the PR description, and the list calls carry it:
- GitHub: `body` is in the `pulls` list response already;
- Bitbucket: add `values.description` to `PR_FIELDS`, falling back to `values.summary.raw` when `description` is missing (one of the settling GETs in the plan confirms which).

The description is used only to derive the Ticket key, and it's dropped before the snapshot.

## Tickets

Ticket matchers come from the project's `tickets`. A PR gets at most one Ticket key:

1. **Prefix matchers**, all together: the leftmost match in the source branch, else the leftmost match in the title. The pattern per prefix `P` is `(?<![A-Za-z0-9])P[-_ ]?(\d+)(?![0-9])`, case-insensitive, so `_` and `/` count as boundaries. `SHOP-42`, `SHOP 42`, `shop_42` and `SHOP42` all become the key `SHOP-42` (the prefix uppercased, a hyphen, then the digits as written). Bare numbers and `#N` never match.
2. **Link matchers**, in file order, only when no prefix matched: the first URL in the description that contains the `link` text. The Ticket key is the URL up to and including the id segment that follows the `link` text (`https://trello.com/c/AbC123`). The label is `#` plus the leading digits of the next path segment (`/c/AbC123/95-fix-login` → `#95`). Without such digits, the label is the id segment. The link goes to the key URL. Trello is the only link tracker in v1.
3. No match: the PR has no Ticket. It joins a branch group when two or more such PRs share the exact same source branch, else "Other PRs".

Per Ticket key the snapshot carries `{ label, url, status, summary }`:
- prefix: `label` is the key; `url` is `browse` with `{key}` replaced, or null;
- link: as above, with no status.

**Jira status.** For keys whose matcher names a Jira site, the Jira source runs `GET https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/issue/{key}?fields=status,summary` with Basic auth. Scoped Atlassian tokens only work through this gateway. It caches for 10 minutes. A 404 means `{ status: null }`, which isn't an error. Links always come from `browse`, never from the gateway or `atlassian.net`.

**Rename.** "Feature" becomes "Ticket" in code, snapshot and UI:
- `featureKey` → `ticketKey`, `groupByFeature` → `groupByTicket`;
- snapshot `features` → `tickets`;
- group kind `feature` → `ticket`;
- "By feature" → "By ticket";
- the `localStorage` view value `feature` → `ticket` (a stored old value falls back to the default).

## Normalized PR

Each source returns these. Changes from today: `owner`, `defaultBranch`, `description` and `locks`.

```js
{
  id: 'bitbucket:acme-backend#12',
  host: 'github' | 'bitbucket',
  owner: 'acme',                       // GitHub owner or Bitbucket workspace
  repo: 'acme-backend', repoShort: 'backend',
  repoUrl, defaultBranch: 'develop',
  number: 12, title, url,
  description: string | null,          // dropped before the snapshot
  author: { name, id },
  mine: boolean,
  source: 'feature/SHOP-42-invoice-export', target: 'develop',
  headSha, draft: boolean,
  createdAt, updatedAt,
  ci: 'ok' | 'failed' | 'running' | 'none' | 'unknown',
  mergeable: 'clean' | 'conflict' | 'unknown',
  behindBy: number | null,
  basePr: undefined | null | { number, state, url },   // only for stacked PRs, as today
  locks: [ {                           // one per shared package this repo consumes; [] otherwise
    package: 'acme/shared',
    sharedRepo: { host, repo, repoShort, defaultBranch },
    constraint: string | null,         // composer.json require, e.g. 'dev-develop', 'dev-feature/SHOP-42-x'
    lockRef: string | null,            // composer.lock source.reference
    pinnedPr: undefined | null | { number, state, url },   // when constraint is dev-<branch> ≠ dev-<shared default>
    missingPrs: [ { number, url } ]    // merged shared package PRs (same Ticket key) the lock lacks
  } ]
}
```

A branch is a "main branch" (not stacked, and a release branch) when it's in `{develop, main, master, staging, acceptance}` or it's the repo's `defaultBranch`.

## Source rules

These are today's rules, with owner and workspace from the project file and repos from "Repos". Every call goes through `http.get` / `http.getAll` (GET only).

**GitHub** (per repo, every round)

- `GET /repos/{owner}/{repo}/pulls?state=open&per_page=100`, all pages. It carries `body`.
- Mergeable: `GET /pulls/{n}`, mapping `mergeable_state`:
  - `dirty` → conflict;
  - `clean`, `unstable`, `blocked`, `behind` or `has_hooks` → clean;
  - `null`, `unknown` or `draft` → unknown.
- CI: `GET /actions/runs?head_sha={sha}&per_page=50`, taking the latest run per workflow:
  - any `failure`, `timed_out`, `cancelled` or `startup_failure` → failed;
  - else any queued or in progress → running;
  - else at least one run → ok;
  - no runs → none.

  Only `ok` is cached per sha. Actions means no Checks permission is needed.
- Behind: `GET /branches/{target}` once per repo and target per round, then `GET /compare/{baseHead}...{headSha}` → `behind_by`. Cached by sha pair.
- Base PR (stacked PRs only): `GET /pulls?state=all&head={owner}:{target}&per_page=20`. It prefers open, then the newest merged, then the newest closed.

**Bitbucket** (per repo, every round)

- `GET /2.0/repositories/{workspace}/{repo}/pullrequests?state=OPEN&pagelen=50&fields=…`, all pages. `fields` now include `values.description`. There's no workspace-wide PR endpoint for API tokens.
- Conflicts: `GET .../pullrequests/{id}/diffstat`. Any `merge conflict`, `local deleted` or `remote deleted` status → conflict. Cached by `(headSha, targetHead)`.
- CI: `GET .../commit/{headSha}/statuses`:
  - any `FAILED` or `STOPPED` → failed;
  - else `INPROGRESS` → running;
  - else at least one `SUCCESSFUL` → ok;
  - none → none.
- Behind: the target head from `GET .../refs/branches/{target}`, then `GET .../commits?include={targetHead}&exclude={headSha}&pagelen=100`, counted (capped at 100, shown as "99+"). Cached by sha pair.
- Base PR (stacked PRs only): `GET .../pullrequests?q=source.branch.name="{target}"` across states. It prefers open, then merged, then declined.

**Jira**: see "Tickets".

**Viewer identity** ("mine"): GitHub `GET /user` → `login`, Bitbucket `GET /2.0/user?fields=uuid` → `uuid`. It's looked up once per `(host, ref)`, because credential overrides can be other accounts. It's cached after success and retried next round after a failure. A `mine.<host>` value in the personal config replaces the lookup.

## Shared package check

For each entry in `sharedPackages` (shared package repo `S`, `kind: composer`, package `P`, consumers `C`), and for each open PR in a consumer repo, the consumer's source reads at the PR's `headSha`. Both repos may be on either host, and each read uses its own repo's host and credential.

- **Constraint**: `require[P]` from `composer.json`. **Lock ref**: `source.reference` of `P` in `composer.lock` (`packages` or `packages-dev`).
  - Bitbucket: `GET .../src/{headSha}/composer.json` and `.../composer.lock`, as today.
  - GitHub: `GET /repos/{owner}/{repo}/contents/composer.json?ref={headSha}` (and `composer.lock`) with `Accept: application/vnd.github.raw+json`. **New, verify with a fixture.**
  - Cached by `(repo, headSha)`. A failed read is reported as null and retried next round.
- **Pinned**: the constraint is `dev-<branch>` and `<branch>` isn't `S`'s `defaultBranch`. The board looks up `S`'s PR from that branch (the base-PR lookup on `S`'s host): open, merged, or none.
- **Missing**: `S`'s PRs merged in the last 30 days with the same Ticket key as the consumer PR, whose merge commit isn't contained in the lock ref:
  - Bitbucket: as today, with `S`'s default branch instead of `develop`;
  - GitHub: `GET /repos/{owner}/{S}/pulls?state=closed&sort=updated&direction=desc&per_page=50`, keeping those with `merged_at` in the window and a `merge_commit_sha`, then `GET /repos/{owner}/{S}/compare/{lockRef}...{defaultHead}` and checking whether each merge sha is among `commits[].sha` (the commits the lock lacks).

The signals keep their kinds (the fix prompt keys depend on them), and their labels name the shared package by its short name:

| Kind | Severity | Label |
|---|---|---|
| `lock-waits` | neutral | "waits for shared #7" |
| `lock-unpin` | warning | "lock bump due: unpin" |
| `lock-pinned` | warning | "pinned to shared branch" |
| `lock-missing` | warning | "lock bump due: shared #7" |

The attention chip stays "Lock bump due". Only composer is read in v1. Other lock files wait until a project needs them.

## Derived signals (`derive.js`, pure)

`ctx` is `{ now, staleDays, behindWarn, matchers }`. `derive.js` does no I/O and never calls `Date.now()`. It's also served to the page as `/lib/derive.js`.

- **Ticket key**: see "Tickets" (`ticketKey(pr, matchers)`).
- **Main branch**: one of `{develop, main, master, staging, acceptance}`, or the repo's `defaultBranch`.
- **Release PR**: source and target both main branches, or a title matching `/^(develop|staging|acceptance|main)\s*>\s*/i`. Folded away by default.
- **Stacked**: the target isn't a main branch.
  - Base PR open → neutral "stacked on #N".
  - Base merged on GitHub → danger "base merged: retarget". Base closed → danger "base closed: retarget".
  - Base merged on Bitbucket → neutral "base merged (auto-retarget)".
  - No PR for the base branch → warning "base has no PR".
- **Shared package**: the signals in "Shared package check", one set per entry in `locks`.
- **CI**: failed → danger "CI failed"; running → neutral "CI running"; ok → success "CI ok".
- **Mergeable**: conflict → danger "conflict"; clean → success "mergeable".
- **Draft**: neutral "draft".
- **Behind**: `behindBy > 0` → neutral "N behind" ("99+ behind" from 100); at least `behindWarn` → warning.
- **Stale**: not updated for more than `staleDays` → warning "stale Nd".
- **Worst problem**, in severity order: conflict > CI failed > base merged: retarget > lock bump due (unpin, then missing) > base has no PR > pinned > stale > behind (warning only) > CI running.
- **Ready**: not a draft, `ci` is `ok` or `none`, `mergeable` is `clean`, and there's no danger or warning signal.
- **Ticket group** (`groupByTicket(prs, tickets)`): the key, its `{label, url, status, summary}`, PRs sorted worst first and then by short name and number, `ready`/`total`, `allMine`, and severity. Groups are sorted danger first, then warning, then by most recent update. PRs with no key go to `noTicket`, and release PRs to `releases`.
- **By repo** (`groupByRepo`) and **attention counts** (`attentionCounts`) are unchanged. Attention: CI failing, Conflicts, Stacked trap, Lock bump due, Stale.

## Collector and polling

There's one collector per project, each with its own caches, last good data, timers and viewer state. All of them share one `http` (its ETag cache is keyed by URL plus auth identity) and one `secrets`.

**Viewed and open.**
- A project is **viewed** while its snapshot was requested within `idleAfterSec`.
- The board is **open** while any API request (a snapshot or `/api/projects`) arrived within `idleAfterSec`.
- The page polls only while its tab is visible, so a hidden tab ends both after `idleAfterSec`.

**Rates.**

| State | Rounds |
|---|---|
| Viewed project | every `intervalSec` (300 s), plus the 15 s follow-up while GitHub mergeability is unknown |
| Project not viewed, board open | every `idleIntervalSec` (3600 s) |
| Board closed | none: a tick skips its round, with no source or auth calls |

A tick of a project that isn't viewed while the board is closed skips its round. The log gets one line when the board closes and one when it opens again, not one per tick.

**Touches.**
- Requesting a project's snapshot starts a round for it (not awaited) when it has no data or its last round finished more than `intervalSec` ago. Opening a project that is on the hourly rate therefore refreshes it at once.
- Any request after the board was closed starts a round for every project whose last round finished more than `idleIntervalSec` ago, or that has no data yet. Tab counts are then fresh, and the tab age covers the rest.
- Rounds of one project never overlap. Different projects run independently.

At start, the board is closed: no round runs until the first request.

Each round runs GitHub and Bitbucket in parallel, then Jira for the keys found, then `derive.enrich`. A failing source keeps its last good PRs per repo, as today. Log lines are prefixed with the project id: `2026-11-09T10:00:00Z acme round github=3 bitbucket=7 tickets=4 812ms rate=4980`. They never contain a token.

## Server

It binds to `127.0.0.1` only, with today's Host/Origin guard.

| Route | Does |
|---|---|
| `GET /` | Redirects to `/p/<first project id>`, or serves the page with the "no projects" state. |
| `GET /p/<id>` | Serves `index.html`. The page reads the id from the URL. An unknown id shows "Unknown project" with links to the others. |
| `GET /api/projects` | The tab data per project: `{ id, title, count, ageMin, rate: 'viewed' \| 'hourly' \| 'paused', error, warnings }`. It marks the board open, but no project as viewed. |
| `GET /api/p/<id>/snapshot` | The project snapshot. It marks the board open and the project viewed. |
| `POST /api/p/<id>/refresh` | 202. Starts a round for that project if none is running. |
| `GET /lib/derive.js` | As today. |
| static `public/` | As today. |

`/api/snapshot` and `/api/refresh` are removed: the page and server ship together, so no compatibility path is needed.

### Snapshot

```js
{
  project: { id, title, hosts: { github: { owner }, bitbucket: { workspace } }, error, warnings: [string] },
  generatedAt, refreshing, rate: 'viewed' | 'hourly' | 'paused', intervalSec,
  nextAt,   // when the next tick fires (ISO), or null without one; re-armed after every round
  sources: { github: { ok, error, fetchedAt }, bitbucket: {...}, jira: {...} },
  prs: [ normalized PR (no description) + { ticketKey, release, signals, worst, ready } ],
  tickets: { 'SHOP-42': { label, url, status, summary } },
  repos: [ { host, repo, repoShort, repoUrl } ],
  fix: { sharedPackages, fixPrompts, fixNotes },    // what fix-prompt.js needs; no secrets
  rateLimit: { github }                               // remaining requests (today's `rate`)
}
```

`fix.sharedPackages` is resolved: `{ repo, repoShort, host, package, defaultBranch, consumers: [{ repo, repoShort, host }] }`.

## Page

Everything from the current page stays (mockup v2): the layout, chips, rows, the 900 px and 560 px rules, collapse, release disclosure, the repo view, the empty, loading and error states, and the `localStorage` toggles. The changes:

- **Project picker.** A tab row above the header, shown only when there are two or more projects. Each tab is a link to `/p/<id>`:
  - its text is `Title (N)`, where N counts *your* PRs (Mine, not release) that have an attention signal, and `(N)` is hidden at 0;
  - a tab on the hourly rate adds the data's age: `Acme (2) · 40 min`;
  - a tab whose project has an error is in the warning colour and shows "!";
  - the current tab is marked with `aria-current="page"`.

  The page polls `/api/projects` on the same schedule as the snapshot.
- **Header.** The title is "`<project title>` pull requests". The muted line reads "updated HH:MM · next HH:MM" on the viewed rate (from `nextAt`), "· every 5 min" without `nextAt`, or "· hourly".
- **Refresh countdown.** On the viewed rate with `nextAt`, the refresh button is the countdown. Its own border drains from full after a round, clockwise from top centre, its end running back counterclockwise until it's empty at `nextAt`. The refresh icon draws its six strokes one after the other over a faint copy (top arc, its arrowhead's two legs, bottom arc, its two legs) and erases them in the same direction, five loops per period, counted from the period's start. While refreshing, a segment chases round the border and the icon spins. With reduced motion the icon stays whole and nothing chases or spins.
- **Banners.** The project error, if any, replaces the content. Warnings (unknown keys, whitelist misses, the Bitbucket cap, ambiguous references) show as one muted list under the attention row. Source errors work as today.
- **By ticket.** Ticket group cards:
  - the header shows the Ticket label as a link (when `url`) with the external-link icon, the Jira summary and status chip (only when the matcher names a Jira site), and "ready N of M";
  - branch groups and "Other PRs" are unchanged.

Polling: the snapshot and `/api/projects` every 30 s (3 s while refreshing), only while the tab is visible, as today. When `nextAt` comes sooner, the page polls one second after it instead, so the countdown hands over to the refreshing state on time.

## Fix prompts

`public/fix-prompt.js` stays pure, with no imports. It loads in `node:test` and the browser. The project and personal parts come in through a `ctx` argument (the snapshot's `fix`), so it holds no project names:

- `promptFor(pr, ctx)`;
- `bundlePrompt(prs, groupLabel, ctx)`;
- `FIXABLE_KINDS` (unchanged: `conflict`, `ci-failed`, `base-retarget`, `base-no-pr`, `lock-unpin`, `lock-missing`, `lock-pinned`);
- `fixableSignals`, `fixSeverity`.

### Layers

1. **Defaults** are host-generic. They name the host and its CLI, never a project or a tool choice. The host label is `GitHub <owner>` or `Bitbucket <workspace>`.
2. **Project conventions**: a non-empty `fixPrompts.<kind>` renders as a `Project convention: …` line right under that kind's step, indented to the step. It narrows how the step is done and never replaces it. There's no replace mode.
3. **Fix notes**: the person's `fixNotes` render as one closing `My setup: …` paragraph, last in the prompt: `all` first, then the note for each host present in the prompt, in the order github, bitbucket. With no notes, there's no paragraph.

### Default steps

| Kind | Default text (`{…}` from the PR, the project or `sharedPackages`) |
|---|---|
| `conflict` | Merge conflict with `{target}`: fetch, check out `{source}`, merge `origin/{target}` (merge, not rebase), resolve keeping the intent of both sides, run the repo's tests, push. |
| `ci-failed` (GitHub) | CI failed. Read the failing run: `gh run list -R {owner}/{repo} --branch {source} --limit 5`, then `gh run view <id> -R {owner}/{repo} --log-failed`. Find the root cause; if it's flaky or infra, tell me instead of retrying blindly. Push. |
| `ci-failed` (Bitbucket) | CI failed. Read the failing pipeline from the PR's build status. Find the root cause; if it's flaky or infra, tell me instead of retrying blindly. Push. |
| `lock-missing` | Lock bump due: {shared repo} PR(s) #{n} ({url}) merged to `{shared default}`, but {consumer}'s composer.lock still references `{lockRef}`. Update {package} in {consumer}'s lock to {shared repo}'s current `{shared default}` head, then push and let CI build. |
| `lock-unpin` | composer.json requires `{constraint}`, but {shared repo} PR #{n} is merged: set the constraint back to `dev-{shared default}`, then update {package} in {consumer}'s lock to {shared repo}'s current `{shared default}` head. Push and let CI build. |
| `lock-pinned` | composer.json requires `{constraint}` (a branch of {shared repo}), and no {shared repo} PR was found for it: find out whether that branch was merged, renamed or abandoned, and report back before changing anything. |
| `base-retarget` | Stacked trap: this PR targets `{target}`, whose PR #{n} is {state}. First check the base really reached `{default}`; then retarget this PR to `{default}` (GitHub: `gh pr edit {number} -R {owner}/{repo} --base {default}`), merge `{default}` into `{source}`, resolve, push. |
| `base-no-pr` | This PR targets `{target}`, which has no PR of its own: find out whether `{target}` needs a PR or this one should target `{default}`, and ask me before retargeting. |

Today's "a real bug is fixed test-first" and the "no Checks permission" note are dropped. The first belongs in each repo's AGENTS.md. The second no longer applies: `gh run` works without Checks.

The header lines stay as today (`PR:`, `Title:`, `Repo: {repo} ({host label})`, `Branch:`, `Also: N behind`, and `Owner:` when the PR isn't mine).

The closing paragraph is fixed and not configurable: "Read the repo's AGENTS.md or CLAUDE.md first, if present, and follow it. Work in a worktree if the checkout has other work in progress. Never force-push. Report what you changed, the commit, and the CI result after the push."

### "Fix all" order

The order is derived from `sharedPackages`, with no repo names in code:
1. shared package repos;
2. their consumers;
3. the rest.

Board order is kept within each tier. The ordering line names the repos it put first:
- with shared packages in the group: "Work in this order: shared (shared package) first, then its consumers (backend, worker), then the rest. One commit per repo."
- without: "One commit per repo."

A non-empty `fixPrompts.group` renders as `Project convention: …` right after the ordering line.

### Canonical example

The project is `projects/example.json` (above). The PR is `backend #12`, mine, on Bitbucket, Ticket `SHOP-42`. `acme-shared` PR #7 (same Ticket) is merged, but the lock still points at `3f2a9c1e…`. The fix notes are as in the personal config example. `promptFor` renders:

```
Fix backend #12 (lock bump due: shared #7).

PR: https://bitbucket.org/acme/acme-backend/pull-requests/12
Title: SHOP-42 Add invoice export
Repo: acme-backend (Bitbucket acme)
Branch: feature/SHOP-42-invoice-export → develop

1. Lock bump due: acme-shared PR(s) #7 (https://bitbucket.org/acme/acme-shared/pull-requests/7) merged to `develop`, but acme-backend's composer.lock still references `3f2a9c1e`. Update acme/shared in acme-backend's lock to acme-shared's current `develop` head, then push and let CI build.
   Project convention: Edit only `reference` and `time` of the package in composer.lock, and only if its composer.json is unchanged between the two commits; otherwise stop and tell me. Git only, no local composer run.

Read the repo's AGENTS.md or CLAUDE.md first, if present, and follow it. Work in a worktree if the checkout has other work in progress. Never force-push. Report what you changed, the commit, and the CI result after the push.

My setup: Read pipelines through the Atlassian MCP.
```

For the Ticket group `SHOP-42`, `bundlePrompt` renders the same blocks for `shared #7` (CI failed), `backend #12` and `worker #31` (both lock bump due), in that order:

```
Unblock the PRs of SHOP-42:
- shared #7: CI failed
- backend #12: lock bump due: shared #7
- worker #31: lock bump due: shared #7

Work in this order: shared (shared package) first, then its consumers (backend, worker), then the rest. One commit per repo.
Project convention: Wait for CI on the shared package before you update a lock.

## shared #7
…

## backend #12
…

## worker #31
…

Read the repo's AGENTS.md or CLAUDE.md first, …

My setup: Read pipelines through the Atlassian MCP.
```

Both are golden tests in `test/fix-prompt.test.js`.

## CI

`.github/workflows/test.yml` runs `npm test` on `ubuntu-latest`, `macos-latest` and `windows-latest` with Node 22, on push and PR, with `permissions: contents: read` and no secrets. `.gitattributes` sets `* text=auto eol=lf`.

OS-specific code (the config dir, the secret chain, the installer) is tested by injecting `platform`, `env`, `homedir` and a fake `execFile`, the same pattern as the injected `http`. No test spawns `security`, `secret-tool`, `powershell.exe`, `launchctl`, `systemctl` or `schtasks`, and no test makes a live HTTP call. The matrix catches path separators and line endings.

## Migration from the single-project board

The current board serves one project from a local repo with no remote, under a launchd label of its own. It moves onto the generic board like this. The project-specific values (real project file, token references, email, label, the customer-data deny list) are in the author's private cutover doc, which is never published.

1. **Generalise on a branch.** The work happens on a branch, in a worktree of the existing repo, while `main` keeps serving the live board.
2. **Customer-data scrub.** Before the first push, a grep over every tracked file of the branch for the deny list in the private cutover doc (org, workspace and repo names, the Jira cloud id, people's names) must return nothing. Fixtures are made up from the start. The scrub is a check, not an edit pass. Untracked files (`.scratch/`) are never published.
3. **Publish.** A new public GitHub repo `pr-board` on the author's personal account. One squashed commit of the tracked tree, with `LICENSE` (MIT, `Copyright (c) 2026 Sander Houttekier`) and `"license": "MIT"` in `package.json`. The history isn't kept. From then on `pr-board` is the only source of truth, and the old repo is a frozen local archive.
4. **Parity check.** Clone `pr-board`, write the personal config and the real project file by hand, and run `PORT=7420 npm start` next to the old board on 7419. Acceptance: same PRs, same groups (old "feature" = new Ticket), same signals.
5. **Cutover.** Uninstall the old agent with the old repo's uninstall script, run `node scripts/install.js` from the clone, and the port goes back to 7419. There's no migration code. The new label never collides with the old one.

## Definition of done (v1)

- `npm test` is green locally, and on the 3-OS matrix once the repo is public.
- `projects/example.json` validates, and the canonical fix prompts match their golden tests.
- The parity check passes for the migrated project on 7420.
- On macOS, `node scripts/install.js` installs an agent that survives a reboot and refuses when a token reference is missing. Linux and Windows paths are marked untested in the README.
- Steady state stays under ~1,500 counted GitHub requests an hour and ~1,000 Bitbucket requests an hour for one viewed project.
- No token is in any file, log line or snapshot, and the customer-data scrub returns nothing.
