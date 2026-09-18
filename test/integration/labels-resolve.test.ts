import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";
import type { RuntimeConfig } from "../../src/config.ts";
import { LabelError, resolveLabeledSources } from "../../src/labels.ts";

describe("labeled source resolution integration", () => {
  let tempRoot: string;
  let bareRemote: string;
  let seedDir: string;
  let config: RuntimeConfig;

  async function commitFile(dir: string, file: string, content: string, message: string) {
    await writeFile(join(dir, file), content);
    await git.runGit(["add", "."], { cwd: dir });
    await git.runGit(["commit", "-m", message], { cwd: dir });
    await git.runGit(["push", "-q", "origin", "HEAD:main"], { cwd: dir });
  }

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "example-projectels-root-"));
    bareRemote = join(tempRoot, "remote.git");
    await git.runGit(["init", "--bare", bareRemote, "--initial-branch=main"]);

    seedDir = join(tempRoot, "seed");
    await git.runGit(["init", seedDir, "--initial-branch=main"]);
    await git.runGit(["config", "user.name", "Seeder"], { cwd: seedDir });
    await git.runGit(["config", "user.email", "seed@example.com"], { cwd: seedDir });
    await git.runGit(["remote", "add", "origin", bareRemote], { cwd: seedDir });
    await commitFile(seedDir, "guide.md", "# Wiki guide\n", "docs: guide");
    await git.runGit(["branch", "internal"], { cwd: seedDir });
    await git.runGit(["push", "-q", "origin", "internal"], { cwd: seedDir });

    config = {
      root: tempRoot,
      rootSource: "flag",
      workspacePrefix: "ws/",
      canonicalPrefix: "mirrors/",
      defaults: { workspacePrefix: "ws/", canonicalPrefix: "mirrors/" },
      azureDevOps: {},
      github: { enabled: true },
      trustedScopes: [],
      hooks: {},
      providers: [],
      labelDefs: {
        wiki: {
          qmd_collection: "wiki",
          fields: { role: { type: "string", domain: ["primary"], required: true } },
        },
      },
      sources: [{ url: bareRemote, branch: "main", labels: { wiki: { role: "primary" } } }],
      plugins: {},
      tokens: {},
    } as unknown as RuntimeConfig;
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("materializes checkout and resolves metadata", async () => {
    const { sources, warnings } = await resolveLabeledSources(config, "wiki");
    expect(warnings).toEqual([]);
    expect(sources.length).toBe(1);
    const source = sources[0];
    expect(source.label).toBe("wiki");
    expect(source.meta).toEqual({ qmd_collection: "wiki", role: "primary" });
    expect(source.revision).toEqual({ mode: "track", branch: "main" });
    expect(fs.exists(source.checkoutPath)).toBe(true);
    expect(await fs.readText(join(source.checkoutPath, "guide.md"))).toContain("Wiki guide");
    expect(fs.exists(join(tempRoot, ".dev", "repos", `${source.sourceKey}.git`))).toBe(true);
  });

  it("uses a source path alias for a second branch of the same repository", async () => {
    const branchAwareConfig = {
      ...config,
      sources: [
        { url: bareRemote, branch: "main", labels: { wiki: { role: "primary" } } },
        {
          url: bareRemote,
          branch: "internal",
          path: "wiki-docs-internal",
          labels: { wiki: { role: "primary" } },
        },
      ],
    } as RuntimeConfig;

    const { sources } = await resolveLabeledSources(branchAwareConfig, "wiki");

    expect(sources.map((source) => source.checkoutPath)).toEqual([
      join(tempRoot, "mirrors", "local", "remote"),
      join(tempRoot, "mirrors", "local", "wiki-docs-internal"),
    ]);
    expect(sources.map((source) => source.revision)).toEqual([
      { mode: "track", branch: "main" },
      { mode: "track", branch: "internal" },
    ]);
  });

  it("is idempotent: second resolve returns the same checkout untouched", async () => {
    const first = await resolveLabeledSources(config, "wiki");
    const second = await resolveLabeledSources(config, "wiki");
    expect(second.sources[0].checkoutPath).toBe(first.sources[0].checkoutPath);
    expect(second.sources[0].commitSha).toBe(first.sources[0].commitSha);
  });

  it("aborts before any I/O when assignments violate the label schema", async () => {
    const bad: RuntimeConfig = {
      ...config,
      sources: [{ url: bareRemote, labels: { wiki: { role: "chief" } } }],
    } as RuntimeConfig;
    let error: LabelError | undefined;
    try {
      await resolveLabeledSources(bad, "wiki");
    } catch (e) {
      error = e as LabelError;
    }
    expect(error).toBeInstanceOf(LabelError);
    expect(error?.code).toBe("LABEL_VALIDATION");
    expect(error?.message).toContain("not in domain");
  });

  it("errors when no source carries the label", async () => {
    let code: string | undefined;
    try {
      await resolveLabeledSources(config, "ghost");
    } catch (e) {
      code = (e as LabelError).code;
    }
    expect(code).toBe("LABEL_NOT_FOUND");
  });
});
