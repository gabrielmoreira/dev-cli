import { afterAll, describe, expect, mock, test } from "bun:test";
import * as prompts from "@clack/prompts";

type Option = { label?: string; value: string };
type PromptConfig = {
  options: Option[] | ((this: { userInput: string }) => Option[]);
  filter?: (search: string, option: Option) => boolean;
};

let typed = "";

/** Plays the user typing `typed`: the options the prompt would list, filtered as it would filter them. */
function visible(config: PromptConfig): string[] {
  const options =
    typeof config.options === "function"
      ? config.options.call({ userInput: typed })
      : config.options;
  return options
    .filter((option) => !typed || !config.filter || config.filter(typed, option))
    .map((option) => option.value);
}

mock.module("@clack/prompts", () => ({
  ...prompts,
  autocomplete: async (config: PromptConfig) => visible(config)[0],
  autocompleteMultiselect: async (config: PromptConfig) => visible(config),
  isCancel: () => false,
}));

afterAll(() => mock.restore());

const options = [
  { label: "feature/login-flow", value: "feature/login-flow" },
  { label: "main", value: "main" },
  { label: "Billing API (ado-contoso)", value: "ado-contoso-billing-api" },
];

describe("CLI searchable selection", () => {
  test("select finds an option by a fuzzy, non-prefix query", async () => {
    const { ui } = await import("../../src/ui.ts");
    typed = "lgf";
    expect(await ui.select("Branch", options)).toBe("feature/login-flow");
    typed = "bapi";
    expect(await ui.select("Repository", options)).toBe("ado-contoso-billing-api");
  });

  test("multiSelect lists only the options the fuzzy query matches", async () => {
    const { ui } = await import("../../src/ui.ts");
    typed = "mn";
    expect(await ui.multiSelect("Repositories", options)).toEqual(["main"]);
  });
});
