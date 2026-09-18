import { afterAll, describe, expect, mock, test } from "bun:test";

mock.module("@clack/prompts", () => ({
  autocomplete: async () => "repository-a",
  autocompleteMultiselect: async () => ["repository-a", "repository-b"],
  isCancel: () => false,
}));

afterAll(() => mock.restore());

describe("CLI searchable selection", () => {
  test("returns every value selected by the autocomplete multiselect prompt", async () => {
    const { ui } = await import("../../src/ui.ts");
    const selectableUi = ui as typeof ui & {
      multiSelect<T extends string>(
        message: string,
        options: Array<{ label: string; value: T }>,
      ): Promise<T[]>;
    };

    expect(typeof selectableUi.multiSelect).toBe("function");
    const selected = await selectableUi.multiSelect("Select repositories", [
      { label: "Repository A", value: "repository-a" },
      { label: "Repository B", value: "repository-b" },
    ]);

    expect(selected).toEqual(["repository-a", "repository-b"]);
  });
});
