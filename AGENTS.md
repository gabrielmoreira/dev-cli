# Development Rules

The main goal of this project is to stay small, readable, direct, and easy to change.

When in doubt, prefer the solution with fewer concepts, fewer abstractions, fewer dependencies, and less code, as long as the business flow remains clear.

How to read this file: each bullet is a rule in bold followed by the reason or the example it came from. Each section opens with the result we want and the result we do not want; when a rule and a situation disagree, the wanted result decides. Build, test and release commands live in [CONTRIBUTING.md](CONTRIBUTING.md); the complete CLI reference is generated into [docs/commands.md](docs/commands.md) and is never edited by hand.

## Code shape

**Wanted:** a developer opens a use case and reads the complete business flow top to bottom, in the order it happens.

**Not wanted:** business decisions in handlers, Git or YAML details in use cases, or a flow that can only be followed by jumping between files.

- **Keep the use case readable as a story.** A developer should be able to open `ws.ts` or `repo.ts` and understand the complete business flow without reading Git, filesystem, YAML, or process execution details.
- **Handlers deal with interface concerns only.** Parse CLI arguments, validate CLI-specific input, resolve CLI context, call the use case, and present the result. Do not put business decisions in handlers.
- **Use cases own business orchestration.** They decide what needs to happen, in which order, what is valid, what should be skipped, and what result should be returned.
- **Use cases own business defaults; handlers reference them for CLI help.** Export default constants from the domain module (e.g. `export const DEFAULT_SYNC_STRATEGY = "ff-only"`). CLI command definitions reference these constants in their argument descriptions (`(default: ${DEFAULT_SYNC_STRATEGY})`), but avoid setting parser-level defaults so omitted arguments arrive as `undefined`.
- **Use cases never own presentation or visual progress.** Do not call `console.log`, `consola`, spinners, or ANSI color helpers inside use cases. Return typed data for fast operations, and accept optional typed progress callbacks (`onProgress?: (event: T) => void`) for long-running orchestration. Terminal rendering belongs exclusively to handlers.
- **Keep external operations behind semantic parents.** Use names such as `git.*`, `manifest.*`, `fs.*`, and `shell.*`. Prefer `git.fastForward()` over a generic `process.run()` call from a use case.
- **Semantic parents should expose small atomic capabilities.** They should perform the requested operation, not decide the business workflow. `git.fastForward()` is appropriate. `git.syncWorkspaceSafely()` probably contains too much business logic.
- **Do not hide orchestration inside lower-level modules.** If `ws.add()` requires mirror creation, admin repository creation, worktree checkout, hooks, and manifest persistence, that sequence should remain visible in `ws.add()`.
- **Lower-level modules may compose low-level implementation details, but should not absorb use-case decisions.** `git.addWorktree()` may execute several Git commands internally. It should not decide whether the workspace is allowed to add that worktree.
- **Dependencies should point inward toward business intent.** CLI handlers call use cases. Use cases call semantic capabilities. Semantic capabilities must not call use cases.
- **Avoid circular knowledge.** `git.ts` should not know about `ws.add()`. `manifest.ts` should not know how workspace reconciliation works. `shell.ts` should not know why a hook is being executed.
- **Keep business transformations pure whenever practical.** Functions such as `planMount()`, `compareWorkspace()`, `planUpdate()`, `validateMount()`, and `addMount()` should preferably have no I/O.
- **Separate observation, decision, and mutation.** Read the current state first, calculate what should happen, validate it, and only then perform mutations.
- **Validate before causing side effects.** Path collisions, dirty worktrees, ahead commits, invalid revisions, trust restrictions, and similar conditions should be detected before changing disk state whenever possible.
- **Preserve directness.** Code should normally read like `read -> inspect -> decide -> validate -> execute -> persist -> return`.
- **Structured data is the source of truth.** Use cases return typed structured results. Human terminal output is only a presentation of that data.
- **Errors are semantic data, not text parsing contracts.** Prefer error codes and structured information such as `DIRTY_WORKTREE`, `AHEAD_COMMITS`, or `SOURCE_NOT_FOUND`. Do not make higher layers inspect error-message strings.

