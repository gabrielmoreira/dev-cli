# Integrations

`dev` can connect three independent tools. None is required; each one is detected when installed.

- [OMP](https://omp.sh) is the coding agent opened for a dev workspace.
- [HerdR](https://herdr.dev) keeps agent terminals organized and running.
- [QMD](https://github.com/tobi/qmd) is a local search engine for documentation and knowledge bases.

## Open the right OMP in HerdR

Install OMP and HerdR if you do not have them yet:

```bash
mise use -g github:can1357/oh-my-pi
mise use -g herdr
```

On Windows, install HerdR from PowerShell instead:

```powershell
irm https://herdr.dev/install.ps1 | iex
```

Then open OMP in a workspace:

```bash
dev ws start gh-can1357-oh-my-pi
```

`dev` uses the workspace directory as the pane working directory. It reuses an existing ready OMP, starts OMP in an available matching pane, or creates a named HerdR workspace and agent when neither exists. The command works from a HerdR pane or a normal terminal. If no server is running, it starts one and waits for readiness; an interactive call from a normal terminal then hands that terminal to the HerdR client, attached to the chosen session, and returns when you close it. `--json` performs the same server orchestration without taking over the calling terminal.

A partial name is enough when it identifies one workspace (`dev ws start adob`). When several workspaces match in an interactive terminal, `dev` asks which one to start. Inside a workspace, `dev ws start` with no argument targets that workspace.

The workspace's `ws.md` is the agent's brief. The root `AGENTS.md` written by `dev init` tells agents to read it first and to keep its Objective, Current Progress, Decisions and Next Steps current.

## Search labeled repositories with QMD

Install QMD through Mise, then attach an indexing label to each source that should be searchable:

```bash
mise use -g npm:@tobilu/qmd
dev mirror add https://github.com/can1357/oh-my-pi
dev mirror label add oh-my-pi index:docs
```

With no positional label, sync reconciles every assigned `index:*` label. An explicit label remains available for targeted automation. The command removes stale collections owned by those labels, adds missing collections, updates the index once, and embeds new chunks unless `--no-embed` is set.

```bash
dev qmd sync
dev qmd sync index:docs
dev qmd sync --no-embed
```

Collections are named `<label>--<checkout>`, so the example creates `index:docs--oh-my-pi`. Query the resulting index through the passthrough:

```bash
dev qmd x query "how are tools registered?" -c index:docs--oh-my-pi --json -n 10
dev qmd x status
```

By default, the QMD registry is scoped to the dev root. To share the index with direct `qmd query` calls and a `qmd mcp` server, select QMD's global registry in `dev.yaml`:

```yaml
plugins:
  qmd:
    config_dir: global
```

Everything after `dev qmd x` is passed to QMD unchanged. Run `qmd --help` for the installed command reference and `qmd mcp` for the stdio server.

## Labels

Labels are declared on sources in `dev.yaml` and attached with `dev mirror label add`. The interactive form selects sources, ref, label, and metadata; the scripted form is positional:

```bash
dev mirror label add                 # select sources, ref, label, and metadata
dev mirror label add oh-my-pi docs   # deterministic scripted form
dev mirror list --label docs
```

When one URI has multiple declared refs, the interactive flow asks which ref to label; scripts pass `--ref <branch>`. A multi-source change is previewed and confirmed once before `dev.yaml` is updated. The same label can drive `dev pr --label docs` and `dev qmd sync docs`.
