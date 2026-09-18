import * as mirror from "../mirror.ts";
import { resolveChoiceInput, type ResolvedCliInput } from "./input.ts";

export interface ResolveMirrorSourceInputOptions {
  value?: string;
  root: string;
  canonicalPrefix?: string;
  command: string;
  usage: string;
}

export async function resolveMirrorSourceInput(
  options: ResolveMirrorSourceInputOptions,
): Promise<ResolvedCliInput<string>> {
  return await resolveChoiceInput({
    value: options.value,
    choices: async () => {
      const sources = new Map<string, string>();
      for (const item of await mirror.list({
        root: options.root,
        canonicalPrefix: options.canonicalPrefix,
      })) {
        if (item.sourceUrl && !sources.has(item.sourceUrl)) {
          sources.set(item.sourceUrl, item.name);
        }
      }
      return [...sources].map(([value, name]) => ({ label: name, value }));
    },
    message: "Select mirror source",
    required: {
      command: options.command,
      field: "source",
      usage: options.usage,
      description: "Mirror source",
    },
  });
}
