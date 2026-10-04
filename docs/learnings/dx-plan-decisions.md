# DX plan decisions

The decisions taken while executing `.local/plan-2026-10-02-dx/`, one section each, with the alternative that was rejected. Item 7.1 owns this record.

## D9: Global flags parse in any position

**Decision.** Read `--json`, `--quiet` and `--non-interactive` from citty's own boolean parsing for the whole argument vector, whether the flag precedes the command group or follows it, and accept the `--json=true`, `--json=false` and `--no-json` spellings through one parser. `src/cli/context.ts` sets the ambient output policy once (`ui.setQuiet`, `ui.setJson`), and `ui.isJson()` is what handlers and `reportError` read. Before the fix, `dev ws ls --json` printed JSON while `dev --json ws ls` printed text, so a script had to know where to put the flag. Committed 0b1e3da.

**Rejected alternative.** Grep the raw argv for `--json` before citty runs. That duplicates citty's parsing and disagrees with it on `--json=false` and `--no-json`; the first version of item 1.2 had exactly that bug, and the item's own test caught it.

## D10: Confirmation is not permission to discard work

**Decision.** `--yes` answers a confirmation; `--force` also permits discarding uncommitted changes, unpushed commits or an unmanaged checkout. A removal handler passes `args.yes || args.force` to the interaction and only `args.force` to the domain, so automating a prompt never widens what may be deleted. `--yes=false --force` still removes, because force implies confirmation. Committed 06501de.

**Rejected alternative.** Keeping `--force` as the only unattended confirmation: every script then accepts data loss to avoid a prompt, which is the mix this separates. A separate `--confirm` was rejected as a second name for the same idea.

## D11: One contract for missing input

**Decision.** A required value that is absent and cannot be prompted for returns `INTERACTION_REQUIRED` with exit 2 and a structured `usage`, in both the human and `--json` shapes, whether the value is a positional or a flag. Omitted values stay `undefined` until the workflow decides: explicit argument, then inference, then a prompt only where the session can prompt. Committed d7b884c.

**Rejected alternative.** Letting citty's own required-argument error surface. It printed `Missing required positional argument: NAME` with exit 1, no usage and no remedy, and a flag-shaped omission produced a different message from a positional one.

## D12: Every error code owns its exit status

**Decision.** `src/cli/errors.ts` maps every code the code base can throw to an exit status and a next step, and a unit test enumerates the codes literally and fails when a code is missing from either table. Relation to a refusal is explicit: `UNSAFE_REMOVE`, `UNMANAGED_CHECKOUT` and `DIRTY_WORKTREE` are 3; a source that matches nothing is 2. Committed 4e819bb.

**Rejected alternative.** Deriving the status from the error class name or from a prefix. Neither is checked by the compiler, and the survey found codes thrown from paths with no table entry at all.

## D13: One symbol per kind of outcome

**Decision.** `✓` a completed action, `○` a fact, already-applied state or a proposed plan, `⚠` a caveat, `✗` a failure, `↳` the next command, and `↻` progress on stderr only. A clean status is a fact, so it prints `○`; a dirty or behind mount is a caveat, `⚠`, without changing the successful exit. Committed e7d911f.

**Rejected alternative.** Reusing `✓` for a read command that reported clean state: it reads as an action that just happened, and the same output then means different things in a script's log.

## D14: `--json` errors are parsed by a machine, not coloured

**Decision.** In JSON mode `ui.error` writes the payload to `process.stderr` directly, without colour, because Bun's `console.error` wraps a string in ANSI escapes whenever a terminal or `FORCE_COLOR` says so. A regression test runs the CLI as a subprocess with `FORCE_COLOR=1` and parses stderr, and asserts no escape sequence is present. Committed fe8eae4.

**Rejected alternative.** Stripping ANSI in tests: the consumer is a script, not the test, and the bytes on stderr are the contract. Per-call-site `process.stderr.write` was rejected too, because every error path goes through one renderer.

## D15: Keep the six names and teach them where they appear

**Decision.** Root, workspace, mount, mirror, workset and label keep their names. Each is introduced at the point of use instead: `src/concepts.ts` holds one job sentence and one contrast sentence per concept, and help, README and `docs/commands.md` render that table; prompts carry a hint line that says what the answer becomes. The maintainer chose this on 2026-10-03: the problem is how the commands explain themselves, above all the interactive ones, not the words. Committed b8320d9 and 0f476df.

**Rejected alternative.** Renaming `mount` (to `checkout`, say) or `workset` (to `template` or `recipe`). Each fixes one association, but breaks commands, `dev.yaml` keys, JSON fields, `ws.md` frontmatter, docs and the demo, and needs a major release for a problem a definition at the point of use already solves.

## D16: An error shows the way out, not the whole help

**Decision.** An error prints its message, then one remedy chosen by the producer for the user's state: a close name from `details.candidates` through `closestName`, otherwise at most five known names, otherwise the usage line. Help prints only when the user asks for it. Committed 4fba62e.

**Rejected alternative.** Printing the full help on every error. It buries the one line that helps under every flag of the command, and it cannot know the user's state: a root without a provider would still be told to sync repositories.

## D17: The demo carries no captions (superseded by D18)

**Decision.** The terminal demo explains itself through the CLI's own prompts, hints and next-step lines; the tape types commands and answers, nothing else. Where the hints made prompts taller, two scenes take a shorter interactive path to stay inside VHS's row budget: `dev ws init --workset incident`, the command the saved workset suggests, and `dev label add index:incident`, which names the label instead of answering its prompt. The row fit was counted in a terminal from source; only the release render proves it. Committed ff7c45c.