## Abstraction and dependencies

**Wanted:** the smallest amount of machinery that keeps the current flow clear, and a codebase a new reader understands without learning an internal framework.

**Not wanted:** a plugin system, adapter, container, or generic pipeline built for a need that has not arrived, or a dependency added to save a few lines.

- **Do not abstract implementation details unless there is a real reason.** `manifest.ts` may use `Bun.file()` directly. `git.ts` may use `Bun.spawn()` directly. Do not create wrappers simply because an external API exists.
- **Do not create architecture in anticipation of future needs.** No plugin system, event bus, observer framework, extension API, generic operation registry, or similar mechanism until a concrete requirement needs it.
- **Do not create interfaces only for dependency injection.** Prefer simple modules and functions. Tests can inject small objects or functions when necessary.
- **Avoid classes unless stateful object behavior genuinely makes the code simpler.** Functions and plain objects are the default.
- **Do not introduce factories, containers, repositories, adapters, ports, controllers, services, or mappers just to match an architectural pattern.** Introduce a concept only when the code has a real responsibility that needs that concept.
- **Prefer explicit code over generic machinery.** Three obvious function calls are better than a generic pipeline, middleware chain, lifecycle framework, or command executor abstraction.
- **Do not optimize for extensibility before there is an extension.** Make current use-case results structured enough that future integrations can consume them, but do not implement plugins or events now.
- **Keep dependencies close to zero.** Prefer Bun and platform capabilities before adding packages. Add a dependency only when it removes meaningful complexity rather than merely saving a few lines.
- **Do not prematurely optimize file count.** Several small files with obvious ownership are preferable to one large file containing unrelated responsibilities.
- **Do not prematurely optimize abstraction count either.** A new file is cheap. A new architectural concept is expensive.
- **Prefer boring code.** The project should be understandable by reading it from top to bottom without needing knowledge of an internal framework.
- **Prefer boring code, but do not tolerate tedious boilerplate.** Start direct and obvious to make tests pass. Once green, refactor repetitive rituals that obscure business intent into shallow, single-level helpers. A local helper that eliminates repeated ceremony improves readability without introducing deep abstraction layers or internal frameworks.
- **Extend an existing boundary before creating a platform.** A new primitive in `ui.ts`, a semantic resolver, a concrete option, or the existing inventory is the first move; a prompt adapter, a workflow DSL, or a second renderer waits for a second real case.
- **Cut over cleanly.** When a new path replaces an old one, migrate the callers and delete the old path, its fixtures, and its docs. An alias, shim, or compatibility layer without a consumer costs more than the migration.

## Files and naming

**Wanted:** every behavior has one obvious owner, and a file name tells the reader what is inside.

**Not wanted:** `utils.ts`, a folder with one file, a semantic parent created for a single helper, or a name that collides with a concept already in the model.

- **One semantic parent per file is preferred.** `git.ts`, `manifest.ts`, `fs.ts`, `shell.ts`. This is for clarity, not layering ceremony.
- **Do not create a semantic parent before it earns its existence.** If only one small helper relates to `source`, keep it near the use case. Create `source.ts` only when multiple source-related responsibilities emerge.
- **Avoid generic dumping grounds.** Do not create `utils.ts`, `common.ts`, `shared.ts`, or `helpers.ts`. Find the semantic owner of the behavior instead.
- **Avoid folders that contain only one file.** Start flat. Create folders when the amount of code genuinely benefits from grouping.
- **The on-disk layout has one owner.** `src/paths.ts` derives every path under a dev root; nothing else joins segments by hand.

## Tests

**Wanted:** a failing test that names the rule it protects, and tests that stay green through a refactor of the implementation.

**Not wanted:** a test that asserts which command string was passed to Git, a large fake of the whole system, or a suite that needs the maintainer's machine.

