# dev

A change often touches more than one repository. `dev` creates one workspace for
the task, brings the repositories you need into it, remembers what each checkout
should track, and updates clean checkouts safely.

The result: one place to work, inspect, pause, and resume without rebuilding the
setup by hand.

## Install

Install the latest release globally with Mise:

```bash
mise use -g github:gabrielmoreira/dev-cli
dev --help
```

---

## Quick start

```bash
# Choose where dev keeps your work and connect GitHub or Azure DevOps.
dev init

# Create a task workspace; dev asks for its name and objective.
dev ws init

# Choose the repositories needed for that task.
dev ws add

# Inspect local state, then update only clean checkouts.
dev status
dev sync
```

No configuration vocabulary is required up front: each command asks for the
missing information.

### Example: contribute to Oh My Pi

Paste a repository URI into `ws init`. `dev` derives a provider-prefixed workspace
name, creates it, and mounts the repository in one command:

```bash
dev ws init https://github.com/can1357/oh-my-pi --desc "Contribute to Oh My Pi"
cd ~/dev/ws/gh-can1357-oh-my-pi
```

The repository is an isolated worktree ready for code review, local changes,
tests, and a contribution branch. The URI may use any Git-supported scheme, such
as `https:`, `http:`, `ssh:`, `git:`, or `file:`.

---

## What `dev init` creates

With no arguments, `dev init` guides the complete setup. It offers `~/dev` as an
editable path, detects when you are already inside a dev root, and lets you update
that root or create another one. It can then add providers and synchronizes their
repository inventory before returning.

After choosing the path, it writes `dev.yaml` and a root-scoped `AGENTS.md`, then
registers the root in `~/.dev.toml`.

`dev.yaml` is the root configuration: defaults, providers, sources, labels,
hooks, and plugins. Generated repositories and caches do not belong there.

```text
~/dev/
├── dev.yaml
├── AGENTS.md # instructions only for this dev root and its descendants
├── ws/       # task workspaces; each contains ws.md and isolated worktrees
└── mirrors/  # canonical reference checkouts managed by dev
```

Work inside `ws/`. Do not edit `mirrors/` directly. Directories are created when
first needed. `AGENTS.md` is not a global machine or user configuration.

For separate clients or contexts, create more roots and select the default:

```bash
dev init ~/work/client-a --alias client-a
dev init ~/work/labs --alias labs
dev roots
dev use client-a --global
```

To let `dev go` change the parent shell's directory:

```bash
eval "$(dev shell-init zsh)"
```

---

## Access and credentials

`provider add` records where to look. It does not grant access or save a token.
Your account needs permission to list repositories and clone each private source;
`dev ws add` itself needs no write permission.

| Provider     | Credential order for API calls                                                   |
| ------------ | -------------------------------------------------------------------------------- |
| Azure DevOps | `AZURE_DEVOPS_PAT`, token in `dev.yaml`, current `az login` session              |
| GitHub       | `GITHUB_TOKEN`, `GH_TOKEN`, token in `dev.yaml`, current `gh auth login` session |

Prefer CLI sessions or environment variables. Do not commit tokens to `dev.yaml`.
Run `dev doctor` to see which source was selected.

Clone authentication is separate. Azure DevOps credentials can be sent as a
temporary HTTP header; GitHub clones use your Git credential helper or SSH agent.
If `git clone <repository-url>` works, `dev ws add` can use the same access.
`--consent` permits repository hooks; it does not grant repository permissions.

---

## Workspace model

`dev ws add` mounts each repository as an isolated Git worktree. Repositories may
appear more than once on different branches and paths while sharing one mirror.

```bash
dev ws add alpha-service
dev ws add billing-api --branch feature/v2
dev ws add https://github.com/org/repo
```

Outside a workspace, `dev` selects the sole candidate or shows a picker. Use
`--ws <name>` for deterministic scripts.

The daily loop stays small:

```bash
dev status # compare manifest and disk, offline
dev sync   # fast-forward safe mounts
```

---

## Mirrors and labels

A mirror is `dev`'s shared canonical checkout of a repository. Workspaces reuse
it to create isolated worktrees, so the same repository does not need a full
clone for every task.

```bash
dev mirror add https://github.com/can1357/oh-my-pi
dev mirror label add oh-my-pi docs
dev mirror list --label docs
```