**Rejected alternative.** Captions, or typed `# ...` comment lines explaining each step. They explain the demo and leave the product as unclear as before, and a person who installs `dev` never sees them.

## D18: The demo sets itself up and says what comes next (installation superseded by D20)

**Decision.** The demo image carries nothing of `dev`: the tape installs the pinned release with `mise use -g github:gabrielmoreira/dev-cli@$DEV_VERSION`, appends `eval "$(dev shell-init zsh)"` to `~/.zshrc`, and only then runs `dev init`, so every step a new user takes is on screen. Each scene opens with one short typed `# ...` line saying what comes next; where a scene is near VHS's row budget, the comment trails the command on the same line. The image still seeds scenery (local remotes and an inventory file) because a real provider would need credentials inside a container that runs a model. The maintainer asked for this on 2026-10-03: a preconfigured container made the demo look like magic.

**Rejected alternative.** Keeping D17. The CLI's hints explain each prompt, but a GIF viewer cannot pause, and the setup a user must do (install, shell integration) was invisible. Passing a GitHub token into the container to avoid anonymous API limits during the install was rejected too: the release job's token can write to the repository, and the container runs a model-driven agent.

## D19: The demo goes from the simplest command to the most involved

**Decision.** Each scene adds one idea to the last, so the value of a short command lands before anything needs explaining. `dev go` moved from after the workset scenes to right after the first workspace: it is one word, it is the payoff of the shell integration installed a minute earlier, and with one workspace it jumps without a prompt. The scratch workspace is entered with `dev go scratch`, and the later jump into `incident` keeps the picker, so `dev go` appears in three growing forms: direct, by name, picker. The maintainer asked for this order on 2026-10-03.

**Rejected alternative.** Keeping `dev go` after the workset as the single jump scene. It showed the picker once, but a viewer met worksets before the one-word command that makes workspaces feel cheap, and the shell integration sat unused for most of the recording.

## D20: Keep the demo's release pin in Mise configuration, not in the typed command

**Decision.** Supersedes the installation part of D18. The image preinstalls the published tools and records their versions in `/demo/mise.toml`. That file is also the image's global Mise configuration, so the same tools remain available when the shell enters a workspace. The tape shows bare `mise install` as a repeatable install, followed by `dev --version`, rather than typing a tool identifier, a version, or an environment variable. `DEV_VERSION` remains a build input for selecting the exact published release. The maintainer asked for a preconfigured TOML and a short command on 2026-10-03; captions and on-screen shell integration from D18 remain unchanged.

**Rejected alternative.** Typing `mise use -g github:gabrielmoreira/dev-cli@$DEV_VERSION`. It exposed the pinning machinery before showing the product's simplest commands and made the install scene slower. Keeping the tools preinstalled does not pre-create a workspace, workset, label, or index.

## D21: A workspace runs its setup once, when it is created

**Decision.** A workset may carry a setup command, each repository member may override it or set `setup: false`, and `dev ws init --setup` sets one for a workspace without a workset. The resolved command is stored per mount in `ws.md`. `dev ws init` runs it in each mount it created, after every mount is in place; a reused workspace, `dev go`, `dev ws start`, and `dev ws update` never run it. `dev ws setup` reruns it on request. A mount outside the trusted scopes runs only with `--consent`. A failed or skipped command is reported per mount and does not stop the rest; `dev ws init` still succeeds, while `dev ws setup` exits non-zero after trying every mount. The maintainer asked for simple setup at workspace creation, with failures that never interrupt remaining work, on 2026-10-04.

**Rejected alternative.** Running setup when a repository or workspace is opened. It repeats slow work on every visit and turns navigation into a command that can fail. Widening `--consent` into a trust grant was rejected too: it permits the commands of this run and records nothing.

## D22: The agent learns about the documentation index from the root instructions

**Decision.** The `AGENTS.md` that `dev init` writes at the root describes `dev qmd search`, and coding agents inherit it from every workspace below the root, so a question about indexed documentation leads the agent to the index without naming the command. Workspaces carry no copy. Verified on 2026-10-04 with the pinned OMP: the root file appears in the session's system prompt, and a prompt that names no command made the agent run `dev qmd search` and cite the indexed skill.

**Rejected alternative.** Putting the command in the demo prompt, or writing an `AGENTS.md` into each workspace. The first shows a workaround instead of the product; the second duplicates the root file and drifts from it.

## D23: Build the demo GIF from the rendered MP4, not inside VHS

**Decision.** VHS renders only the MP4 of `docs/demo.tape`, and `docs/demo/render.sh` builds the GIF from that MP4 with a two-pass ffmpeg: pass one collects a palette file, pass two applies it. VHS's own GIF output sends every frame of the recording through one `palettegen`/`paletteuse` graph, which buffers the whole recording in memory; a kernel log showed ffmpeg at 14.4 GB resident for a 137-second recording, and release renders died the same way twice on 16 GB GitHub runners, mid-encode, with the runner canceling the step. The two passes stream: a 228-second MP4 became a 10 MB GIF in 16 seconds with 123 MB resident. The GIF runs at 12 frames per second; the recording length no longer sets the memory ceiling.

**Rejected alternative.** Re-running the canceled release renders and hoping. The kill offsets varied (76 s and 120 s into the same encode), which is a resource threshold, not a deadline; a green render this morning was luck of a shorter decode, not headroom. Raising the runner size or shortening the demo instead would spend money or cut scenes to protect a renderer defect.
