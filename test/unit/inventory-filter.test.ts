import { describe, expect, test } from "bun:test";
import { filterInventory, isExplicitSource } from "../../src/inventory";
import type { InventoryRecord } from "../../src/cache";

describe("Inventory Filtering & Search (Phase 11)", () => {
  const sampleRecords: InventoryRecord[] = [
    {
      id: "1",
      name: "alpha-service",
      url: "https://dev.azure.com/org/lab/_git/alpha-service",
      default_branch: "main",
      description: "Core alpha processing microservice",
      last_changed: "2026-09-01T00:00:00Z",
      syncedAt: "2026-09-01T00:00:00Z",
      project: "lab",
    },
    {
      id: "2",
      name: "alpha-gateway",
      url: "https://dev.azure.com/org/lab/_git/alpha-gateway",
      default_branch: "main",
      description: "Gateway router",
      last_changed: "2026-09-01T00:00:00Z",
      syncedAt: "2026-09-01T00:00:00Z",
      project: "lab",
    },
    {
      id: "3",
      name: "billing-payments",
      url: "https://dev.azure.com/org/finance/_git/billing-payments",
      default_branch: "master",
      description: "Payments service featuring alpha testing",
      last_changed: "2026-09-01T00:00:00Z",
      syncedAt: "2026-09-01T00:00:00Z",
      project: "finance",
    },
    {
      id: "4",
      name: "dev-cli",
      url: "https://dev.azure.com/org/tools/_git/dev-cli",
      default_branch: "main",
      description: "Developer CLI engine",
      last_changed: "2026-09-01T00:00:00Z",
      syncedAt: "2026-09-01T00:00:00Z",
      project: "tools",
    },
  ];

  test("recognizes repository URIs without restricting their scheme", () => {
    for (const source of [
      "https://github.com/org/repo",
      "http://git.example.com/org/repo",
      "ssh://git@example.com/org/repo",
      "git://example.com/org/repo",
      "file:///tmp/repo.git",
      "custom+git://example.com/org/repo",
      "git@example.com:org/repo.git",
    ]) {
      expect(isExplicitSource(source)).toBe(true);
    }
    expect(isExplicitSource("repository-name")).toBe(false);
  });

  test("returns all records when query is empty or undefined", () => {
    expect(filterInventory(sampleRecords)).toHaveLength(4);
    expect(filterInventory(sampleRecords, "")).toHaveLength(4);
    expect(filterInventory(sampleRecords, "   ")).toHaveLength(4);
  });

  test("exact match on name is ranked first", () => {
    const results = filterInventory(sampleRecords, "alpha-service");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe("alpha-service");
  });

  test("prefix match on name is ranked before description match", () => {
    // "alpha" matches alpha-gateway (prefix), alpha-service (prefix), and billing-payments (in description)
    const results = filterInventory(sampleRecords, "alpha");
    expect(results.length).toBe(3);
    expect(results[0].name).toContain("alpha-");
    expect(results[1].name).toContain("alpha-");
    expect(results[2].name).toBe("billing-payments");
  });

  test("matches project name", () => {
    const results = filterInventory(sampleRecords, "finance");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("billing-payments");
  });

  test("case insensitive matching", () => {
    const results = filterInventory(sampleRecords, "DEV-CLI");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("dev-cli");
  });

  test("returns empty array when no record matches query", () => {
    const results = filterInventory(sampleRecords, "nonexistent-xyz");
    expect(results).toEqual([]);
  });
});
