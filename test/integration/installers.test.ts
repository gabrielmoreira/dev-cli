import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";

const VERSION = "9.8.7";

function releaseAssetName(): string {
  const machine = arch() === "arm64" ? "arm64" : "x64";
  if (platform() === "darwin") return `dev-darwin-${machine}.tar.gz`;
  if (platform() === "linux") return `dev-linux-${machine}.tar.gz`;
  throw new Error(`Unsupported test platform: ${platform()}`);
}

async function run(
  command: string[],
  env?: Record<string, string>,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn(command, {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe.skipIf(platform() === "win32")("release installers", () => {
  let tempRoot: string;
  let archive: Uint8Array;
  let checksum: string;
  let server: ReturnType<typeof Bun.serve>;
  let installerPath: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-installers-"));
    const packageDir = join(tempRoot, "package");
    const executable = join(packageDir, "dev");
    const archivePath = join(tempRoot, releaseAssetName());
    const outputDir = join(tempRoot, "installers");

    await mkdir(packageDir, { recursive: true });
    await writeFile(executable, `#!/bin/sh\necho "dev v${VERSION}"\n`);
    await chmod(executable, 0o755);

    const packed = await run(["tar", "-czf", archivePath, "-C", packageDir, "dev"]);
    expect(packed.exitCode).toBe(0);

    archive = new Uint8Array(await Bun.file(archivePath).arrayBuffer());
    checksum = createHash("sha256").update(archive).digest("hex");

    const generated = await run([
      "bun",
      join(process.cwd(), "scripts", "generate-installers.ts"),
      VERSION,
      outputDir,
    ]);
    expect(generated.exitCode).toBe(0);
    installerPath = join(outputDir, "dev-installer.sh");

    server = Bun.serve({
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        const releasePath = `/download/v${VERSION}`;
        if (pathname === `${releasePath}/${releaseAssetName()}`) {
          return new Response(archive);
        }
        if (pathname === `${releasePath}/SHA256SUMS`) {
          return new Response(`${checksum}  ${releaseAssetName()}\n`);
        }
        return new Response("Not found", { status: 404 });
      },
    });
  });

  afterAll(async () => {
    server?.stop(true);
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("installs the matching release asset after verifying its checksum", async () => {
    const installDir = join(tempRoot, "success-bin");
    const result = await run(["sh", installerPath], {
      DEV_INSTALL_DIR: installDir,
      DEV_NO_MODIFY_PATH: "1",
      DEV_RELEASES_URL: `http://127.0.0.1:${server.port}`,
    });

    expect(result.exitCode).toBe(0);
    const installed = await run([join(installDir, "dev"), "--version"]);
    expect(installed.exitCode).toBe(0);
    expect(installed.stdout.trim()).toBe(`dev v${VERSION}`);
  });

  it("preserves an existing installation when checksum verification fails", async () => {
    const installDir = join(tempRoot, "preserved-bin");
    const installedPath = join(installDir, "dev");
    await mkdir(installDir, { recursive: true });
    await writeFile(installedPath, "existing installation\n");
    checksum = "0".repeat(64);

    const result = await run(["sh", installerPath], {
      DEV_INSTALL_DIR: installDir,
      DEV_NO_MODIFY_PATH: "1",
      DEV_RELEASES_URL: `http://127.0.0.1:${server.port}`,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Checksum mismatch");
    expect(await readFile(installedPath, "utf8")).toBe("existing installation\n");
  });
});
