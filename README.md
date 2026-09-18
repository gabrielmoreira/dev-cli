# dev

One change often spans several repositories. `dev` gives that work one directory,
one manifest, and repeatable Git state instead of a pile of manual clones.

Each workspace mounts isolated worktrees from shared mirrors. You can see what
changed, update only safe branches, and resume later with the same context.

## Install

Install the latest release globally with Mise:

```bash
mise use -g github:gabrielmoreira/dev-cli
dev --help
```

---

## Quick start

```bash
dev init
dev provider add
dev sync inventory

dev ws init payment-fix --desc "Investigate payment retries"
cd ~/dev/ws/payment-fix
dev ws add

dev status
dev sync
```

`provider add`, `ws add`, and `ws init` prompt for missing values in an
interactive terminal. Pass explicit arguments in scripts.

---

## What `dev init` creates

With no path, `dev init` creates `~/dev`, writes `dev.yaml` and `AGENTS.md`, and
registers the root in `~/.dev.toml`.

`dev.yaml` is the root configuration: defaults, providers, sources, labels,
hooks, and plugins. Generated repositories and caches do not belong there.

```text
~/dev/
├── dev.yaml
├── ws/       # task workspaces; each contains ws.md and isolated worktrees
└── mirrors/  # canonical reference checkouts managed by dev
```

Work inside `ws/`. Do not edit `mirrors/` directly. Directories are created when
first needed.

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

## Commands

| Command                         | What it does                                                       |
| ------------------------------- | ------------------------------------------------------------------ |
| `dev ws create [name]`          | Create a workspace; prompt for missing useful context              |
| `dev ws add [name\|url]`        | Mount a repo into the current or selected workspace                |
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
| `dev qmd sync [label]`          | Reconcile QMD collections from repository labels                   |
| `dev root add\|remove <target>` | Register or unregister a root without deleting its files           |
| `dev provider list`             | Show configured providers                                          |
| `dev doctor`                    | Check environment, tools, and credential status                    |

---

## Highlights

### Open the right OMP in HerdR

From a HerdR pane, start work without manually recreating terminal context:

```bash
dev ws start payment-fix
```

`dev` uses the dev workspace directory as the pane working directory. It focuses an
existing ready OMP for that workspace, starts OMP in an available matching pane, or
creates the HerdR workspace and agent when neither exists.

### Build QMD collections from repository labels

Turn every source carrying a label into a reconciled QMD collection:

```bash
dev qmd sync docs
dev qmd sync docs --noEmbed # lexical-only indexing, useful in CI
```

For QMD commands outside the managed sync flow, use
`dev qmd x <qmd-arguments>`; `dev` supplies the scoped registry environment.

---

## Advanced usage

Run `dev --help` for the human-oriented command reference or `dev --help --llms`
for structured command metadata. The CLI covers revision lifecycle, safe update
strategies, mirrors, providers, offline mode, multiple roots, hooks, and shell
integration.
