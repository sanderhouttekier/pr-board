# PR board

A local page that keeps the open pull requests of one or more projects in view, grouped by the work they belong to, with the status that decides whether each can be merged.

## Language

**Board**:
The one running page a person uses; it shows several projects, one at a time.
_Avoid_: dashboard, instance

**Project**:
A named set of repositories, with the ticket conventions and checks that apply to them, shown as one tab on the board.
_Avoid_: workspace, client, board

**Project file**:
A shareable JSON file that describes one project: what its team agrees on, never anything about one person.

**Personal config**:
One person's own JSON file in their config dir: port, timings, token references, the project files to load, credential overrides and fix notes.

**Ticket**:
The unit of work a PR belongs to, named by a ticket key from a tracker the project uses.
_Avoid_: feature, story, issue

**Ticket key**:
The normalised name of a ticket found in a PR (`SHOP-42`, or a card URL for a link matcher), used to group PRs.

**Ticket matcher**:
A project file rule that finds a ticket key in a PR: a prefix (searched in the branch, then the title) or a link (searched in the description).

**Ticket group**:
The PRs of one project that share a ticket key, shown as one card.

**Branch group**:
Ticketless PRs in two or more repositories of a project that share the exact same source branch.

**Shared package**:
A repository whose package is consumed by other repositories of the same project, so its merges make lock updates due in those consumers.
_Avoid_: pkg, command package

**Consumer**:
A repository that locks a shared package and must have its lock updated after the package changes.

**Token reference**:
The name a token is stored under in a secret store; it never holds the token itself.

**Credential override**:
A token reference set for one project that takes precedence over the global one for the same host.

**Autostarted board**:
A board the operating system starts at login, rather than one started from a terminal; it only gets tokens from a secret store, never from the person's shell environment.

**Fix prompt**:
Text the board builds for a PR with a fixable signal, ready to paste into an AI coding agent: one step per signal, then a closing instruction.

**Project convention**:
Text a project agrees on that is added under a fix prompt step to narrow how that step is done; it never replaces the step.
_Avoid_: override

**Fix note**:
A person's own text about their tooling for one host, added at the end of their fix prompts; a fallback for what their own agent instructions don't cover.
_Avoid_: personal convention
