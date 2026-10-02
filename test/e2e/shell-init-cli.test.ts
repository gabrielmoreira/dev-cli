import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("shell-init CLI usage", () => {
  const cliPath = join(process.cwd(), "src", "cli.ts");
  let root: string;

  async function run(args: readonly string[]) {
    const proc = Bun.spawn([process.execPath, cliPath, ...args], {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        DEV_ROOT: root,
        DEV_CWD: root,
        GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "dev-cli-shell-init-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it.each(["bash", "zsh", "fish", "powershell", "pwsh"])(
    "still generates the supported %s wrapper with the domain runner default",
    async (shell) => {
      const omitted = await run(["shell-init", shell]);
      const explicit = await run(["shell-init", shell, "--runner", "direct"]);
      expect(omitted.exitCode).toBe(0);
      expect(explicit.exitCode).toBe(0);
      expect(omitted.stdout).toBe(explicit.stdout);
      expect(omitted.stdout).toContain(
        shell === "powershell" || shell === "pwsh"
          ? "# dev CLI shell integration for PowerShell"
          : shell === "fish"
            ? "# dev CLI shell integration for fish"
            : "# dev CLI shell integration for bash/zsh",
      );
      expect(omitted.stderr).toBe("");
    },
  );

  it("reports an unsupported shell as human usage failure", async () => {
    const result = await run(["shell-init", "nope"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "✗ Unknown shell 'nope'. Choose bash, zsh, fish, powershell, or pwsh.\n↳ dev shell-init --help\n",
    );
  });

  it.each([
    { args: ["shell-init", "nope", "--json"] },
    { args: ["--json=true", "shell-init", "nope"] },
  ])("reports an unsupported shell as JSON usage failure (%j)", async ({ args }) => {
    const result = await run(args);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: "INVALID_ARGUMENT",
      shell: "nope",
      choices: ["bash", "zsh", "fish", "powershell", "pwsh"],
      usage: "dev shell-init --help",
      nextStep: "dev shell-init --help",
    });
  });

  it("reports an unsupported runner as human usage failure", async () => {
    const result = await run(["shell-init", "bash", "--runner", "bogus"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "✗ Unknown runner 'bogus'. Choose direct or mise.\n↳ dev shell-init --help\n",
    );
  });

  it.each([
    { args: ["shell-init", "bash", "--runner", "bogus", "--json"] },
    { args: ["--json", "shell-init", "bash", "--runner", "bogus"] },
  ])("reports an unsupported runner as JSON usage failure (%j)", async ({ args }) => {
    const result = await run(args);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: "INVALID_ARGUMENT",
      runner: "bogus",
      choices: ["direct", "mise"],
      usage: "dev shell-init --help",
      nextStep: "dev shell-init --help",
    });
  });
});
