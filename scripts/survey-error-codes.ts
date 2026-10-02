import { fileURLToPath } from "node:url";

/** Finite app-owned codes, including classified unions and codes attached to plain errors. */
export async function surveyErrorCodes(
  root = fileURLToPath(new URL("../src/", import.meta.url)),
): Promise<string[]> {
  const codes = new Set<string>();
  for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: root, absolute: true })) {
    const text = await Bun.file(path).text();
    for (const match of text.matchAll(/new\s+\w+Error\s*\(\s*["']([A-Z][A-Z0-9_]+)["']/g))
      codes.add(match[1]!);
    for (const match of text.matchAll(/\bcode\s*(?:=|:)\s*["']([A-Z][A-Z0-9_]+)["']/g))
      codes.add(match[1]!);
    for (const match of text.matchAll(/\bcode\s*:\s*((?:["'][A-Z][A-Z0-9_]+["']\s*\|?\s*)+)/g)) {
      for (const literal of match[1]!.matchAll(/["']([A-Z][A-Z0-9_]+)["']/g))
        codes.add(literal[1]!);
    }
    for (const match of text.matchAll(
      /(?:type\s+\w+ErrorCode\s*=|readonly\s+code\s*:)\s*([^;]+);/g,
    )) {
      for (const literal of match[1]!.matchAll(/["']([A-Z][A-Z0-9_]+)["']/g))
        codes.add(literal[1]!);
    }
  }
  return [...codes].sort();
}

if (import.meta.main) console.log(JSON.stringify(await surveyErrorCodes(), null, 2));