A label is reusable metadata attached to a declared repository source. It turns
repository lists into named sets: `dev pr --label docs` queries their pull
requests, while `dev qmd sync docs` indexes them as QMD collections. `dev ws add`
can select several repositories interactively, but does not filter that picker by
label today.

---

## Commands

| Command                         | What it does                                                       |
| ------------------------------- | ------------------------------------------------------------------ |
| `dev ws init [name\|URI]`       | Create a blank workspace or create and mount one repository        |
| `dev ws add [name\|URI]`        | Mount a repository into the current or selected workspace          |
| `dev ws start [name]`           | Start or focus OMP in HerdR for a workspace                        |
| `dev status`                    | Show mount status (clean / dirty / ahead / behind)                 |
| `dev sync`                      | Update the current workspace, or sync inventory outside it         |
| `dev ls`                        | List all workspaces (`dev ws list` also works)                     |
| `dev go [query]`                | Fuzzy-select a workspace by recent creation and change directory   |
| `dev ws remove [mount]`         | Select and confirm a mount (`--force` with explicit input in CI)   |
| `dev pr`                        | Show open pull requests assigned to the authenticated reviewer     |
| `dev pr -i`                     | Select one repository, then show its pull requests                 |
| `dev pr --label <label>`        | Show pull requests for a reusable dev-cli repository workset       |
| `dev wi`                        | Show cached work items; `--refresh` selects a provider and project |
| `dev qmd sync [label]`          | Build QMD collections from sources carrying the selected label     |
| `dev root add\|remove <target>` | Register or unregister a root without deleting its files           |
| `dev provider list`             | Show configured providers                                          |
| `dev doctor`                    | Check environment, tools, and credential status                    |

---

## Optional integrations

`dev` can connect three independent tools:

- [OMP](https://omp.sh) is the coding agent opened for a dev workspace.
- [HerdR](https://herdr.dev) keeps agent terminals organized and running.
- [QMD](https://github.com/tobi/qmd) is a local search engine for documentation
  and knowledge bases.

### Open the right OMP in HerdR

Install OMP and HerdR if you do not have them yet:

```bash
mise use -g github:can1357/oh-my-pi
mise use -g herdr
```

On Windows, install HerdR from PowerShell instead:

```powershell
irm https://herdr.dev/install.ps1 | iex
```

Then open OMP in the workspace created above:

```bash
dev ws start gh-can1357-oh-my-pi
```

`dev` uses the dev workspace directory as the pane working directory. It focuses an
existing ready OMP for that workspace, starts OMP in an available matching pane, or
creates the HerdR workspace and agent when neither exists.

### Search labeled repositories with QMD

QMD syncs one repository label at a time. First declare the mirror, then attach
any label meaningful to you; `docs` is an example, not a reserved convention:

```bash
dev mirror add https://github.com/can1357/oh-my-pi
dev mirror label add oh-my-pi docs
```

`mirror label add` is explicit rather than interactive: it expects a declared
source (its inventory name or URI) and a label. Optional metadata follows as a
comma-separated `key=value` argument when the label definition requires fields.

Now reconcile every source carrying `docs` into one QMD collection per repository:

```bash
dev qmd sync       # choose among known labels in an interactive terminal
dev qmd sync docs  # select docs explicitly; deterministic for scripts
dev qmd sync docs --noEmbed # skip vector embeddings; lexical search only
```

For this example, the collection is `docs--oh-my-pi`. Sync removes stale
`docs--*` collections, adds missing ones, updates the index, and embeds it unless
`--noEmbed` is set.

Add QMD context or pass any other QMD arguments through `dev qmd x`. These commands
use the same QMD registry, scoped to this dev root by default:

```bash
dev qmd x context add qmd://docs--oh-my-pi "OMP source, architecture, and contributor documentation"
dev qmd x query "how are tools registered?" -c docs--oh-my-pi --json -n 10
dev qmd x status
```

Everything after `dev qmd x` is passed to QMD unchanged. See the
[QMD command reference](https://github.com/tobi/qmd#quick-start) for available
commands and flags.

---

## Advanced usage

Run `dev --help` for the human-oriented command reference or `dev --help --llms`
for structured command metadata. The CLI covers revision lifecycle, safe update
strategies, mirrors, providers, offline mode, multiple roots, hooks, and shell
integration.