- **Tests should mock semantic boundaries, not implementation details.** A `ws.add()` test may fake `git` and `manifest`. It should not mock `Bun.spawn`, `Bun.file`, YAML parsing, or individual filesystem syscalls.
- **Test pure business logic without mocks.** Most decision-heavy behavior should be testable simply by passing input objects and asserting returned objects.
- **Test infrastructure modules against reality when cheap.** Test `git.ts` using temporary real Git repositories. Test `manifest.ts` using temporary real files. Avoid tests that merely assert which command-line string was passed to Git.
- **Do not build a large fake implementation of the system for tests.** Use small inline fakes containing only the behavior required by each test.
- **Unit tests are hermetic.** No network, no credentials, no machine configuration; `test/unit` proves zero network calls, `test/integration` and `test/e2e` declare every external fixture they need through the environment.

## CLI behavior

**Wanted:** a command that asks for what it cannot infer, never for what it can, and that behaves the same for a person in a terminal, a script, an agent, and CI.

**Not wanted:** a prompt in a non-interactive session, a silent guess on a choice that matters, a flag list a person has to memorize, or output nobody can parse.

- **Use `undefined` to distinguish omitted arguments from explicit user intent.** When an optional CLI flag is omitted, pass `undefined` into the use case rather than injecting defaults early. When an argument is explicitly provided, execute it directly without prompting. When omitted (`undefined`), the workflow can intelligently prompt in interactive TTY sessions or apply domain defaults in unattended environments.
- **Prompt for inputs only when practically ergonomic.** Handlers do not need to interrogate users for every possible option upfront. Prompt early only for core arguments that define the command's primary intent. Keep secondary or conditional options optional in the use case input, allowing workflows to apply sensible defaults or ask mid-flight only when truly needed.
- **Mid-flight human decisions use domain-specific interaction contracts.** When business orchestration discovers a condition requiring user direction (such as diverged branches or uncommitted changes), declare a typed callback in dependencies (`deps.interactions`). The use case yields domain data; the handler decides how to satisfy it (via flags, interactive prompts, or safe defaults).
- **An explicit argument always wins, deterministic inference comes second, and a prompt comes last and only when stdin and stdout are a TTY.** `--json`, CI, and any non-interactive session never open a prompt; a missing or ambiguous value there is a structured error that names the flag to pass.
- **A default is a proposal the user sees, not a decision hidden in the implementation.** The workspace name is derived from the source, the branch from the remote default, the path from the name, and each one is shown before Enter accepts it.
- **Show the plan, let the user adjust it, confirm, and only then execute.** The confirmation is proportional to risk: removing a mount or stashing someone's work always asks; creating a workspace asks once, after the resolved plan, and Enter accepts it.
- **Show the whole plan, customize only the selected items, and fetch remote data only after intent.** `ws add` lists every planned mount, fetches branches only for the mounts the user chose to customize, and shows the resolved plan again before creating anything.
- **Order prompts by dependency.** Branch before path, because the path may depend on the branch.
- **Never decide silently when the outcomes differ materially.** Which workspace, organization, branch, path, source, credential, or homonymous repository: ask in a TTY, fail with an ambiguity error elsewhere. `dev mirror sync` stashes and reports changed mirrors; it does not invent a workspace, a name, or a branch.
- **Review is an action of its own where a flow has several steps or touches the user's work.** The workset manager edits a draft and asks before saving; `dev mirror sync` reports every stash with its name, SHA, and the recovery command.
- **Control sophistication grows with the observed problem.** A direct argument, then text resolved against the inventory, then a select, then `@clack/prompts` autocomplete for large catalogs. Enquirer was tried first and replaced; no new prompt library without a second real need.
- **Every command takes `--json`, and `dev --help --llms` is the agent contract.** Structured output is what scripts and agents read; a command without it breaks the promise that the tool serves both.
- **Print the context the user would otherwise have to remember.** Results name the root, workspace, source, branch, path, and version in play. `DEV_CWD` carries the caller's directory through the Mise task so `dev` acts where it was invoked, not where the task is defined.
- **Performance is part of the interface.** Do not print thousands of inventory lines, fetch every branch, or resolve a credential per repository. Network concurrency is bounded per normalized host and reentrant, and a strategy changes only after a measurement.
- **`dev sync` means fresh.** A stale cache is an explicit option, never the default, because performance must not change what a command means.
- **Shortcuts stay consistent with their long forms.** `dev status`, `dev sync`, `dev ls`, `dev go`, and `dev start` are aliases of workspace commands; the shell wrapper only turns a printed path into a `cd`, because a subprocess cannot change its parent's directory.

