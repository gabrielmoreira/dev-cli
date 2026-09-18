import { describe, expect, it } from "bun:test";
import {
  deriveWorkspaceNameFromRepository,
  deriveWorkspacePath,
  validateWorkspaceName,
} from "../../src/ws.ts";

describe("Workspace pure domain rules (Phase 1)", () => {
  it("validates valid workspace names", () => {
    expect(validateWorkspaceName("alpha").valid).toBe(true);
    expect(validateWorkspaceName("checkout-payment-fix").valid).toBe(true);
    expect(validateWorkspaceName("feature_123").valid).toBe(true);
    expect(validateWorkspaceName("v1.2.0").valid).toBe(true);
  });

  it("rejects invalid workspace names", () => {
    expect(validateWorkspaceName("").valid).toBe(false);
    expect(validateWorkspaceName("   ").valid).toBe(false);
    expect(validateWorkspaceName(".").valid).toBe(false);
    expect(validateWorkspaceName("..").valid).toBe(false);
    expect(validateWorkspaceName("a/b").valid).toBe(false);
    expect(validateWorkspaceName("a\\b").valid).toBe(false);
    expect(validateWorkspaceName("-bad").valid).toBe(false);
    expect(validateWorkspaceName("bad space").valid).toBe(false);
  });

  it("derives a stable provider-prefixed name from repository URLs", () => {
    expect(deriveWorkspaceNameFromRepository("https://github.com/can1357/oh-my-pi.git")).toBe(
      "gh-can1357-oh-my-pi",
    );
    expect(
      deriveWorkspaceNameFromRepository(
        "https://dev.azure.com/example-org/platform/_git/payments-api",
      ),
    ).toBe("ado-example-org-payments-api");
  });

  it("treats file URIs as local repositories", () => {
    expect(deriveWorkspaceNameFromRepository("file:///tmp/oh-my-pi.git")).toBe("local-oh-my-pi");
  });

  it("derives workspace path strictly under $DEV_ROOT/ws/<name>", () => {
    const derived = deriveWorkspacePath("/home/user/dev", "my-task");
    expect(derived.replace(/\\/g, "/")).toBe("/home/user/dev/ws/my-task");
  });
});
