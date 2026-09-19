#!/usr/bin/env bun

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const VERSION_TOKEN = "__DEV_VERSION__";
const SEMANTIC_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export async function generateInstallers(version: string, outputDirectory: string): Promise<void> {
  if (!SEMANTIC_VERSION.test(version)) {
    throw new Error(`Invalid semantic version: ${version}`);
  }

  await mkdir(outputDirectory, { recursive: true });
  for (const [templateName, outputName] of [
    ["install.sh", "dev-installer.sh"],
    ["install.ps1", "dev-installer.ps1"],
  ] as const) {
    const template = await readFile(join(import.meta.dir, templateName), "utf8");
    if (!template.includes(VERSION_TOKEN)) {
      throw new Error(`${templateName} does not contain ${VERSION_TOKEN}`);
    }
    const output = join(outputDirectory, outputName);
    await writeFile(output, template.replaceAll(VERSION_TOKEN, version));
    if (outputName.endsWith(".sh")) await chmod(output, 0o755);
  }
}

if (import.meta.main) {
  const [version, outputDirectory] = Bun.argv.slice(2);
  if (!version || !outputDirectory) {
    throw new Error(
      "Usage: bun scripts/generate-installers.ts <semantic-version> <output-directory>",
    );
  }
  await generateInstallers(version, outputDirectory);
}