## Concepts and configuration

**Wanted:** six public nouns a reader can tell apart by the job each one does, and every setting living with the entity whose behavior it controls.

**Not wanted:** a new name for every internal distinction, two concepts that read alike, or a fact that lives in two files.

- **The public vocabulary is root, workspace, mount, mirror, workset, and label.** A workset is a template for a workspace, with an objective; a label names a set of repositories, each on a branch; a mirror is a reference checkout you read and index; a mount is a worktree inside a workspace. Anything else stays internal until it earns a name.
- **A concept earns its name by doing a job no existing concept does, and it is introduced with one sentence of contrast against its nearest neighbor.** Scope and quickset were discussed and deferred for exactly this reason.
- **A name must not collide with the mental model already in place.** `workset` was rejected for a query context because it competes with workspace and `ws`.
- **Identity is source plus ref plus path, not the URL alone.** The same repository can be mounted twice on different branches, and a repository name is not unique across Azure DevOps organizations and projects.
- **Configuration lives with the entity whose behavior it controls.** `~/.dev.toml` is a registry of roots and nothing else; `dev.yaml` holds the behavior of one root (providers, sources, labels, worksets, plugins, hooks); `ws.md` holds one workspace, frontmatter owned by `dev` and body owned by people and agents; `.dev/` is rebuildable; tool versions belong to Mise; authentication belongs to `gh`, `az`, and the Git credential helper.
- **Labels are free text with an optional schema.** `team:*`, `docs`, and `index:*` are conventions; `label_defs` in `dev.yaml` can type their fields and set `mirror`, by exact name or wildcard. `index:*` is the only prefix a command reads, and it keeps its repositories mirrored by default.
- **A label is intent; a mirror is a copy on disk.** A label that asks for mirrors gets them on the next sync, never by surprise, and taking the label off never deletes one. A mirror is not a label, and a workset is not replaced by one: a workset carries an objective and may point to labels.

## Safety, credentials, and trust

**Wanted:** a tool that reuses the credentials the user already has, never widens its own authority, and can always show how to undo what it did.

**Not wanted:** a second authentication chain, a token persisted by accident, a fixture that can reach a corporate organization, or a guardrail that damages what it protects.

- **One owner for authentication.** Resolve in order: environment variable, token in `dev.yaml`, then the `gh` or `az` session; clone through the user's credential helper or SSH agent. `dev` never stores a token it did not receive.
- **A transitory credential stays transitory.** `git -c http.extraHeader=... clone`, with `-c` before `clone`, so the header never lands in the repository's configuration.
- **A guardrail must not deform the object it protects.** Mirrors stay writable, a `prepare-commit-msg` hook on the admin repository blocks commits, and sync autostashes with a named stash. `chmod` was rejected because it flips executable bits and dirties the worktree.
- **Recover data automatically; never decide intent automatically.** Stash, report the path, the stash name, the SHA, and the recovery command, and stop.
- **Repository hooks run only under a trusted scope or explicit `--consent`.** Consent permits hooks; it grants no repository permission.
- **Fixtures are isolated before the first network call.** The Azure DevOps fixture needs organization, project, repository, and `AZURE_DEVOPS_FIXTURE_ALLOW_WRITES=true`, all explicit; a mismatch fails before any request, and no test reads the machine's real inventory or providers.
- **Security answers the threat model, not the keyword.** A deliberately scoped throwaway PAT is not an incident; the risk is a fixture pointing at a production organization.
- **Nothing machine-specific reaches a commit.** No local path, environment value, company name, host, or credential in code, docs, demo, or commit message.

## Documentation

**Wanted:** a stranger decides in a minute whether `dev` solves a problem they have, and every fact has exactly one home.

**Not wanted:** internal vocabulary before value, contributor material on the user page, a documented behavior that is not released, or a second copy of a fact.

