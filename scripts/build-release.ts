#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface ReleaseTarget {
  id: string;
  bunTarget: string;
  windows?: boolean;
}

const targets: ReleaseTarget[] = [
  { id: "darwin-arm64", bunTarget: "bun-darwin-arm64" },
  { id: "darwin-x64", bunTarget: "bun-darwin-x64" },
  { id: "linux-arm64", bunTarget: "bun-linux-arm64" },
  { id: "linux-x64", bunTarget: "bun-linux-x64" },
  { id: "linux-arm64-musl", bunTarget: "bun-linux-arm64-musl" },
  { id: "linux-x64-musl", bunTarget: "bun-linux-x64-musl" },
  { id: "windows-arm64", bunTarget: "bun-windows-arm64", windows: true },
  { id: "windows-x64", bunTarget: "bun-windows-x64", windows: true },
];

const version = Bun.argv[2];
if (
  !version ||
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
    version,
  )
) {
  throw new Error("Usage: bun scripts/build-release.ts <semantic-version> [target-id ...]");
}
const requestedTargetIds = Bun.argv.slice(3);
const selectedTargets =
  requestedTargetIds.length === 0
    ? targets
    : requestedTargetIds.map((id) => {
        const target = targets.find((candidate) => candidate.id === id);
        if (!target) throw new Error(`Unsupported release target: ${id}`);
        return target;
      });

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const staging = join(dist, "staging");

async function run(command: string[]): Promise<void> {
  const process = Bun.spawn(command, {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
  }
}

await rm(dist, { recursive: true, force: true });
await mkdir(staging, { recursive: true });

const checksums: string[] = [];
for (const target of selectedTargets) {
  const targetDirectory = join(staging, target.id);
  const executableName = target.windows ? "dev.exe" : "dev";
  const executable = join(targetDirectory, executableName);
  await mkdir(targetDirectory, { recursive: true });

  await run([
    "bun",
    "build",
    "--compile",
    "--minify",
    "--target",
    target.bunTarget,
    "--define",
    `DEV_VERSION=${JSON.stringify(version)}`,
    "src/cli.ts",
    "--outfile",
    executable,
  ]);

  if (!target.windows) await chmod(executable, 0o755);

  const archiveName = target.windows ? `dev-${target.id}.zip` : `dev-${target.id}.tar.gz`;
  const archive = join(dist, archiveName);
  if (target.windows) {
    await run(["zip", "-j", "-q", archive, executable]);
  } else {
    await run(["tar", "-czf", archive, "-C", targetDirectory, executableName]);
  }

  const hasher = createHash("sha256");
  for await (const chunk of Bun.file(archive).stream()) hasher.update(chunk);
  const digest = hasher.digest("hex");
  checksums.push(`${digest}  ${archiveName}`);
}

await rm(staging, { recursive: true, force: true });
await writeFile(join(dist, "SHA256SUMS"), `${checksums.join("\n")}\n`);
