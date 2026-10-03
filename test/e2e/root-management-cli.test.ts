import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import { parseGlobalToml } from "../../src/global.ts";

describe("Root Management and mise-Style Ergonomics CLI E2E (Phase 2.4)", () => {
  let tempHome: string;
  let devRoot: string;
  const cliPath = join(process.cwd(), "src", "cli.ts");

  beforeAll(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "dev-cli-home-"));
    devRoot = join(tempHome, "my-dev");
  });

  afterAll(async () => {
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
  });

  it("dev init creates dev.yaml and registers root in ~/.dev.toml", async () => {
    const proc = Bun.spawn(
      ["bun", "run", cliPath, "init", devRoot, "--alias", "primary", "--json"],
      {
        env: {
          ...process.env,
          HOME: tempHome,
          USERPROFILE: tempHome,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.path.replace(/\\/g, "/")).toBe(devRoot.replace(/\\/g, "/"));
    expect(parsed.alias).toBe("primary");

    // Verify dev.yaml created with comments
    const devYamlPath = join(devRoot, "dev.yaml");
    expect(fs.exists(devYamlPath)).toBe(true);
    const devYamlContent = await fs.readText(devYamlPath);
    expect(devYamlContent).toContain("sync_strategy: ff-only");

    // Verify ~/.dev.toml created and updated
    const globalTomlPath = join(tempHome, ".dev.toml");
    expect(fs.exists(globalTomlPath)).toBe(true);
    const toml = Bun.TOML.parse(await fs.readText(globalTomlPath)) as {
      default_root?: string;
      roots?: Record<string, { path: string }>;
    };
    expect(toml.default_root).toBe("primary");
    expect(toml.roots?.primary?.path).toBeDefined();
  });

  it("dev init creates AGENTS.md for human and LLM orientation", async () => {
    const agentsRoot = join(tempHome, "agents-root");
    const proc = Bun.spawn(["bun", "run", cliPath, "init", agentsRoot, "--json"], {
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
      },
      stdout: "ignore",
      stderr: "pipe",
    });

    expect(await proc.exited).toBe(0);

    const agentsPath = join(agentsRoot, "AGENTS.md");
    expect(fs.exists(agentsPath)).toBe(true);
    const content = await fs.readText(agentsPath);
    expect(content).toContain("# dev CLI Root");
    expect(content).toContain("These instructions apply only inside this dev root");
    expect(content).toContain("`dev --help`");
    expect(content).toContain("`dev --help --llms`");
    expect(content).toContain("Read `ws.md` before starting work");
    expect(content).toContain("`dev ws status`");
    expect(content).toContain("`dev ws start [name]`");
    expect(content).toContain("Do not edit `.dev/` or `mirrors/` directly");
    expect(content).toContain("Use `ws/<workspace>/.local/` for workspace-local artifacts");
  });

  it("dev init preserves an existing AGENTS.md", async () => {
    const existingRoot = join(tempHome, "existing-agents-root");
    const agentsPath = join(existingRoot, "AGENTS.md");
    const existingContent = "# Project-specific instructions\n\nKeep this context.\n";
    await fs.ensureDir(existingRoot);
    await fs.writeText(agentsPath, existingContent);

    const proc = Bun.spawn(["bun", "run", cliPath, "init", existingRoot, "--json"], {
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
      },
      stdout: "ignore",
      stderr: "pipe",
    });

    expect(await proc.exited).toBe(0);
    expect(await fs.readText(agentsPath)).toBe(existingContent);
  });

  it("dev init defaults to ~/dev", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "init", "--json"], {
      cwd: tempHome,
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.path.replace(/\\/g, "/")).toBe(join(tempHome, "dev").replace(/\\/g, "/"));
  });

  it("dev init . initializes the current directory", async () => {
    const currentDir = join(tempHome, "current");
    await fs.ensureDir(currentDir);
    const proc = Bun.spawn(["bun", "run", cliPath, "init", ".", "--json"], {
      cwd: currentDir,
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.path.replace(/\\/g, "/")).toBe((await realpath(currentDir)).replace(/\\/g, "/"));
  });

  it("dev current displays active root and discovery source", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "current", "--json"], {
      cwd: devRoot,
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.root.replace(/\\/g, "/")).toBe((await realpath(devRoot)).replace(/\\/g, "/"));
    expect(parsed.source).toBeDefined();
  });

  it("dev roots lists registered roots from ~/.dev.toml", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "roots", "--json"], {
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.some((r: any) => r.alias === "primary" && r.isDefault)).toBe(true);
  });

  it("dev use -g sets default root in ~/.dev.toml", async () => {
    const secondaryRoot = join(tempHome, "secondary-dev");
    await fs.ensureDir(secondaryRoot);

    // Register secondary
    const initProc = Bun.spawn(
      ["bun", "run", cliPath, "init", secondaryRoot, "--alias", "secondary", "--json"],
      {
        env: {
          ...process.env,
          HOME: tempHome,
          USERPROFILE: tempHome,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await initProc.exited).toBe(0);

    // Switch default back to primary
    const useProc = Bun.spawn(["bun", "run", cliPath, "use", "-g", "primary", "--json"], {
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(useProc.stdout).text();
    const exitCode = await useProc.exited;

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.activeRoot).toBe("primary");

    // Verify ~/.dev.toml has primary as default
    const globalTomlPath = join(tempHome, ".dev.toml");
    const tomlContent = await fs.readText(globalTomlPath);
    expect(tomlContent).toContain('default_root = "primary"');
  });

  it("registers and unregisters an existing root without deleting it", async () => {
    const linkedRoot = join(tempHome, "linked-dev");
    await fs.ensureDir(linkedRoot);
    await fs.writeText(join(linkedRoot, "dev.yaml"), "sync_strategy: ff-only\n");

    const addProc = Bun.spawn(
      ["bun", "run", cliPath, "root", "add", linkedRoot, "--alias", "linked", "--json"],
      {
        env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await addProc.exited).toBe(0);
    expect(JSON.parse(await new Response(addProc.stdout).text()).alias).toBe("linked");
    const roots = async () =>
      (Bun.TOML.parse(await fs.readText(join(tempHome, ".dev.toml"))) as { roots?: object }).roots;
    expect(await roots()).toHaveProperty("linked");

    const removeProc = Bun.spawn(["bun", "run", cliPath, "root", "remove", "linked", "--json"], {
      env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await removeProc.exited).toBe(0);
    expect(JSON.parse(await new Response(removeProc.stdout).text()).filesRemoved).toBe(false);
    expect(await roots()).not.toHaveProperty("linked");
    expect(fs.exists(linkedRoot)).toBe(true);
  });
});

describe("init root alias protection", () => {
  const cliPath = join(process.cwd(), "src", "cli.ts");
  let temp: string;
  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "dev-init-alias-"));
  });
  afterAll(async () => {
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function fixture(id: string) {
    const home = join(temp, id, "home");
    await fs.ensureDir(home);
    return { home, first: join(temp, id, "first"), second: join(temp, id, "second") };
  }
  async function invoke(home: string, args: string[]) {
    const child = Bun.spawn([process.execPath, cliPath, ...args], {
      cwd: temp,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CI: "1",
        GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
        DEV_ROOT: undefined,
        DEV_CWD: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  }
  async function initial(home: string, path: string) {
    const result = await invoke(home, ["init", path, "--alias", "taken", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }

  it("refuses alias collision before creating the target or changing the registry", async () => {
    const { home, first, second } = await fixture("absent-target");
    await initial(home, first);
    const registry = join(home, ".dev.toml");
    const before = await fs.readText(registry);
    const result = await invoke(home, ["init", second, "--alias", "taken", "--json"]);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: "ROOT_ALIAS_EXISTS" });
    expect(await fs.readText(registry)).toBe(before);
    expect(fs.exists(second)).toBe(false);
    expect(fs.exists(join(first, "dev.yaml"))).toBe(true);
  });

  it("refuses before touching a pre-existing target's configuration or instructions", async () => {
    const { home, first, second } = await fixture("existing-target");
    await initial(home, first);
    await fs.ensureDir(second);
    await fs.writeText(join(second, "dev.yaml"), "# customized\nproviders: []\n");
    await fs.writeText(join(second, "AGENTS.md"), "# keep these instructions\n");
    const before = await fs.readText(join(home, ".dev.toml"));
    const result = await invoke(home, ["init", second, "--alias", "taken", "--json"]);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stderr).error.code).toBe("ROOT_ALIAS_EXISTS");
    expect(await fs.readText(join(home, ".dev.toml"))).toBe(before);
    expect(await fs.readText(join(second, "dev.yaml"))).toBe("# customized\nproviders: []\n");
    expect(await fs.readText(join(second, "AGENTS.md"))).toBe("# keep these instructions\n");
  });

  it("force replaces only the alias, preserving the old root and customized target", async () => {
    const { home, first, second } = await fixture("force-target");
    await initial(home, first);
    const oldConfig = await fs.readText(join(first, "dev.yaml"));
    await fs.ensureDir(second);
    await fs.writeText(join(second, "dev.yaml"), "# customized\nproviders: []\n");
    await fs.writeText(join(second, "AGENTS.md"), "# customized instructions\n");
    const result = await invoke(home, ["init", second, "--alias", "taken", "--force", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const registry = parseGlobalToml(await fs.readText(join(home, ".dev.toml")));
    expect(registry.roots.taken?.path).toBe(second.replace(/\\/g, "/"));
    expect(registry.default_root).toBe("taken");
    expect(await fs.readText(join(first, "dev.yaml"))).toBe(oldConfig);
    expect(await fs.readText(join(second, "dev.yaml"))).toBe("# customized\nproviders: []\n");
    expect(await fs.readText(join(second, "AGENTS.md"))).toBe("# customized instructions\n");
  });

  it("allows the same normalized alias/path without force", async () => {
    const { home, first } = await fixture("same-target");
    await initial(home, first);
    const registry = join(home, ".dev.toml");
    const before = await fs.readText(registry);
    const result = await invoke(home, ["init", join(first, "."), "--alias", "taken", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      alias: "taken",
      defaultRoot: "taken",
      defaultRootChanged: false,
    });
    expect(await fs.readText(registry)).toBe(before);
  });

  it("publishes a changed default and preserves the existing explicit-alias policy", async () => {
    const { home, first, second } = await fixture("default-json");
    const firstResult = await initial(home, first);
    expect(firstResult).toMatchObject({ defaultRoot: "taken", defaultRootChanged: true });
    const result = await invoke(home, ["init", second, "--alias", "second", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      defaultRoot: "second",
      defaultRootChanged: true,
    });
    expect(parseGlobalToml(await fs.readText(join(home, ".dev.toml"))).default_root).toBe("second");
  });

  it("keeps the previous default for an unaliased explicit path", async () => {
    const { home, first, second } = await fixture("default-human");
    await initial(home, first);
    const unchanged = await invoke(home, ["init", second, "--json"]);
    expect(unchanged.code, unchanged.stderr).toBe(0);
    expect(JSON.parse(unchanged.stdout)).toMatchObject({
      defaultRoot: "taken",
      defaultRootChanged: false,
    });
  });
});