- **README sells to a user; CONTRIBUTING serves a contributor; `docs/commands.md` is generated and owns every flag; `docs/setup.md` and `docs/integrations.md` hold the reference prose.** Regenerate the reference with `mise run docs:commands`.
- **A README section runs situation, value, example, command, and only then the concept name.** Concepts come last, as a table with one job per row, and the mechanism (worktrees, bare mirrors) after the concepts.
- **Show before telling.** The demo sits under "See it in action" near the top, the first workspace section shows the real `ws.md`, and every scenario shows real commands and real output.
- **Promote only workflows people actually do.** A command that exists has no automatic right to the home page; reviewing a pull request is not checking it out.
- **A prerequisite sits beside its payoff.** Shell integration and the `fzf` requirement live in Install, because `dev go` is the first nice moment.
- **One fact, one home.** Search for the fact before writing it, edit it where it lives, and link from the second place. When a rewrite cuts content, relocate it; delete only when the subject is gone; supersede a decision, never erase it.
- **Examples run from the documented install on a fresh machine.** No behavior that is not released, no npm instructions until there is an npm package, no dependence on a local checkout.
- **Voice: second person, present tense, plain verbs, no adjectives that praise the tool, no closing slogans, no em dash.** Headings in sentence case, named as outcomes ("The same setup, every time") or invitations ("See it in action"), never as nouns ("Workspace model").
- **A safety claim names the hazard it avoids.** "Skips a mount with uncommitted changes, local commits, or a diverged history", never "safe".
- **Bump the `?v=` cache buster on the demo image whenever the GIF changes.** GitHub caches the image by URL and keeps serving the old frame.

## Terminal demo

**Wanted:** a recording that proves the public path on the published binary and leaves the impression that the tool is easy.

**Not wanted:** a fixture standing in for the feature shown, a flag list that wraps the screen, a wait that matches stale text, or a green render from old files.

- **The demo is part of the product.** It is onboarding, visual documentation, an integration test, and a release test at once; a change to `docs/demo.tape` or `docs/demo/` is a product change.
- **It runs the published binary in a disposable container from an empty root.** `DEV_VERSION` pins the release the container installs and the release workflow overrides it with the version it just published, so a feature that is not released cannot appear.
- **Fixtures prepare scenery, never the feature being shown.** Seeding repositories and an inventory is scenery; injecting a workset into `dev.yaml` hides the feature. The workset is created on screen with `dev workset manage`.
- **Tell one story.** Init, a first workspace from a URL, a repository added through the picker, a workset, a workspace from it, `dev go`, a label, the index, and the agent using it.
- **Type the interactive form of every command.** Prompts do the work. Typed lines stay under about sixty characters so nothing wraps at 1200 by 800 pixels and 18 point; one short flag is fine, a flag list is not.
- **`Wait+Screen` sees only the first `rows` lines of the buffer since the last clear.** VHS 0.11 reads `term.buffer.active` lines 0 to `rows` (`testing.go`, `Buffer()`), so a marker that scrolls past the terminal height is never matched even though it is on screen. Start every scene with a clear, keep each marker inside the row budget noted at the top of `docs/demo.tape`, and wait only for text unique to the new state, never for text still visible from an earlier step or contained in the command just typed.
- **Filter an autocomplete by a substring of the stable value.** Type `skills`, not a display-only prefix, and never select by rendered position: the list is sorted for display, not in inventory order.
- **Observe a control in a real PTY before automating it.** A timeout log shows where the tape stopped; the PTY shows why.
- **A confirmation that hands control back to the shell needs two waits.** The confirmation text, then the shell prompt. "Text appeared" and "process exited" are different events.
- **A completion gate watches the completion protocol, not a content detail.** The agent prompt asks for a closing marker spelled so the prompt itself never contains it literally, and the tape waits for that marker.
- **Render fresh and validate.** Delete old outputs first, require a non-empty GIF and MP4 after, run VHS in its own session so its teardown signal cannot kill the render script, and accept only exit 0 or 143.
- **An external failure is its own layer.** A 403 from the model provider is a provider failure; it does not justify loosening the tape or touching the CLI.

## Delivery and verification

