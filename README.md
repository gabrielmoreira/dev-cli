# dev

[![Release](https://img.shields.io/github/v/release/gabrielmoreira/dev-cli)](https://github.com/gabrielmoreira/dev-cli/releases)
[![Release](https://github.com/gabrielmoreira/dev-cli/actions/workflows/release.yml/badge.svg)](https://github.com/gabrielmoreira/dev-cli/releases)

**One folder per task. Every repository the task needs, on the branch it needs, and a note of where you left off.**

`dev` organizes local development around tasks instead of clones. A feature, a PR review and an incident can be open at the same time, each in its own workspace, and none of them touches the others. It also puts your pull requests and work items in the terminal, searches documentation across every repository you keep, and gives a coding agent a folder that already knows what the task is. Works with GitHub and Azure DevOps.

## See it in action

![dev CLI terminal demo](docs/assets/dev-cli-demo.gif?v=v2.1.0)

Under three minutes from `dev init`: a workspace from one URL, an incident workspace built from a workset, a jump with `dev go`, and a coding agent answering from the indexed docs. [MP4 with playback controls](docs/assets/dev-cli-demo.mp4).

## Why

Most days touch more than one repository and more than one task. The feature you are building spans an app and its API. Someone asks for a review on that same API. Then the checkout service pages you, and you need it next to the infrastructure repo and the runbooks.

Each of those wants the same repositories on different branches. One clone per repository means stash, switch, and lose your place. One clone per task means a disk full of folders whose purpose you forget by Thursday.

`dev` gives each task a workspace: a folder with a Git worktree for every repository the task needs and a `ws.md` that records what the task is, what is mounted, and where you stopped. Repositories are cloned once and shared, so a fifth workspace of the same repository costs a worktree, not a download.

## Install

`dev` is a single binary for macOS, Linux and Windows. Install it with [Mise](https://mise.jdx.dev/):

```bash
mise use -g github:gabrielmoreira/dev-cli
```

Direct installers are also available.

macOS and Linux:

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/gabrielmoreira/dev-cli/releases/latest/download/dev-installer.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/gabrielmoreira/dev-cli/releases/latest/download/dev-installer.ps1 | iex
```

The installers verify the downloaded binary against the published SHA-256 checksums. See the [setup guide](docs/setup.md#install) for custom and manual installation.

## Quick start

After installing `dev` with any method, run the interactive setup:

```bash
dev init
```

`dev init` asks where to keep your work (`~/dev` by default) and whether to connect a GitHub owner or an Azure DevOps organization. A provider is optional. With one, `dev` knows your repositories, so the pickers, `dev pr` and `dev wi` have something to show. Without one, you give it URLs. It reuses your `gh` and `az` sessions when you have them ([details](docs/setup.md#access-and-credentials)).

Let `dev go` change your shell's directory:

```bash
eval "$(dev shell-init zsh)"     # bash, zsh, fish and PowerShell
```

The picker uses [fzf](https://github.com/junegunn/fzf). Without the integration, `dev go` prints the path instead of jumping to it.

## Your first workspace

Paste a repository URL. `dev` asks for a name and a one-line objective; accept the defaults or type your own:

```bash
dev ws init https://github.com/can1357/oh-my-pi
cd ~/dev/ws/gh-can1357-oh-my-pi
```

```text
gh-can1357-oh-my-pi/
├── oh-my-pi/    # Git worktree on the default branch
├── ws.md        # what this is, what it holds, where you stopped
└── .local/      # scratch that never gets committed
```

`ws.md` is what makes a workspace resumable. `dev` owns the frontmatter and reads it to know what to mount and update. The body is for you, and for any coding agent that opens the folder (abridged):

```markdown
---
name: gh-can1357-oh-my-pi
description: Contribute to Oh My Pi
mounts:
  - path: oh-my-pi
    source: https://github.com/can1357/oh-my-pi
    revision:
      mode: track
      branch: main
---

# Workspace: gh-can1357-oh-my-pi

## Objective

Contribute to Oh My Pi

## Current Progress

## Decisions

## Next Steps
```

Come back in a week, or hand the folder to an agent, and the brief is already there.

## Pull requests and work items, without leaving the terminal

`dev pr` lists the open pull requests assigned to you across your connected providers. Pick one repository with `-i`, or narrow to a group of repositories with a label. Azure DevOps work items come along with `dev wi`. Both read a local cache; `--refresh` pulls the latest.

```bash
dev pr
dev pr -i
dev pr --label team:checkout
dev wi
```

Most reviews end there. When you do need the code, the PR URL becomes a workspace on the PR's source branch, forks included, while your own work on that repository stays where it is:

```bash
dev ws init https://github.com/gabrielmoreira/tiny-asl-machine/pull/52
```

## One task, four repositories

Start empty and add what the task needs. With a provider connected, `dev ws add` opens a picker over your repositories. Each mount tracks a branch, or is pinned to a tag or a commit:

```bash
dev ws init checkout-incident --desc "Checkout times out two or three times a day"
cd ~/dev/ws/checkout-incident

dev ws add                                   # pick from your repositories
dev ws add checkout-api --tag v2026.09.1     # by name or URL; pin exactly what production runs
dev ws add infra --commit 3f9c2ab
dev ws add runbooks --readonly               # reference only, skipped by sync
```

```text
checkout-incident/
├── checkout-api/       tag v2026.09.1
├── payments-gateway/   branch main
├── infra/              commit 3f9c2ab
├── runbooks/           branch main, read-only
└── ws.md
```

Tomorrow, `dev status` compares what `ws.md` declares with what is on disk and reports each mount as clean, dirty, ahead, behind, diverged or missing. `dev sync` brings the workspace back in line: it checks out a mount that is missing, puts a clean mount that drifted to another branch back on the declared one, and fast-forwards the clean ones. A mount with uncommitted changes, local commits or a diverged history is skipped and named, not touched.

```bash
dev status
dev sync
```

Switch between tasks with `dev ls` and `dev go`, or `dev go checkout` when you know part of the name.

## The same setup, every time

If every checkout incident starts with the same four repositories, save the setup as a workset and create a fresh workspace from it each time:

```bash
dev workset manage                                     # name, repositories, refs, paths, and why each is there
dev ws init incident-0919 --workset checkout-incident
```

A workset is a template. A workspace is an instance of one, with its own worktrees.

## Search documentation across every repository

Architecture in one repository, runbooks in another, the handbook in a Git-backed wiki. Keep each one as a reference checkout, label the ones that belong to the same knowledge base, and let [QMD](https://github.com/tobi/qmd) index them:

```bash
dev mirror add                             # pick a repository, or pass a URL
dev mirror label add                       # pick the sources, then type a label: index:platform-docs
dev qmd sync                               # every index:* label, one collection per repository
dev qmd x query "how does production authentication work?"
```

The answer can live in any of them; you search the set. Your coding agent can search the same index, through `dev qmd x` or through QMD's own CLI and MCP server after one setting ([how](docs/integrations.md#search-labeled-repositories-with-qmd)).

A label is metadata on a repository, and one label serves more than one command:

```bash
dev pr --label team:checkout               # pull requests from the checkout repositories
dev mirror list --label docs
dev qmd sync index:platform-docs
```

## Bring your coding agent

A workspace is already a brief: `ws.md` holds the objective, the decisions so far and the next steps, and the repositories the task needs are one folder down. Point an agent at the folder, or let `dev` start one there:

```bash
dev ws start        # opens OMP in a HerdR pane for this workspace, and finds it again next time
```

The workspace, pull request and work item commands take `--json`, and `dev --help --llms` prints the command contract in a form written for models, so an agent can drive `dev` itself. [OMP](https://omp.sh) and [HerdR](https://herdr.dev) are optional; see [Integrations](docs/integrations.md).

## How it fits together

| Concept       | What it is                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Root**      | Your `dev` environment, `~/dev` by default, with its own configuration, workspaces and repositories. You can have several, one per client. |
| **Workspace** | One task: a folder under `ws/` with a `ws.md` and one mount per repository.                                                                |
| **Mount**     | A Git worktree inside a workspace, tracking a branch or pinned to a tag or commit.                                                         |
| **Workset**   | A template for a workspace: which repositories, on which refs, at which paths, and why.                                                    |
| **Mirror**    | A reference checkout under `mirrors/`, for repositories you read and index rather than change.                                             |
| **Label**     | Metadata on a repository, read by `dev pr`, `dev mirror list` and `dev qmd sync`.                                                          |

```text
~/dev/
├── dev.yaml     # providers, sources, labels, worksets, plugins
├── AGENTS.md    # instructions for agents working inside this root
├── ws/          # one folder per task
└── mirrors/     # reference checkouts
```

Under the hood every repository is cloned once, as a bare mirror in `.dev/`, and every mount and reference checkout is a worktree on it. If you already use `git worktree`, that is the mechanism. `dev` adds the folder per task, the manifest, the pinning, the update that skips your dirty work, and the pickers.

## More

- [Setup](docs/setup.md): what `dev init` creates, credentials, several roots, shell integration for each shell.
- [Integrations](docs/integrations.md): OMP, HerdR and QMD in detail.
- [Command reference](docs/commands.md), generated from the CLI. `dev <command> --help` works everywhere.
- [Contributing](CONTRIBUTING.md): building, testing, and regenerating the demo.
