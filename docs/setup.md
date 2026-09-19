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

## What `dev init` creates

With no arguments, `dev init` guides the complete setup. It offers `~/dev` as an editable path, detects when you are already inside a dev root, and lets you update that root or create another one. It can then add providers and synchronizes their repository inventory before returning.

After choosing the path, it writes `dev.yaml` and a root-scoped `AGENTS.md`, then registers the root in `~/.dev.toml`.

`dev.yaml` is the root configuration: defaults, providers, sources, labels, worksets, hooks, and plugins. Generated repositories and caches do not belong there.

```text
~/dev/
├── dev.yaml
├── AGENTS.md # instructions only for this dev root and its descendants
├── ws/       # task workspaces; each contains ws.md and isolated worktrees
├── mirrors/  # reference checkouts managed by dev
└── .dev/     # bare mirrors, worktree admin repositories, caches; rebuildable
```

Work inside `ws/`. Do not edit `mirrors/` or `.dev/` directly. Directories are created when first needed. `AGENTS.md` is not a global machine or user configuration, and running `dev init` again does not overwrite it.

Every repository is cloned once, as a bare mirror under `.dev/git/<host>/<owner>/<repo>.git`. Workspace mounts and `mirrors/` checkouts are Git worktrees on that clone, so the same repository in ten workspaces is downloaded once.

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

`dev go` pipes its candidates through [fzf](https://github.com/junegunn/fzf); install it for the picker. `dev go <query>` with a unique match skips the picker.

When `dev` is not on your `PATH` but a checkout is, generate wrappers that run it through Mise:

```bash
eval "$(mise run dev -- shell-init zsh --runner mise)"
```
