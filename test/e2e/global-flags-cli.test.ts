import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("global CLI output flags", () => {
  const cliPath = join(process.cwd(), "src", "cli.ts");
  let fixture: string;
  let root: string;
  let env: Record<string, string | undefined>;

  async function run(args: string[]) {
    const proc = Bun.spawn([process.execPath, cliPath, ...args], {
      cwd: root,
      env,
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
    fixture = await mkdtemp(join(tmpdir(), "dev-cli-global-flags-"));
    root = join(fixture, "root");
    const home = join(fixture, "home");
    await mkdir(root);
    await mkdir(home);
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DEV_ROOT: root,
      DEV_CWD: root,
      GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
    };
    expect((await run(["init", "--json"])).exitCode).toBe(0);
  });

  afterAll(async () => {
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it.each([
    "root",
    "provider",
    "ws",
    "mirror",
    "sync",
    "pr",
    "wi",
    "workitem",
    "label",
    "qmd",
    "workset",
  ])("honors prefix --json for the %s group like the suffix form", async (group) => {
    const suffix = await run([group, "--json"]);
    const expectedCode = group === "sync" ? 2 : 0;
    expect(suffix.exitCode).toBe(expectedCode);
    const expected = JSON.parse(expectedCode === 0 ? suffix.stdout : suffix.stderr);
    const prefix = await run(["--json", group]);
    expect(prefix.exitCode).toBe(expectedCode);
    const output = expectedCode === 0 ? prefix.stdout : prefix.stderr;
    expect(output.trim().startsWith("{") || output.trim().startsWith("[")).toBe(true);
    expect(JSON.parse(output)).toEqual(expected);
    expect(expectedCode === 0 ? prefix.stderr : prefix.stdout).toBe("");
  });

  it("honors prefix --json on a nested handler error", async () => {
    const result = await run(["--json", "ws", "status", "no-such-ws"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().startsWith("{")).toBe(true);
    expect(JSON.parse(result.stderr).error.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it.each(["--json", "--json=true"])("renders JSON for %s", async (flag) => {
    const result = await run([flag, "ws", "ls"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().startsWith("[")).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual([]);
    expect(result.stderr).toBe("");
  });

  it.each(["--json=false", "--no-json"])("renders text for %s", async (flag) => {
    const result = await run([flag, "ws", "ls"]);
    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).toThrow(SyntaxError);
    expect(result.stderr).toBe("");
  });

  it.each(["--quiet", "--quiet=true", "-q"])("silences narration for prefix %s", async (flag) => {
    const name = flag.replaceAll(/[^a-z]/g, "");
    const suffix = await run(["ws", "init", `suffix-${name}`, flag]);
    expect(suffix.exitCode).toBe(0);
    expect(suffix.stderr).toBe("");
    const prefix = await run([flag, "ws", "init", `prefix-${name}`]);
    expect(prefix.exitCode).toBe(0);
    expect(prefix.stdout).toContain(`prefix-${name}`);
    expect(prefix.stderr).toBe("");
  });

  it.each(["--non-interactive", "--non-interactive=true"])(
    "reports missing input for prefix %s like the suffix form",
    async (flag) => {
      const suffix = await run(["provider", "add", flag]);
      expect(suffix.exitCode).toBe(2);
      const prefix = await run([flag, "provider", "add"]);
      expect(prefix.exitCode).toBe(2);
      expect(prefix.stdout).toBe("");
      expect(prefix.stderr).toBe(suffix.stderr);
      expect(prefix.stderr).toContain("type");
    },
  );
});
