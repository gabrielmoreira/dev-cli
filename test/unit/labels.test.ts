import { describe, expect, it } from "bun:test";
import {
  parseDeclaredSources,
  parseLabelDefs,
  resolveLabelAssignments,
  resolveLabelMeta,
  type LabelDef,
} from "../../src/labels.ts";

describe("labels core", () => {
  describe("parseLabelDefs", () => {
    it("separates fixed values from field schemas", () => {
      const { defs, warnings } = parseLabelDefs({
        qmd_wiki: {
          qmd_collection: "wiki",
          fields: {
            role: { type: "string", domain: ["primary", "mirror"], required: true },
            priority: { type: "int", domain: "1-9", min: 1, max: 9, default: 5 },
          },
        },
      });
      expect(warnings).toEqual([]);
      const def = defs.qmd_wiki;
      expect(def.fixed).toEqual({ qmd_collection: "wiki" });
      expect(def.fields.role.required).toBe(true);
      expect(def.fields.role.domain).toEqual(["primary", "mirror"]);
      expect(def.fields.priority.default).toBe(5);
    });

    it("warns and drops fields with unknown types", () => {
      const { defs, warnings } = parseLabelDefs({
        x: { fields: { bad: { type: "date" }, good: { type: "bool" } } },
      });
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("unknown type 'date'");
      expect(defs.x.fields.bad).toBeUndefined();
      expect(defs.x.fields.good.type).toBe("bool");
    });
  });

  describe("resolveLabelMeta", () => {
    const def: LabelDef = {
      fixed: { qmd_collection: "wiki" },
      fields: {
        role: { type: "string", domain: ["primary", "mirror"], required: true },
        priority: { type: "int", min: 1, max: 9, default: 5, required: false },
      },
    };

    it("applies fixed values and defaults, coerces types", () => {
      const { meta, errors } = resolveLabelMeta(def, "qmd_wiki", {
        role: "primary",
        priority: "3",
      });
      expect(errors).toEqual([]);
      expect(meta).toEqual({ qmd_collection: "wiki", role: "primary", priority: 3 });
    });

    it("errors on missing required and domain violations", () => {
      const missing = resolveLabelMeta(def, "qmd_wiki", {});
      expect(missing.errors.join(" ")).toContain("required field 'role' is missing");
      const badDomain = resolveLabelMeta(def, "qmd_wiki", { role: "chief" });
      expect(badDomain.errors.join(" ")).toContain("not in domain");
      const badRange = resolveLabelMeta(def, "qmd_wiki", { role: "primary", priority: 42 });
      expect(badRange.errors.join(" ")).toContain("max 9");
    });

    it("warns on unknown assignment fields but still resolves", () => {
      const { meta, warnings } = resolveLabelMeta(def, "qmd_wiki", { role: "primary", rolle: "x" });
      expect(warnings.join(" ")).toContain("unknown field 'rolle'");
      expect(meta.role).toBe("primary");
    });
  });

  describe("parseDeclaredSources", () => {
    it("normalizes label assignments to map form and skips url-less entries", () => {
      const { sources, warnings } = parseDeclaredSources([
        {
          url: "https://github.com/org/wiki",
          branch: "main",
          labels: { qmd_wiki: { role: "primary" } },
        },
        { url: "https://github.com/org/infra", labels: { infra: null } },
        { nope: true },
      ]);
      expect(warnings.length).toBe(1);
      expect(sources.length).toBe(2);
      expect(sources[0].branch).toBe("main");
      expect(sources[1].labels.infra).toEqual({});
    });
  });

  describe("resolveLabelAssignments", () => {
    it("collects matches, validation errors, and undefined-def warnings", () => {
      const result = resolveLabelAssignments(
        {
          labelDefs: {
            work: { fields: { team: { type: "string", required: true } } },
          },
          sources: [
            { url: "https://a", labels: { work: { team: "core" } } },
            { url: "https://b", labels: { work: {} } },
            { url: "https://c", labels: { other: {} } },
          ],
        },
        "work",
      );
      expect(result.matches.length).toBe(2);
      expect(result.matches[0].meta.team).toBe("core");
      expect(result.errors.join(" ")).toContain("required field 'team'");
      const undeclared = resolveLabelAssignments({ labelDefs: {}, sources: [] }, "ghost");
      expect(undeclared.warnings.join(" ")).toContain("no entry in label_defs");
    });
  });
});
