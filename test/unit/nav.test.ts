import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { generateShellInit, resolveJumpTarget } from "../../src/nav";
import { formatCommandHelp, formatHelp } from "../../src/cli";

describe("Navigation, Shell Integration and Self-Documentation Unit (Phase 17)", () => {
  describe("generateShellInit", () => {
    test("generates the platform wrapper when shell and runner are omitted", () => {
      const omitted = generateShellInit(undefined, undefined);
      const explicit = generateShellInit(
        process.platform === "win32" ? "powershell" : "bash",
        "direct",
      );
      expect(omitted).toBe(explicit);
      expect(omitted).toContain(process.platform === "win32" ? "function dev {" : "dev() {");
    });

    test("generates bash/zsh shell wrapper functions", () => {
      const bashScript = generateShellInit("bash");
      expect(bashScript).toContain("dev() {");
      expect(bashScript).toContain("ws() {");
      expect(bashScript).toContain("command dev ws path");
      expect(bashScript).not.toContain("fzf");
      expect(bashScript).toContain('command dev go "$@"');

      const zshScript = generateShellInit("zsh");
      expect(zshScript).toBe(bashScript);
    });

    test("generates fish shell wrapper functions", () => {
      const fishScript = generateShellInit("fish");
      expect(fishScript).toContain("function dev");
      expect(fishScript).toContain("function ws");
      expect(fishScript).toContain("command dev ws path");
      expect(fishScript).not.toContain("fzf");
      expect(fishScript).toContain("command dev go $argv[2..-1]");
    });

    test("generates powershell wrapper functions", () => {
      const psScript = generateShellInit("powershell");
      expect(psScript).toContain("function dev {");
      expect(psScript).toContain("function ws {");
      expect(psScript).toContain("Set-Location");
      expect(psScript).not.toContain("fzf");
      expect(psScript).toContain("go @goArgs)");
      expect(psScript).toContain(
        "Get-Command -CommandType Application dev | Select-Object -First 1",
      );

      const pwshScript = generateShellInit("pwsh");
      expect(pwshScript).toBe(psScript);
    });

    test("generates wrappers backed by the global Mise task", () => {
      const script = generateShellInit("zsh", "mise");
      expect(script).not.toContain("fzf");
      expect(script).toContain('mise run dev -- go "$@"');
      expect(script).toContain('mise run dev -- "$@"');
      expect(script).not.toContain("command dev go");
    });

    test("JSON bypasses navigation in every shell and runner", () => {
      for (const runner of ["direct", "mise"] as const) {
        for (const shell of ["bash", "zsh"]) {
          expect(generateShellInit(shell, runner)).toContain('if [ "$arg" = "--json" ]; then');
        }
        expect(generateShellInit("fish", runner)).toContain("if contains -- --json $argv");
        for (const shell of ["powershell", "pwsh"]) {
          expect(generateShellInit(shell, runner)).toContain("if ($args -contains '--json') {");
        }
      }
    });

    test("path-based navigation checks directories and delegates original arguments", () => {
      for (const runner of ["direct", "mise"] as const) {
        const bash = generateShellInit("bash", runner);
        expect(
          bash.match(
            /target=.* ws path .*\n    if .*\[ -d "\$target" \]; then\n      cd .*\n    else\n      .* "\$@"/g,
          ),
        ).toHaveLength(3);
        const fish = generateShellInit("fish", runner);
        expect(
          fish.match(
            /set -l target \(.* ws path .*\n        if .*test -d "\$target"\n            cd .*\n        else\n            .* \$argv/g,
          ),
        ).toHaveLength(2);
        const powershell = generateShellInit("powershell", runner);
        expect(
          powershell.match(
            /\$target = \(.* ws path .*\n        if .*Test-Path -LiteralPath \$target -PathType Container.*\n            Set-Location .*\n        } else {\n            .* @args/g,
          ),
        ).toHaveLength(3);
      }
    });

    test.each(["unknown", ""])("rejects an unsupported shell %s with its choices", (shell) => {
      expect(generateShellInit("bash", undefined)).toBe(generateShellInit("bash", "direct"));
      expect(() => generateShellInit(shell)).toThrow("Unknown shell");
      let error: unknown;
      try {
        generateShellInit(shell);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        code: "INVALID_ARGUMENT",
        details: {
          shell,
          choices: ["bash", "zsh", "fish", "powershell", "pwsh"],
          usage: "dev shell-init --help",
        },
      });
    });
  });

  describe("resolveJumpTarget", () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "dev-cli-nav-"));
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    test("resolves an existing workspace directory by explicit name", async () => {
      const path = join(root, "ws", "payment-fix");
      await mkdir(path, { recursive: true });

      const target = await resolveJumpTarget({ root, workspaceName: "payment-fix" });

      expect(target).toEqual({ name: "payment-fix", path });
    });

    test("resolves an existing workspace from a nested current directory", async () => {
      const path = join(root, "ws", "payment-fix");
      const cwd = join(path, "mounts", "payments");
      await mkdir(cwd, { recursive: true });

      const target = await resolveJumpTarget({ root, cwd });

      expect(target).toEqual({ name: "payment-fix", path });
    });

    test("rejects a missing explicit workspace with its resolved path", async () => {
      const path = join(root, "ws", "missing");

      await expect(
        Promise.resolve().then(() => resolveJumpTarget({ root, workspaceName: "missing" })),
      ).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND", details: { path } });
    });

    test("rejects a regular file at the workspace path", async () => {
      const path = join(root, "ws", "not-a-directory");
      await mkdir(join(root, "ws"));
      await writeFile(path, "not a workspace directory");

      await expect(
        Promise.resolve().then(() => resolveJumpTarget({ root, workspaceName: "not-a-directory" })),
      ).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND", details: { path } });
    });

    test("resolves an existing explicit workspace under a custom prefix", async () => {
      const workspacePrefix = "tasks/active";
      const path = join(root, workspacePrefix, "payment-fix");
      await mkdir(path, { recursive: true });

      const target = await resolveJumpTarget({
        root,
        workspacePrefix,
        workspaceName: "payment-fix",
      });

      expect(target).toEqual({ name: "payment-fix", path });
    });

    test("infers an existing workspace under a custom prefix from cwd", async () => {
      const workspacePrefix = "tasks/active";
      const path = join(root, workspacePrefix, "payment-fix");
      const cwd = join(path, "mounts", "payments");
      await mkdir(cwd, { recursive: true });

      const target = await resolveJumpTarget({ root, workspacePrefix, cwd });

      expect(target).toEqual({ name: "payment-fix", path });
    });

    test("rejects a target that escapes the dev root", async () => {
      await expect(
        Promise.resolve().then(() => resolveJumpTarget({ root, workspaceName: "../.." })),
      ).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
    });

    test("rejects when cwd is outside the workspace prefix and no name is given", async () => {
      await expect(
        Promise.resolve().then(() => resolveJumpTarget({ root, cwd: root })),
      ).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
    });
  });

  describe("Dynamic Self-Documentation (LLM & Human)", () => {
    test("formatHelp(true) generates valid JSON orientation containing all commands and subcommands", async () => {
      const rawJson = await formatHelp(true);
      const parsed = JSON.parse(rawJson);

      expect(parsed.name).toBe("dev");
      expect(Array.isArray(parsed.commands)).toBe(true);

      const wsCmd = parsed.commands.find((command: { name: string }) => command.name === "ws");
      expect(wsCmd).toBeDefined();
      const subcommands = wsCmd.subcommands.map((command: { name: string }) => command.name);
      expect(subcommands).toContain("init");
      expect(subcommands).toContain("add");
      expect(subcommands).toContain("status");
      expect(subcommands).toContain("update");
      expect(subcommands).toContain("jump");
      expect(subcommands).toContain("pick");
      expect(subcommands).toContain("path");

      const mirrorCmd = parsed.commands.find(
        (command: { name: string }) => command.name === "mirror",
      );
      expect(mirrorCmd).toBeDefined();
      expect(mirrorCmd.subcommands.map((command: { name: string }) => command.name)).toContain(
        "pick",
      );
      expect(
        parsed.commands.some((command: { name: string }) => command.name === "shell-init"),
      ).toBe(true);
    });

    test("structured help uses root shortcut spellings", async () => {
      const parsed = JSON.parse(await formatHelp(true));
      const rootNames = parsed.commands.map((command: { name: string }) => command.name);
      const ws = parsed.commands.find((command: { name: string }) => command.name === "ws");
      const workspaceNames = ws.subcommands.map((command: { name: string }) => command.name);

      expect(rootNames).toContain("ls");
      expect(rootNames).toContain("status");
      expect(rootNames).not.toContain("list");
      expect(workspaceNames).toContain("status");
      expect(workspaceNames).toContain("list");
    });

    test("human help uses the requested root shortcut spelling", async () => {
      const help = stripVTControlCharacters(await formatCommandHelp(["ls"]));
      expect(help).toContain("USAGE dev ls");
    });

    test("structured help reflects command aliases", async () => {
      const parsed = JSON.parse(await formatHelp(true));
      const ws = parsed.commands.find((command: { name: string }) => command.name === "ws");
      const init = ws.subcommands.find((command: { name: string }) => command.name === "init");
      expect(init.aliases).toContain("create");

      const update = ws.subcommands.find((command: { name: string }) => command.name === "update");
      expect(update?.aliases ?? []).not.toContain("up");
      expect(update?.aliases ?? []).toContain("sync");
      expect(parsed.commands.some((command: { name: string }) => command.name === "sync")).toBe(
        true,
      );
    });

    test("formatHelp(false) scopes nested commands to group help", async () => {
      const rootHelp = await formatHelp(false);
      expect(rootHelp).toContain("shell-init");
      const workspaceHelp = await formatCommandHelp(["ws"]);
      expect(workspaceHelp).toContain("jump");
      expect(workspaceHelp).toContain("path");
    });
  });
});
