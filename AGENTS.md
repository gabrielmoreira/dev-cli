# Development Rules

The main goal of this project is to stay small, readable, direct, and easy to change.

When in doubt, prefer the solution with fewer concepts, fewer abstractions, fewer dependencies, and less code, as long as the business flow remains clear.

- **Keep the use case readable as a story.** A developer should be able to open `ws.ts` or `repo.ts` and understand the complete business flow without reading Git, filesystem, YAML, or process execution details.

- **Handlers deal with interface concerns only.** Parse CLI arguments, validate CLI-specific input, resolve CLI context, call the use case, and present the result. Do not put business decisions in handlers.

- **Use cases own business orchestration.** They decide what needs to happen, in which order, what is valid, what should be skipped, and what result should be returned.

- **Use cases own business defaults; handlers reference them for CLI help.** Export default constants from the domain module (e.g. `export const DEFAULT_SYNC_STRATEGY = "ff-only"`). CLI command definitions reference these constants in their argument descriptions (`(default: ${DEFAULT_SYNC_STRATEGY})`), but avoid setting parser-level defaults so omitted arguments arrive as `undefined`.

- **Use `undefined` to distinguish omitted arguments from explicit user intent.** When an optional CLI flag is omitted, pass `undefined` into the use case rather than injecting defaults early. When an argument is explicitly provided, execute it directly without prompting. When omitted (`undefined`), the workflow can intelligently prompt in interactive TTY sessions or apply domain defaults in unattended environments.

- **Prompt for inputs only when practically ergonomic.** Handlers do not need to interrogate users for every possible option upfront. Prompt early only for core arguments that define the command's primary intent. Keep secondary or conditional options optional in the use case input, allowing workflows to apply sensible defaults or ask mid-flight only when truly needed.

- **Mid-flight human decisions use domain-specific interaction contracts.** When business orchestration discovers a condition requiring user direction (such as diverged branches or uncommitted changes), declare a typed callback in dependencies (`deps.interactions`). The use case yields domain data; the handler decides how to satisfy it (via flags, interactive prompts, or safe defaults).

- **Use cases never own presentation or visual progress.** Do not call `console.log`, `consola`, spinners, or ANSI color helpers inside use cases. Return typed data for fast operations, and accept optional typed progress callbacks (`onProgress?: (event: T) => void`) for long-running orchestration. Terminal rendering belongs exclusively to handlers.

- **Keep external operations behind semantic parents.** Use names such as `git.*`, `manifest.*`, `fs.*`, and `shell.*`. Prefer `git.fastForward()` over a generic `process.run()` call from a use case.

- **Semantic parents should expose small atomic capabilities.** They should perform the requested operation, not decide the business workflow. `git.fastForward()` is appropriate. `git.syncWorkspaceSafely()` probably contains too much business logic.

- **Do not abstract implementation details unless there is a real reason.** `manifest.ts` may use `Bun.file()` directly. `git.ts` may use `Bun.spawn()` directly. Do not create wrappers simply because an external API exists.

- **Do not create architecture in anticipation of future needs.** No plugin system, event bus, observer framework, extension API, generic operation registry, or similar mechanism until a concrete requirement needs it.

- **Do not create interfaces only for dependency injection.** Prefer simple modules and functions. Tests can inject small objects or functions when necessary.

- **Avoid classes unless stateful object behavior genuinely makes the code simpler.** Functions and plain objects are the default.

- **Do not introduce factories, containers, repositories, adapters, ports, controllers, services, or mappers just to match an architectural pattern.** Introduce a concept only when the code has a real responsibility that needs that concept.

- **One semantic parent per file is preferred.** `git.ts`, `manifest.ts`, `fs.ts`, `shell.ts`. This is for clarity, not layering ceremony.

- **Do not create a semantic parent before it earns its existence.** If only one small helper relates to `source`, keep it near the use case. Create `source.ts` only when multiple source-related responsibilities emerge.

- **Avoid generic dumping grounds.** Do not create `utils.ts`, `common.ts`, `shared.ts`, or `helpers.ts`. Find the semantic owner of the behavior instead.

