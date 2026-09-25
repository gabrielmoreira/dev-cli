# Contributing to `dev` CLI

Thank you for contributing to `dev`! This guide explains our architecture philosophy, local development workflow, testing standards, and verification processes.

---

## 1. Core Philosophy & Design Rules

The primary goal of `dev` is to remain **small, readable, direct, and easy to change**. We adhere to the rules in [AGENTS.md](AGENTS.md):

- **Use cases read like a story:** A developer should open `src/ws.ts`, `src/repo.ts`, `src/inventory.ts`, or `src/pr.ts` and understand the complete business flow without wading through raw Git commands, YAML serialization, or process spawning.
- **Interface concerns stay at the edge:** `src/cli.ts` parses CLI flags, validates arguments, detects ambient context (such as `$DEV_ROOT` or the current workspace from `cwd`), calls use cases, and prints output. CLI handlers contain zero business logic.
- **Semantic parents own external boundaries:** Operations live behind focused modules:
  - `src/git.ts`: Git atomic primitives (`fastForward`, `createWorktree`, `detachWorktree`, etc.)
  - `src/fs.ts`: Filesystem primitives (`ensureDir`, `removeDir`, `makeReadOnly`, `restoreWrite`)
  - `src/manifest.ts`: Serialization and parsing of `ws.md` (YAML frontmatter + markdown notes)
  - `src/cache.ts`: Fast JSONL offline storage under `.dev/cache/`
  - `src/ado.ts`: Azure DevOps REST API interactions
- **Separate observation, decision, and mutation:** Read disk state first, compute what should happen (pure functions like `compareWorkspace`), validate invariants, and only then perform mutations.
- **Validate before side-effects:** Path collisions, dirty worktrees, ahead commits, and invalid revisions are detected upfront before altering disk state.
- **Structured data over text parsing:** Use cases return strongly-typed objects. Human terminal output is just a presentation layer for structured results.
- **Errors are typed data:** Errors carry stable machine-readable codes (e.g., `DIRTY_WORKTREE`, `AHEAD_COMMITS`, `WORKSPACE_NOT_FOUND`).

---

## 2. Prerequisites & Environment Setup

`dev` is built using **Bun** and **TypeScript** with high-speed linting and formatting via **oxlint** and **oxfmt** (orchestrated through `vp`).

### Tooling Required:

- [Bun](https://bun.sh/) (v1.2+)
- [Git](https://git-scm.com/) (2.40+)
- [mise-en-place](https://mise.jdx.dev/) (optional, recommended for toolchain pinning via `mise.toml`)

### Installation:

```bash
# Clone the repository
git clone https://github.com/gabrielmoreira/dev-cli.git
cd dev-cli

# Install exact dependencies
mise run install
```

---

## 3. Local Development Workflow

### Running the CLI Locally

You can run the CLI directly with Bun without building or bundling:

```bash
# Display help
bun run src/cli.ts --help

# Run any command directly against a test root
bun run src/cli.ts ws list --root /tmp/test-dev

# Test agent-oriented markdown output
bun run src/cli.ts --help --llms
```

To install the current checkout globally for manual testing:

```bash
bun install -g .
```

Alternatively, keep the checkout uninstalled and expose it through a global Mise task:

```bash
eval "$(mise run dev -- shell-init zsh --runner mise)"
```

---

## 4. Testing Standards (TDD Is Mandatory)

We follow strict **Test-Driven Development (TDD)**:

1. **Write a failing test first** that defines the desired behavior or reproduces a bug.
2. **Run the test** and confirm it fails for the expected reason.
3. **Implement the smallest possible change** in source code.
4. **Confirm the test passes**.
5. **Refactor** while keeping all tests green.

### Test Structure

- **`test/unit/`**: Hermetic tests with no network, credentials, or machine-specific configuration.
- **`test/integration/`**: Integration tests for local Git/filesystem boundaries and explicitly configured external services.
- **`test/e2e/`**: CLI subprocess tests against temporary roots; some scenarios require the same external fixture configuration as integration tests.

### Running Tests

```bash
bun test                 # unit tests only
bun run test:unit        # unit tests only
bun run test:integration # integration tests; external cases require env configuration
bun run test:e2e         # end-to-end tests
bun run test:all         # all three suites
```

### External Azure DevOps Fixture

Mutating Azure DevOps integration tests have no default destination. Configure every
value explicitly through the environment or an ignored `.env` file:

```bash
AZURE_DEVOPS_FIXTURE_PAT=...
AZURE_DEVOPS_FIXTURE_ORGANIZATION=...
AZURE_DEVOPS_FIXTURE_PROJECT=...
AZURE_DEVOPS_FIXTURE_REPOSITORY=...
AZURE_DEVOPS_FIXTURE_ALLOW_WRITES=true
```

`AZURE_DEVOPS_FIXTURE_ALLOW_WRITES=true` is mandatory and checked before the first
network request. Unit tests never read this configuration.

---

## 5. Verification Gate (Quality Checks)

The default gate is hermetic and suitable for pull requests and release automation:

```bash
bun run verify
```

Run the complete gate only in an environment configured for external integration
and end-to-end fixtures:

```bash
bun run verify:all
```

---

## 6. Commit Guidelines

- Work on short-lived branches and merge Conventional Commits into `main`; semantic-release derives versions from those commits.
- Commits are atomic and represent working, tested slices.
- Use Conventional Commits formatting:
  - `feat(...)`: New user-facing or domain capabilities
  - `fix(...)`: Bug fixes and error recovery
  - `test(...)`: Adding or updating test suites
  - `docs(...)`: Documentation and worklog updates
  - `refactor(...)`: Code cleanup with zero behavioral changes
- Include clear descriptions of what changed, why, and what verification commands were executed.

---

## 7. Regenerating the terminal demo

The README demo (`docs/assets/dev-cli-demo.gif` and `.mp4`) is rendered by [VHS](https://github.com/charmbracelet/vhs) from `docs/demo.tape` inside a disposable Docker image built from `docs/demo/`.

The recording starts from a blank dev root in a Debian container configured with Mise, zsh, Spaceship, and CaskaydiaCove Nerd Font. Every step runs the interactive form of a command, so the tape never types a long flag list. It begins with the shortest paths: create a workspace from one repository URL, then create an empty workspace and add a repository through the picker. It then defines an `incident` workset (the seeded service plus the public `gabrielmoreira/skills` catalog), creates a workspace from it, and jumps there with `dev go`. Pinned OMP docs and the skills catalog become reference checkouts, one label puts both into a QMD index, and OMP finds the evidence-first skill through that index. The demo runs through `openrouter/free`; no paid-model fallback is configured.

To regenerate it, add `OPENROUTER_API_KEY=...` to the ignored `.env` file, then run from the repository root (Docker required; Mise supplies the pinned VHS):

```bash
mise run demo
```

The README references the GIF with a `?v=` query string, or GitHub's image cache keeps serving the old frame. The release workflow sets it to the release tag when it commits a refreshed demo; bump it by hand only when you commit a GIF yourself.
