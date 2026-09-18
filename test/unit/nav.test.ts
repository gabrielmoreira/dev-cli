import { describe, expect, test } from "bun:test";
import { generateShellInit, resolveJumpTarget } from "../../src/nav";
import { formatHelp, formatWsHelp } from "../../src/cli";

describe("Navigation, Shell Integration and Self-Documentation Unit (Phase 17)", () => {
  describe("generateShellInit", () => {
    test("generates bash/zsh shell wrapper functions", () => {
      const bashScript = generateShellInit("bash");
      expect(bashScript).toContain("dev() {");
      expect(bashScript).toContain("ws() {");
      expect(bashScript).toContain("command dev ws path");
      expect(bashScript).toContain("command dev go --candidates");
      expect(bashScript).toContain("fzf");

      const zshScript = generateShellInit("zsh");
      expect(zshScript).toBe(bashScript);
    });

    test("generates fish shell wrapper functions", () => {
      const fishScript = generateShellInit("fish");
      expect(fishScript).toContain("function dev");
      expect(fishScript).toContain("function ws");
      expect(fishScript).toContain("command dev ws path");
      expect(fishScript).toContain("command dev go --candidates");
      expect(fishScript).toContain("fzf");
    });

    test("generates powershell wrapper functions", () => {
      const psScript = generateShellInit("powershell");
      expect(psScript).toContain("function dev {");
      expect(psScript).toContain("function ws {");
      expect(psScript).toContain("Set-Location");
      expect(psScript).toContain("dev) go --candidates");
      expect(psScript).toContain("fzf");

      const pwshScript = generateShellInit("pwsh");
      expect(pwshScript).toBe(psScript);
    });

    test("generates wrappers backed by the global Mise task", () => {
      const script = generateShellInit("zsh", "mise");
      expect(script).toContain("mise run dev -- go --candidates");
      expect(script).toContain('mise run dev -- "$@"');
      expect(script).not.toContain("command dev go --candidates");
    });

    test("defaults to bash for unrecognized shell type", () => {
      const def = generateShellInit("unknown");
      expect(def).toContain("dev() {");
    });
  });

  describe("resolveJumpTarget", () => {
    test("resolves workspace path by explicit name", () => {
      const target = resolveJumpTarget({
        root: "C:/fake/dev",
        workspaceName: "payment-fix",
      });
      expect(target.name).toBe("payment-fix");
      expect(target.path.replace(/\\/g, "/")).toBe("C:/fake/dev/ws/payment-fix");
    });

    test("resolves workspace path from current directory when name is omitted", () => {
      const target = resolveJumpTarget({
        root: "C:/fake/dev",
        cwd: "C:/fake/dev/ws/payment-fix/mounts/payments",
      });
      expect(target.name).toBe("payment-fix");
      expect(target.path.replace(/\\/g, "/")).toBe("C:/fake/dev/ws/payment-fix");
    });

    test("throws when workspace cannot be resolved", () => {
      expect(() =>
        resolveJumpTarget({
          root: "C:/fake/dev",
          cwd: "C:/fake/other-dir",
        }),
      ).toThrow();
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

    test("structured help reflects aliases and interactive optionality", async () => {
      const parsed = JSON.parse(await formatHelp(true));
      const ws = parsed.commands.find((command: { name: string }) => command.name === "ws");
      const init = ws.subcommands.find((command: { name: string }) => command.name === "init");
      expect(init.aliases).toContain("create");
      expect(
        init.arguments.find((argument: { name: string }) => argument.name === "name").required,
      ).toBe(false);

      const pr = parsed.commands.find((command: { name: string }) => command.name === "pr");
      const view = pr.subcommands.find((command: { name: string }) => command.name === "view");
      expect(
        view.arguments.find((argument: { name: string }) => argument.name === "id").required,
      ).toBe(false);
    });

    test("formatHelp(false) scopes nested commands to group help", async () => {
      const rootHelp = await formatHelp(false);
      expect(rootHelp).toContain("shell-init");
      const workspaceHelp = await formatWsHelp();
      expect(workspaceHelp).toContain("jump");
      expect(workspaceHelp).toContain("path");
    });
  });
});