- **Avoid folders that contain only one file.** Start flat. Create folders when the amount of code genuinely benefits from grouping.

- **Keep business transformations pure whenever practical.** Functions such as `planMount()`, `compareWorkspace()`, `planUpdate()`, `validateMount()`, and `addMount()` should preferably have no I/O.

- **Separate observation, decision, and mutation.** Read the current state first, calculate what should happen, validate it, and only then perform mutations.

- **Validate before causing side effects.** Path collisions, dirty worktrees, ahead commits, invalid revisions, trust restrictions, and similar conditions should be detected before changing disk state whenever possible.

- **Do not hide orchestration inside lower-level modules.** If `ws.add()` requires mirror creation, admin repository creation, worktree checkout, hooks, and manifest persistence, that sequence should remain visible in `ws.add()`.

- **Lower-level modules may compose low-level implementation details, but should not absorb use-case decisions.** `git.addWorktree()` may execute several Git commands internally. It should not decide whether the workspace is allowed to add that worktree.

- **Prefer explicit code over generic machinery.** Three obvious function calls are better than a generic pipeline, middleware chain, lifecycle framework, or command executor abstraction.

- **Structured data is the source of truth.** Use cases return typed structured results. Human terminal output is only a presentation of that data.

- **Errors are semantic data, not text parsing contracts.** Prefer error codes and structured information such as `DIRTY_WORKTREE`, `AHEAD_COMMITS`, or `SOURCE_NOT_FOUND`. Do not make higher layers inspect error-message strings.

- **Do not optimize for extensibility before there is an extension.** Make current use-case results structured enough that future integrations can consume them, but do not implement plugins or events now.

- **Dependencies should point inward toward business intent.** CLI handlers call use cases. Use cases call semantic capabilities. Semantic capabilities must not call use cases.

- **Avoid circular knowledge.** `git.ts` should not know about `ws.add()`. `manifest.ts` should not know how workspace reconciliation works. `shell.ts` should not know why a hook is being executed.

- **Tests should mock semantic boundaries, not implementation details.** A `ws.add()` test may fake `git` and `manifest`. It should not mock `Bun.spawn`, `Bun.file`, YAML parsing, or individual filesystem syscalls.

- **Test pure business logic without mocks.** Most decision-heavy behavior should be testable simply by passing input objects and asserting returned objects.

- **Test infrastructure modules against reality when cheap.** Test `git.ts` using temporary real Git repositories. Test `manifest.ts` using temporary real files. Avoid tests that merely assert which command-line string was passed to Git.

- **Do not build a large fake implementation of the system for tests.** Use small inline fakes containing only the behavior required by each test.

- **Keep dependencies close to zero.** Prefer Bun and platform capabilities before adding packages. Add a dependency only when it removes meaningful complexity rather than merely saving a few lines.

- **Do not prematurely optimize file count.** Several small files with obvious ownership are preferable to one large file containing unrelated responsibilities.

- **Do not prematurely optimize abstraction count either.** A new file is cheap. A new architectural concept is expensive.

- **Preserve directness.** Code should normally read like `read -> inspect -> decide -> validate -> execute -> persist -> return`.

- **Prefer boring code.** The project should be understandable by reading it from top to bottom without needing knowledge of an internal framework.

- **Prefer boring code, but do not tolerate tedious boilerplate.** Start direct and obvious to make tests pass. Once green, refactor repetitive rituals that obscure business intent into shallow, single-level helpers. A local helper that eliminates repeated ceremony improves readability without introducing deep abstraction layers or internal frameworks.

- **When two solutions are equally correct, choose the one that is easier to delete later.**

- **When unsure whether to introduce an abstraction, do not introduce it yet.** Duplication of a few lines is acceptable until the real reusable concept becomes obvious.

- **When unsure where code belongs, ask what noun owns the behavior.** Git behavior belongs to `git.ts`. Manifest representation belongs to `manifest.ts`. Workspace business decisions belong to `ws.ts`.

- **When unsure whether something is business logic or infrastructure, ask whether changing Git/Bun/filesystem would change that rule.** If the rule would still exist, it probably belongs in the use case or pure domain logic.

- **The architecture should emerge from the product, not become the product.**
