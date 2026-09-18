import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { setSourceLabel, upsertSourceDeclaration } from "../../src/labels.ts";
import { resolveConfig } from "../../src/config.ts";

const YAML_WITH_COMMENTS = `# dev root configuration
sources:
  # legacy docs repo
  - url: https://github.com/org/docs
    branch: main
  - url: https://github.com/org/api
    branch: main
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

  it("sets a label with meta without losing comments", () => {
    const doc = parseDocument(YAML_WITH_COMMENTS);
    const result = setSourceLabel(doc, "https://github.com/org/docs", "qmd_wiki", {
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
    const result = setSourceLabel(doc, "https://github.com/org/ghost", "x", undefined);
    expect(result.found).toBe(false);
    expect(result.changed).toBe(false);
  });

  it("removes a label and drops the empty labels key", () => {
    const doc = parseDocument(YAML_WITH_COMMENTS);
    setSourceLabel(doc, "https://github.com/org/api", "qmd_wiki", { role: "primary" });
    const removed = setSourceLabel(doc, "https://github.com/org/api", "qmd_wiki", undefined);

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
