---
name: dev
description: "Operate a dev root with the dev CLI: workspaces, mounts, mirrors, labels. Use only when the user asks about dev, a dev root, a workspace, a mount, or the repositories for one task."
---

# dev

`dev` keeps the repositories for one task together in a workspace, under a dev root, and clones each
repository once.

## Check where you are

```
dev current --json
```

It names the active root, where that choice came from, and the config file. Having no root is a
normal state: run `dev init` only when the user asks for one.

## The installed binary is the authority

Start with `dev --help --llms` for every command, argument, exit code and error code as JSON, then
`dev <group> --help` for one group. Never invent a flag. Every command takes `--json`, and `--json`
or `--non-interactive` never prompts: a missing value comes back as a structured error naming the
flag to pass.

## The flow

```
dev ws init <repository-url>              # a workspace with ws.md and a first mount
dev ws add <repository-url> --ws <name>   # another repository, on its own branch
dev status --root <root>                  # what each mount is doing
dev go <workspace>                        # print the path, for a cd
```

`ws.md` is the workspace's brief: dev owns the frontmatter, and the body is yours to keep current
(Objective, Current Progress, Decisions, Next Steps). Work inside a mount; leave `mirrors/` and
`.dev/` alone, because dev keeps those consistent.

## Vocabulary

- **root**: where dev keeps workspaces, mirrors and settings, `~/dev` by default.
- **workspace**: one folder for one task, with `ws.md` and the repositories it needs.
- **mount**: one repository inside a workspace, on its own branch; you edit and commit here.
- **mirror**: a reference copy dev keeps up to date, for reading and search.
- **workset**: a saved recipe for a workspace, with an objective.
- **label**: a name for a group of repositories, like `team:payments`.

## Rules

- Do not edit `mirrors/` or `.dev/` by hand; use `dev` commands.
- Do not commit inside a mirror. Task work belongs in a mount.
- `dev sync` means fresh: a stale cache is an explicit option, never the default.
- `dev ws remove --yes` refuses a mount with uncommitted changes, unpushed commits or an unmanaged
  checkout. Pass `--force` only when the user asked for that.
- Repository hooks run only under a trusted scope or explicit consent.
- `dev` never stores a credential it did not receive: authentication belongs to `gh`, `az` and the
  Git credential helper.

## When something fails

Read the error code first (`DIRTY_WORKTREE`, `AHEAD_COMMITS`, `SOURCE_NOT_FOUND`, `UNKNOWN_COMMAND`
and the rest are in `dev --help --llms` under `errorCodes`). Then pass the flag the error names
instead of guessing, and check `dev --help --llms` before inventing a command.
