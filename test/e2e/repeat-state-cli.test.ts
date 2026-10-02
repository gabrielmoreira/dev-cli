import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const cliPath = join(process.cwd(), "src", "cli.ts");
const source = "https://github.com/example/docs";
const other = "https://github.com/example/api";
let temp: string;
let root: string;
let env: Record<string, string | undefined>;
async function cli(args: string[], json = true) {
  const child = Bun.spawn(
    [process.execPath, cliPath, ...args, "--root", root, ...(json ? ["--json"] : [])],
    {
      cwd: temp,
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}
async function ok(args: string[], json = true) {
  const result = await cli(args, json);
  expect(result.code, result.stderr).toBe(0);
  return result;
}
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "dev-repeat-state-"));
  const home = join(temp, "home");
  root = join(temp, "root");
  await mkdir(home);
  env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CI: "1",
    DEV_ROOT: undefined,
    DEV_CWD: undefined,
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
});
afterEach(async () => {
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it("root init distinguishes creation from a byte-preserving no-op", async () => {
  const first = JSON.parse((await ok(["init", root, "--alias", "fixture"])).stdout);
  expect(first).toMatchObject({ created: true, changed: true, defaultRootChanged: true });
  const paths = [join(root, "dev.yaml"), join(root, "AGENTS.md"), join(env.HOME!, ".dev.toml")];
  await writeFile(paths[0]!, "# customized root\nproviders: []\n");
  await writeFile(paths[1]!, "# customized instructions\n");
  const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  const again = JSON.parse((await ok(["init", root, "--alias", "fixture"])).stdout);
  expect(again).toMatchObject({
    created: false,
    changed: false,
    agentsCreated: false,
    registrationChanged: false,
    defaultRootChanged: false,
  });
  expect(await Promise.all(paths.map((path) => readFile(path, "utf8")))).toEqual(before);
  const human = await ok(["init", root, "--alias", "fixture"], false);
  expect(human.stdout.trim()).toBe(`○ ${root} is already a dev root (alias fixture).`);
  expect(human.stderr).toBe("");
});

it("existing root with a new alias/default is changed, not an already-so report", async () => {
  await ok(["init", root, "--alias", "first"]);
  const result = JSON.parse((await ok(["init", root, "--alias", "second"])).stdout);
  expect(result).toMatchObject({
    created: false,
    changed: true,
    registrationChanged: true,
    defaultRoot: "second",
    defaultRootChanged: true,
  });
  const human = await ok(["init", root, "--alias", "third"], false);
  expect(human.stdout).toContain("Updated dev root 'third'");
  expect(human.stdout).toContain("Default Root:  third");
  expect(human.stdout).not.toContain("is already a dev root");
});

it("repairing missing root instructions is a change even when config was not created", async () => {
  await ok(["init", root, "--alias", "fixture"]);
  const before = await readFile(join(root, "dev.yaml"), "utf8");
  await unlink(join(root, "AGENTS.md"));
  const result = JSON.parse((await ok(["init", root, "--alias", "fixture"])).stdout);
  expect(result).toMatchObject({
    created: false,
    changed: true,
    agentsCreated: true,
    registrationChanged: false,
  });
  expect(await readFile(join(root, "dev.yaml"), "utf8")).toBe(before);
});

it("label repeat returns unchanged identity and preserves metadata regardless of key order", async () => {
  await ok(["init", root, "--alias", "fixture"]);
  const args = ["label", "add", "team:docs", source, "--ref", "main"];
  const first = JSON.parse((await ok([...args, "--fields", "owner=ana,area=docs"])).stdout);
  expect(first.added).toEqual([
    { url: source, branch: "main", meta: { owner: "ana", area: "docs" } },
  ]);
  expect(first.unchanged).toEqual([]);
  const before = await readFile(join(root, "dev.yaml"), "utf8");
  const again = JSON.parse((await ok([...args, "--fields", "area=docs,owner=ana"])).stdout);
  expect(again.added).toEqual([]);
  expect(again.unchanged).toEqual(first.added);
  expect(await readFile(join(root, "dev.yaml"), "utf8")).toBe(before);
  const human = await ok(args, false);
  expect(human.stdout).toContain("○ docs @ main already labeled 'team:docs'.");
  expect(human.stdout).not.toContain("✓ Labeled");
  const saved = parse(await readFile(join(root, "dev.yaml"), "utf8"));
  expect(saved.sources[0].labels["team:docs"]).toEqual({ owner: "ana", area: "docs" });
});

it("label changes and unchanged results separate sources and explicit refs", async () => {
  await ok(["init", root, "--alias", "fixture"]);
  await ok(["label", "add", "team:docs", source, "--ref", "main"]);
  const mixed = JSON.parse(
    (await ok(["label", "add", "team:docs", source, other, "--ref", "main"])).stdout,
  );
  expect(mixed.added).toEqual([{ url: other, branch: "main", meta: {} }]);
  expect(mixed.unchanged).toEqual([{ url: source, branch: "main", meta: {} }]);
  const feature = JSON.parse(
    (await ok(["label", "add", "team:docs", source, "--ref", "feature"])).stdout,
  );
  expect(feature.added).toEqual([{ url: source, branch: "feature", meta: {} }]);
  expect(feature.unchanged).toEqual([]);
  const changed = JSON.parse(
    (await ok(["label", "add", "team:docs", source, "--ref", "main", "--fields", "owner=bea"]))
      .stdout,
  );
  expect(changed.added).toEqual([{ url: source, branch: "main", meta: { owner: "bea" } }]);
  expect(changed.unchanged).toEqual([]);
  const saved = parse(await readFile(join(root, "dev.yaml"), "utf8"));
  expect(
    saved.sources.find(
      (s: { url: string; branch: string }) => s.url === source && s.branch === "feature",
    ).labels["team:docs"],
  ).toEqual({});
});

it("same explicit workspace description reuses; conflicting description names both and preserves files", async () => {
  await ok(["init", root, "--alias", "fixture"]);
  const args = ["ws", "init", "sample", "--desc", "Investigate webhook"];
  const first = JSON.parse((await ok(args)).stdout);
  expect(first.created).toBe(true);
  const path = join(root, "ws", "sample", "ws.md");
  await writeFile(path, (await readFile(path, "utf8")) + "\nKeep analyst notes.\n");
  const before = await readFile(path, "utf8");
  const again = JSON.parse((await ok(args)).stdout);
  expect(again).toMatchObject({ created: false, createdAt: first.createdAt });
  const human = await ok(args, false);
  expect(human.stdout).toContain("○ Workspace 'sample' already exists");
  const conflict = await cli(["ws", "init", "sample", "--desc", "Another objective"]);
  expect(conflict.code).toBe(3);
  expect(conflict.stdout).toBe("");
  const error = JSON.parse(conflict.stderr).error;
  expect(error).toMatchObject({
    code: "WORKSPACE_ALREADY_EXISTS",
    existingDescription: "Investigate webhook",
    requestedDescription: "Another objective",
  });
  expect(error.message).toContain("Investigate webhook");
  expect(error.message).toContain("Another objective");
  expect(await readFile(path, "utf8")).toBe(before);
  expect(JSON.parse((await ok(["ws", "init", "sample"])).stdout).created).toBe(false);
});

it("empty description matches absence but cannot silently erase a nonempty objective", async () => {
  await ok(["init", root, "--alias", "fixture"]);
  await ok(["ws", "init", "empty"]);
  expect(JSON.parse((await ok(["ws", "init", "empty", "--desc", ""])).stdout).created).toBe(false);
  await ok(["ws", "init", "nonempty", "--desc", "Keep objective"]);
  const result = await cli(["ws", "init", "nonempty", "--desc", ""]);
  expect(result.code).toBe(3);
  expect(JSON.parse(result.stderr).error).toMatchObject({
    existingDescription: "Keep objective",
    requestedDescription: "",
  });
});
