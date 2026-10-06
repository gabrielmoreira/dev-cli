# Setup

How to install `dev`, initialize roots, provide credentials, and wire the shell. The [README](../README.md) covers the main workflows; the [command reference](commands.md) covers every flag.

## Install

The primary installation method is [Mise](https://mise.jdx.dev/):

```bash
mise use -g github:gabrielmoreira/dev-cli
```

### Direct installers

macOS and Linux:

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/gabrielmoreira/dev-cli/releases/latest/download/dev-installer.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/gabrielmoreira/dev-cli/releases/latest/download/dev-installer.ps1 | iex
```

The installers select the matching binary, verify its SHA-256 checksum, and add it to `PATH`. Set `DEV_INSTALL_DIR` to choose another directory or `DEV_NO_MODIFY_PATH=1` to leave `PATH` unchanged.

### Manual installation

Download the archive for your platform and `SHA256SUMS` from [Releases](https://github.com/gabrielmoreira/dev-cli/releases). Verify the archive before extracting it:

Linux:

```bash
ASSET=dev-linux-x64.tar.gz # use the archive you downloaded
grep "  $ASSET$" SHA256SUMS | sha256sum --check
```

macOS:

```bash
ASSET=dev-darwin-arm64.tar.gz # use the archive you downloaded
grep "  $ASSET$" SHA256SUMS | shasum -a 256 --check
```

Windows PowerShell:

```powershell
$Asset = "dev-windows-x64.zip" # use the archive you downloaded
$expected = (Get-Content SHA256SUMS | Where-Object { $_ -match "  $([regex]::Escape($Asset))$" }).Split()[0]
$actual = (Get-FileHash $Asset -Algorithm SHA256).Hash
if ($actual -ne $expected) { throw "Checksum mismatch" }
```

Extract the archive and move `dev` or `dev.exe` to a directory on `PATH`.

## Use `dev` in scripts

Global `--json`, `--quiet` (`-q`), and `--non-interactive` flags work before or after the command group. `dev --json ws ls` and `dev ws ls --json` return the same JSON. Answers go to stdout; errors go to stderr, including JSON errors. `--quiet` hides narration, not answers or errors.

Boolean flags accept `--json=true`, `--json=false`, and `--no-json`; the same spellings apply to `--quiet` and `--non-interactive`. JSON and non-interactive modes never prompt. Flags after `--` belong to the forwarded command, not to `dev`.

On `ws status`, `ws update`, `ws path`, `ws jump`, and `pr list`, a positional selector and `--ws` or `--repo` must name the same target when you pass both. A `ws.md` path counts as its workspace's name. Different targets fail with `CONFLICTING_OPTIONS` and exit 2 before anything is fetched or changed; pass one selector, or the same one twice. Argument names are in the [command reference](commands.md).

`label add --json` retains `sources` for the requested repositories and separates changed assignments in `added` from identical assignments in `unchanged`; each entry includes its URL, ref/path and effective metadata. `init --json` returns `created` for a new dev.yaml and `changed` for configuration creation, an instructions write or a registry change. Its `agentsCreated`, `agentsUpdated`, `agentsManaged`, `registrationChanged`, and `defaultRootChanged` fields identify those effects: `agentsCreated` means the root `AGENTS.md` was written, `agentsUpdated` means its dev block was replaced, and `agentsManaged` is false when the file exists without one unambiguous dev block, which is the file `dev` leaves alone.

A coding agent driving `dev` has three surfaces. `dev --help --llms` is the whole command tree, with exit codes and error codes, as JSON, and its `resources` list names what to read for each kind of task. `dev skill` prints the instructions for an agent operating a dev root, with `--json` returning the same text as `name`, `description` and `content`. When the shell carries a marker a coding agent sets (`AI_AGENT`, `AGENT`, `CLAUDECODE`, `CLAUDE_CODE`, `CURSOR_AGENT`, `CODEX_SANDBOX`, `GEMINI_CLI`), `dev --help` ends with that same resource list; a command result, `--json` and `--quiet` never carry it. The skill file lives at [skills/dev/SKILL.md](https://github.com/gabrielmoreira/dev-cli/blob/main/skills/dev/SKILL.md) for agents that read it from the repository.

## What `dev init` creates

With no arguments, `dev init` guides the complete setup. It offers `~/dev` as an editable path, detects when you are already inside a dev root, and lets you update that root or create another one. It can then add providers and synchronizes their repository inventory before returning.

After choosing the path, it writes `dev.yaml` and a root-scoped `AGENTS.md`, then registers the root in `~/.dev.toml`. If you edit this registry, write Windows paths with forward slashes (`path = "C:/dev"`) or valid TOML escaping (`path = "C:\\dev"`). When `dev` reads an invalid registry, it reports the file to fix instead of falling back to `~/dev`.

If a root alias already points to another directory, `dev init <path> --alias <alias>` refuses before creating files. Use `--force` to replace that registration; it does not delete either root's files. An explicit alias also selects the global default, and init reports when that default changes.

The registry accepts an optional string `default_root` and a `roots` table whose alias entries are tables with a string `path`. Invalid value types produce the same `INVALID_GLOBAL_TOML` error as invalid syntax; the diagnostic names the file without printing its contents.

`dev.yaml` is the root configuration: defaults, providers, sources, labels, worksets, hooks, and plugins. Generated repositories and caches do not belong there.

```text
~/dev/
├── dev.yaml
├── AGENTS.md # instructions only for this dev root and its descendants
├── ws/       # task workspaces; each contains ws.md and isolated worktrees
├── mirrors/  # reference checkouts managed by dev
└── .dev/     # bare mirrors, worktree admin repositories, caches; rebuildable
```

Work inside `ws/`. Do not edit `mirrors/` or `.dev/` directly. Directories are created when first needed. `AGENTS.md` is not a global machine or user configuration. Running `dev init` again preserves an existing `dev.yaml`. The root `AGENTS.md` is written between `<!-- dev:begin -->` and `<!-- dev:end -->` markers: `dev init` replaces that block, whose notice says so, and every byte outside the markers survives untouched. A file with no markers, or with duplicated ones, belongs to whoever wrote it and is never rewritten; `dev init` reports `agentsManaged: false` and prints the remedy. Concurrent initializations do not replace a configuration created by another initializer.

Repeating an identical initialization reports that the root is already configured. A new alias/default, a missing instructions file, or a dev block whose text changed is reported as an update rather than a no-op.

Results use `✓` for a completed action, `○` for a fact or an already-applied request, `⚠` for a caveat, `✗` for a failure, and `↳` for the next command. Fetching and other progress use `↻` on stderr; JSON carries the same state without presentation symbols.

Every repository is cloned once, as a bare mirror under `.dev/git/<host>/<owner>/<repo>.git`. Workspace mounts and `mirrors/` checkouts are Git worktrees on that clone, so the same repository in ten workspaces is downloaded once.

`dev ws remove <mount> --yes` skips confirmation but refuses uncommitted changes, unpushed commits, and unmanaged checkouts. `dev mirror untrack <repository> <branchName> --yes` skips confirmation but refuses modified or untracked files. Use `--force` only when you intend to remove those checkouts despite the named hazard; it also skips confirmation.

`dev ws update --rebase` rolls back a conflicting rebase. If Git rejects the operation before a rebase starts, such as a failing `pre-rebase` hook, the command reports the original Git failure instead of attempting an abort.

## Access and credentials

`provider add` records where to look. It does not grant access or save a token. Your account needs permission to list repositories and clone each private source; `dev ws add` itself needs no write permission.

| Provider     | Credential order for API calls                                                   |
| ------------ | -------------------------------------------------------------------------------- |
| Azure DevOps | `AZURE_DEVOPS_PAT`, token in `dev.yaml`, current `az login` session              |
| GitHub       | `GITHUB_TOKEN`, `GH_TOKEN`, token in `dev.yaml`, current `gh auth login` session |

Prefer CLI sessions or environment variables. Do not commit tokens to `dev.yaml`. Run `dev doctor` to see which source was selected.

Clone authentication is separate. Azure DevOps credentials can be sent as a temporary HTTP header; GitHub clones use your Git credential helper or SSH agent. If `git clone <repository-url>` works, `dev ws add` can use the same access. `--consent` permits repository hooks; it does not grant repository permissions.

## Several roots

For separate clients or contexts, create more roots and select the default:

```bash
dev init ~/work/client-a --alias client-a
dev init ~/work/labs --alias labs
dev roots
dev use client-a --global
```

Each root has its own repositories, workspaces, providers, labels, and configuration. `dev current` prints the root in use and how it was chosen; `--root <path>` and `$DEV_ROOT` override it for one command or one shell.

## Shell integration

`dev go` and `dev ws jump` print a path. The shell wrapper turns that into a `cd`:

```bash
eval "$(dev shell-init bash)"
eval "$(dev shell-init zsh)"
dev shell-init fish | source
Invoke-Expression (dev shell-init powershell | Out-String)
```

`shell-init` accepts `bash`, `zsh`, `fish`, `powershell`, and `pwsh`; omit the shell to use PowerShell on Windows or bash elsewhere. `--runner` accepts `direct` or `mise` and defaults to `direct`. An unsupported shell or runner exits 2 with `INVALID_ARGUMENT`, the supported choices, and `dev shell-init --help`; `--json` returns that error on stderr.

`dev go` asks with a fuzzy-searchable list when several workspaces match; `dev go <query>` with a unique match skips the question.

Prompts use stderr. When your shell captures stdout, keep stdin and stderr attached to the terminal; the captured value contains only the command's answer. JSON, CI, and non-interactive mode never prompt.

`dev ws jump` uses the configured workspace prefix and returns `WORKSPACE_NOT_FOUND` for missing or non-directory targets without printing a path or recording recent use.

`dev ws path` also uses `defaults.workspace_prefix` from `dev.yaml`. Shell wrappers use this resolved path for workspace-name shortcuts, including roots configured with a custom prefix.

Workspace shortcuts only change directory when the resolved path exists. Otherwise, the wrapper runs the original CLI command so its error and exit code reach your shell.

When `dev` is not on your `PATH` but a checkout is, generate wrappers that run it through Mise:

```bash
eval "$(mise run dev -- shell-init zsh --runner mise)"
```
