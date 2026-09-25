import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import {
  parseDeclaredSources,
  planLabelTarget,
  renameLabel,
  setSourceLabel,
  upsertSourceDeclaration,
} from "../../src/labels.ts";
import { resolveConfig } from "../../src/config.ts";

const YAML_WITH_COMMENTS = `# dev root configuration
sources:
  # legacy docs repo
  - url: https://github.com/org/docs
    branch: main
  - url: https://github.com/org/api
    branch: main
`;

const YAML_WITH_MULTIPLE_REFS = `sources:
  - url: https://github.com/org/wiki
    branch: master
  - url: https://github.com/org/wiki
    branch: internal
`;

describe("label source declaration editing", () => {
  it("upserts a source declaration preserving comments", () => {
    const doc = parseDocument(YAML_WITH_COMMENTS);
    const result = upsertSourceDeclaration(doc, {
      url: "https://github.com/org/wiki",
      branch: "develop",
    });

    expect(result.changed).toBe(true);
    const text = String(doc);
    expect(text).toContain("# dev root configuration");
    expect(text).toContain("# legacy docs repo");
    expect(text).toContain("url: https://github.com/org/wiki");
    expect(text).toContain("branch: develop");
    // untouched siblings survive
    expect(text).toContain("url: https://github.com/org/docs");
  });

  it("upsert is idempotent for an existing url", () => {
    const doc = parseDocument(YAML_WITH_COMMENTS);
    const first = upsertSourceDeclaration(doc, { url: "https://github.com/org/docs" });
    expect(first.changed).toBe(false);
  });

  it("keeps separate declarations for different branches of one URL", () => {
    const doc = parseDocument(YAML_WITH_MULTIPLE_REFS);

    const result = upsertSourceDeclaration(doc, {
      url: "https://github.com/org/wiki",
      branch: "preview",
    });

    expect(result.changed).toBe(true);
    const sources = (doc.toJS() as { sources: Array<Record<string, unknown>> }).sources;
    expect(sources.map((source) => source.branch)).toEqual(["master", "internal", "preview"]);
  });

  it("sets a label only on the selected branch", () => {
    const doc = parseDocument(YAML_WITH_MULTIPLE_REFS);

    const result = setSourceLabel(
      doc,
      { url: "https://github.com/org/wiki", branch: "internal" },
      "docs:internal",
      {},
    );

    expect(result).toEqual({ changed: true, found: true });
    const sources = (doc.toJS() as { sources: Array<Record<string, unknown>> }).sources;
    expect(sources[0]?.labels).toBeUndefined();
    expect(sources[1]?.labels).toEqual({ "docs:internal": {} });
  });

  it("sets a label with meta without losing comments", () => {
    const doc = parseDocument(YAML_WITH_COMMENTS);
    const result = setSourceLabel(doc, { url: "https://github.com/org/docs" }, "qmd_wiki", {
      role: "primary",
    });

    expect(result.found).toBe(true);
    expect(result.changed).toBe(true);
    const text = String(doc);
    expect(text).toContain("# legacy docs repo");
    expect(text).toContain("qmd_wiki:");
    expect(text).toContain("role: primary");
  });

  it("reports found false for an undeclared source", () => {
    const doc = parseDocument(YAML_WITH_COMMENTS);
    const result = setSourceLabel(doc, { url: "https://github.com/org/ghost" }, "x", undefined);
    expect(result.found).toBe(false);
    expect(result.changed).toBe(false);
  });

  it("removes a label and drops the empty labels key", () => {
    const doc = parseDocument(YAML_WITH_COMMENTS);
    setSourceLabel(doc, { url: "https://github.com/org/api" }, "qmd_wiki", {
      role: "primary",
    });
    const removed = setSourceLabel(
      doc,
      { url: "https://github.com/org/api" },
      "qmd_wiki",
      undefined,
    );

    expect(removed.found).toBe(true);
    expect(removed.changed).toBe(true);
    expect(String(doc)).not.toContain("labels:");
  });
});

describe("config document round-trip", () => {
  it("resolveConfig exposes the parsed doc and writeConfig persists edits", () => {
    const root = mkdtempSync(join(tmpdir(), "dev-cli-config-doc-"));
    try {
      writeFileSync(join(root, "dev.yaml"), YAML_WITH_COMMENTS);
      const config = resolveConfig({ cwd: root, env: {} });

      expect(config.configDoc).toBeDefined();
      expect(typeof config.writeConfig).toBe("function");

      upsertSourceDeclaration(config.configDoc!, {
        url: "https://github.com/org/wiki",
        branch: "main",
      });
      config.writeConfig!();

      const onDisk = readFileSync(join(root, "dev.yaml"), "utf8");
      expect(onDisk).toContain("# dev root configuration");
      expect(onDisk).toContain("url: https://github.com/org/wiki");

      // A fresh parse sees the new source
      const reloaded = resolveConfig({ cwd: root, env: {} });
      const urls = reloaded.sources.map((s) => s["url"]);
      expect(urls).toContain("https://github.com/org/wiki");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("label rename", () => {
  it("renames a label on sources, its definition, and workset members, keeping comments", () => {
    const doc = parseDocument(`label_defs:
  team:pay: {} # owners
sources:
  - url: https://github.com/org/api
    labels:
      team:pay: {}
      docs: {}
worksets:
  incident:
    members:
      - label: team:pay
      - source: https://github.com/org/web
`);
    const renamed = renameLabel(doc, "team:pay", "team:payments");
    expect(renamed).toEqual({ sources: 1, def: true, worksetMembers: 1 });
    const text = doc.toString();
    expect(text).not.toContain("team:pay:");
    expect(text).toContain("team:payments: {} # owners");
    expect(text).toContain("label: team:payments");
    expect(text).toContain("docs: {}");
  });

  it("refuses a name a source already carries, before changing anything", () => {
    const doc = parseDocument(`sources:
  - url: https://github.com/org/api
    labels:
      a: {}
      b: {}
`);
    expect(() => renameLabel(doc, "a", "b")).toThrow("already carries label 'b'");
    expect(doc.toString()).toContain("a: {}");
  });
});

describe("label target planning", () => {
  const declared = parseDeclaredSources(
    parseDocument(YAML_WITH_MULTIPLE_REFS).toJS().sources,
  ).sources;

  it("reuses the one declaration of a repository, whatever form its URL takes", () => {
    const plan = planLabelTarget(
      parseDeclaredSources([{ url: "https://github.com/org/docs", branch: "main" }]).sources,
      "https://github.com/org/docs.git",
    );
    expect(plan).toEqual({
      selector: { url: "https://github.com/org/docs", branch: "main" },
      declared: true,
    });
  });

  it("declares an unknown repository without a branch, so it follows the remote default", () => {
    expect(planLabelTarget(declared, "https://github.com/org/new")).toEqual({
      selector: { url: "https://github.com/org/new" },
      declared: false,
    });
  });

  it("asks which ref when several are declared and no branch was chosen", () => {
    const plan = planLabelTarget(declared, "https://github.com/org/wiki");
    expect("ambiguous" in plan && plan.ambiguous.map((s) => s.branch)).toEqual([
      "master",
      "internal",
    ]);
  });

  it("declares a new ref of a known repository when a branch is chosen", () => {
    expect(planLabelTarget(declared, "https://github.com/org/wiki", "release")).toEqual({
      selector: { url: "https://github.com/org/wiki", branch: "release" },
      declared: false,
    });
  });
});
