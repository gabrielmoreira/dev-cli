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
dev ws start gh-example-org-sample-repo
```

`dev` uses the workspace directory as the pane working directory. It reuses an existing ready OMP, starts OMP in an available matching pane, or creates a named HerdR workspace and agent when neither exists. The command works from a HerdR pane or a normal terminal. If no server is running, it starts one and waits for readiness; an interactive call from a normal terminal then hands that terminal to the HerdR client, attached to the chosen session, and returns when you close it. `--json` performs the same server orchestration without taking over the calling terminal.

A partial name is enough when it identifies one workspace (`dev ws start adob`). When several workspaces match in an interactive terminal, `dev` asks which one to start. Inside a workspace, `dev ws start` with no argument targets that workspace.

The workspace's `ws.md` is the agent's brief. The root `AGENTS.md` written by `dev init` tells agents to read it first and to keep its Objective, Current Progress, Decisions and Next Steps current.

## Search labeled repositories with QMD

Install QMD through Mise, then put an indexing label on each repository that should be searchable. An `index:*` label keeps its repositories mirrored, since QMD indexes what is on disk:

```bash
mise use -g npm:@tobilu/qmd
dev label add index:docs https://github.com/example-org/sample-repo --sync
```

With no positional label, sync reconciles every assigned `index:*` label. An explicit label remains available for targeted automation. The command removes stale collections owned by those labels, adds missing collections, updates the index once, and embeds new chunks unless `--no-embed` is set.

```bash
dev qmd sync
dev qmd sync index:docs
dev qmd sync --no-embed
```

Collections are named `<label>--<checkout>`, so the example creates `index:docs--sample-repo`. Query the resulting index through the passthrough:

```bash
dev qmd x query "how are tools registered?" -c index:docs--sample-repo --json -n 10
dev qmd x status
```

By default, the QMD registry is scoped to the dev root. To share the index with direct `qmd query` calls and a `qmd mcp` server, select QMD's global registry in `dev.yaml`:

```yaml
plugins:
  qmd:
    config_dir: global
```

Everything after `dev qmd x` is passed to QMD unchanged. Run `qmd --help` for the installed command reference and `qmd mcp` for the stdio server.

## Run your code after a sync or label change

You load a local plugin by setting `plugins.<name>.module` in your root's `dev.yaml`:

```yaml
plugins:
  recorder:
    module: ./record-sync.mjs
```

You resolve a relative module path from the directory containing `dev.yaml`, not your current directory. You can also use an absolute path. Only plugins with a string `module` value load; `dev` does not scan directories. Your module loads when hooks are dispatched, not when you open help or build the built-in plugin list.

You default-export a `PluginFactory` with the signature `(base: PluginBase) => Plugin`. Your plugin's `name` matches the config key, `run(args)` returns a promise, and `hooks` holds optional event handlers. You read your remaining configuration through `base.config.plugins.<name>`; `base` also gives you the root, active workspace, UI, filesystem, and shell capabilities. Save this 10-line example as `record-sync.mjs`:

```js
import { join } from "node:path";
export default (base) => ({
  name: "recorder",
  run: async () => {},
  hooks: {
    "mirror:sync:after": async (_ctx, { updated }) => {
      await base.fs.writeText(join(base.root, "last-sync.json"), JSON.stringify(updated));
    },
  },
});
```

You receive these events after the corresponding command finishes its work:

| Event               | Hook data                                                 |
| ------------------- | --------------------------------------------------------- |
| `mirror:sync:after` | `root`, `updated` entries with `sourceKey` and `revision` |
| `label:add:after`   | `root`, `sourceKey`, `label`, `meta`                      |
| `label:rm:after`    | `root`, `sourceKey`, `label`                              |

You see a warning naming the plugin if its file is missing, import fails, default export is not a function, factory throws, or returned name differs from the config key. A built-in with the same name wins, and you see a warning instead of loading the external module. Hook failures also warn; neither loading failures nor hook failures stop your command or other plugins.

Your module runs with your user's permissions, including access to files, processes, and credentials available to that user. You only configure code you trust in your own `dev.yaml`; `dev` does not ask for a separate trust confirmation.

## Labels

A label names a set of repositories. Each one carries the label on its default branch or on a branch you choose, and the labels live on the `sources:` entries of `dev.yaml`. `dev label` shows every label and then asks what to do: add, edit fields, rename, or remove. Every step also has a scripted form:

```bash
dev label                                     # see every label, then pick an action
dev label add team:checkout checkout-api web  # repositories by URL, path, or name
dev label add docs wiki --ref internal        # one branch of a repository
dev label rm team:checkout web
dev label rename team:checkout team:payments  # also renames label_defs and workset members
dev label ls --json
```

Without arguments, `dev label add` asks for the label, lists the repositories from your provider inventory and from `dev.yaml`, and lets you choose a branch for the ones you select to customize. A repository `dev.yaml` does not declare yet is declared. When a repository is declared on several branches, a terminal asks which one; a script passes `--ref <branch>`.

Some labels keep their repositories mirrored. `index:*` labels do by default, and `label_defs` decides for any other label, by exact name or by a wildcard, the most specific winning:

```yaml
label_defs:
  team:*:
    mirror: true
  team:ops:*:
    mirror: false
```

A missing mirror is created by the next `dev mirror sync` or `dev sync --all`. `dev label add` offers to create it right away in a terminal, and `--sync` does it in a script. Taking a label off a repository never deletes its mirror; the command names the mirrors no label needs anymore.

The same label drives `dev pr --label`, `dev ws init --label`, `dev mirror list --label`, and `dev qmd sync`.

## Put a label in a workset

A workset member names either one repository (`source`) or one label (`label`). A label member stands for every declared source carrying that label, each on its declared branch or pin and at its declared path, so a repository you label later joins the next workspace made from the workset. A repository listed on its own and reached again through a label is mounted once. A label no declared source carries is an error that names `dev label add <label>`.

```yaml
worksets:
  checkout-incident:
    description: Checkout incident triage
    members:
      - source: https://github.com/example/checkout-api.git
        ref: main
      - label: team:checkout
        reason: Everything the checkout team owns
```

`dev workset label add checkout-incident team:checkout` and `dev workset label remove` edit label members from a script; `dev workset manage` offers the same in a terminal. `dev ws init --label team:checkout` starts a workspace from a label alone, named `team-checkout`, and `--label` combines with `--workset` into one plan; several labels are comma-separated.
