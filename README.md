# dev

Fast developer CLI for multi-repository workspaces.

## Install

Install the latest release globally with Mise:

```bash
mise use -g github:gabrielmoreira/dev-cli
dev --help
```

---

## 1. Setup (once)

Register where your repositories live. In an interactive terminal, `dev provider add`
asks for the provider type and required organization or owner. Scripts should pass
those values explicitly:

```bash
dev provider add ado --org my-org        # Azure DevOps
dev provider add github --owner my-user  # GitHub
```

Pull the repository catalog locally (enables name-based search):

```bash
dev sync inventory
```

Enable parent-shell navigation once in your shell profile:

```bash
eval "$(dev shell-init zsh)"
```

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

## 2. Start a workspace

`dev ws create` asks for a name and an optional description in an interactive
terminal. The explicit form remains suitable for scripts:

```bash
dev ws create
dev ws init payment-fix --desc "Investigate payment retries"
cd ~/dev/ws/payment-fix
```

Mount the repositories you need. With no source, the interactive command shows
the default branch and generated path for every selected repository. Choose only
the mounts you want to customize, set branch before path, and optionally add
more branches from the same repository as distinct worktrees:

```bash
dev ws add
dev ws add alpha-service           # from local catalog
dev ws add billing-api --branch feature/v2
dev ws add https://github.com/org/repo
```

Each mount is an isolated Git worktree identified by its path. A repository may
appear more than once with different branches and unique paths; all mounts reuse
the same central mirror.

Outside a workspace, commands that need one select the sole candidate or show a
picker. Use `--ws <name>` for deterministic automation; it is accepted before or
after root shortcuts such as `dev status`.

---

## 3. Daily workflow

```bash
dev status           # compare manifest vs disk (fast, offline)
dev sync             # fast-forward clean mounts to latest
```

That's it for 80% of daily use.

---

## 4. Key commands

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

## 5. Directory layout

Everything lives inside `$DEV_ROOT` (default: `~/dev`):

```
~/dev/
├── ws/          ← your task workspaces
│   └── payment-fix/
│       ├── ws.md          ← workspace manifest (edit this)
│       ├── alpha-service/ ← git worktree
│       └── billing-api/   ← git worktree
├── mirrors/     ← canonical reference checkouts with commit guards
└── .dev/
    ├── sources/ ← shared bare git mirrors (one per repo)
    ├── admin/   ← workspace admin bares (refs + worktree metadata)
    └── cache/   ← offline index: repos, PRs, work items
```

Use a custom root:

```bash
export DEV_ROOT=/d/work/dev   # or: dev --root /d/work/dev <command>
```

---

## Advanced usage

Run `dev --help` for the human-oriented command reference or `dev --help --llms`
for structured command metadata. The CLI covers revision lifecycle, safe update
strategies, mirrors, providers, offline mode, multiple roots, hooks, and shell
integration.