**Wanted:** every claim carries the evidence that fits it, and a change is done when a user on a fresh machine gets the promised result.

**Not wanted:** a local test standing in for a release, a workaround reported as a fix, a raised timeout in place of a diagnosis, or a partial failure erasing what was already proven.

- **Evidence matches the claim.** A unit test proves a rule; a PTY proves an interaction; a container proves a clean environment; installing the exact version (`mise x github:gabrielmoreira/dev-cli@<version> -- dev --version`) proves distribution; size or hash proves an artifact.
- **Done includes callers, docs, generated help, tests, a real smoke, and, when the change reaches users, the release, the published install, and the demo assets.** The commit of the feature is not the end.
- **Diagnose the cause before changing anything.** A clone that hangs is a credential prompt nobody sees, not a short timeout. Raising the timeout, retrying without a new hypothesis, or wrapping the call in `mise exec` are workarounds; a workaround is named as temporary or not shipped.
- **Measure before optimizing, and report the sample and the interval.** The per-host concurrency limit came from a benchmark across thousands of repositories, not from a hunch.
- **A partial failure keeps what was proven.** Separate the layers (workset, index, model API, render, teardown) and keep each verdict; do not reopen a proven layer because a later one failed.
- **Do not attribute an external failure to the code without evidence.** Compare the same request from another network or from CI before touching credentials or the tool.
- **The hermetic gate is `bun run verify`; the full gate needs the external fixtures.** Both are described in CONTRIBUTING.md.

## Collaboration

**Wanted:** an agent that reads before asking, proposes before changing, turns a correction into a rule, and leaves a record the next session can resume from.

**Not wanted:** a regenerated draft after a request for details, a reopened decision without a new fact, a process standing in for the result, or a claim that something "should work".

- **Read the code and the configuration before asking.** Do not ask for what the repository already shows.
- **Discussion is not authorization.** Analysis, alternatives, and plans change nothing; change code, configuration, or state only after an explicit instruction to implement, apply, or select.
- **Edit approved work; never regenerate it.** When a request names details, change those details and leave the rest untouched.
- **A correction becomes a rule.** Apply the principle to the sibling cases and record it here, so it does not have to be asked twice.
- **Record a decision with the alternative it rejected.** `ws.md` under Decisions for a workspace, `docs/learnings/` for the project; supersede, never delete.
- **Disagree with evidence, once.** After the maintainer decides, do not reopen without a new fact.
- **Learnings from other sessions are context, not orders.** Say which ones were applied and which were dropped, and why.
- **Answer the request, then report what else was found.** Result first, evidence second, detail last; say what was run and what was inferred.
- **Files, comments, and commit messages are in English.** Conventional Commits; semantic-release derives versions from them.

## When unsure

**Wanted:** a decision made by a question the situation can answer.

**Not wanted:** a rule applied where it does not fit, or a habit standing in for a reason.

- **When two solutions are equally correct, choose the one that is easier to delete later.**
- **When unsure whether to introduce an abstraction, do not introduce it yet.** Duplication of a few lines is acceptable until the real reusable concept becomes obvious.
- **When unsure where code belongs, ask what noun owns the behavior.** Git behavior belongs to `git.ts`. Manifest representation belongs to `manifest.ts`. Workspace business decisions belong to `ws.ts`.
- **When unsure whether something is business logic or infrastructure, ask whether changing Git/Bun/filesystem would change that rule.** If the rule would still exist, it probably belongs in the use case or pure domain logic.
- **When unsure whether to prompt, ask whether the outcomes differ materially.** If not, use the default and show it.
- **When unsure whether to confirm, ask whether the action is destructive or ambiguous.** If not, execute.
- **When unsure whether something deserves a name, ask whether it has a job no existing concept has and a second real case.** If not, keep it internal.
- **When unsure whether a demo step or a test is honest, remove the special state of this machine in your head and ask whether it still works.**
- **When unsure where a fact belongs, ask who reads it first.**
- **When unsure whether the work is done, ask whether a user on a fresh machine can reproduce the claim from the published artifact.**

- **The architecture should emerge from the product, not become the product.**
