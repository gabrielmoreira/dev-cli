import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { generateInstallers } from "../../scripts/generate-installers.ts";

const VERSION = "9.8.7";

type RunResult = { exitCode: number; stdout: string; stderr: string };

async function run(command: string[], env?: Record<string, string>): Promise<RunResult> {
  const child = Bun.spawn(command, {
    env: {
      ...process.env,
      PSModulePath: [
        join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "Modules"),
        join(process.env.ProgramFiles!, "WindowsPowerShell", "Modules"),
      ].join(";"),
      ...env,
    },
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

describe.skipIf(platform() !== "win32")("Windows release installer", () => {
  let tempRoot: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let archive: Uint8Array;
  let checksum: string;
  let asset: string;
  let installerPath: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "sample-project-installer-"));
    const packageDir = join(tempRoot, "package");
    const binaryPath = join(packageDir, "dev.exe");
    const binarySource = join(tempRoot, "version.ts");
    const archivePath = join(tempRoot, "dev-windows.zip");
    const archiveScript = join(tempRoot, "archive.ps1");
    const installerDir = join(tempRoot, "generated");
    const machine = arch() === "arm64" ? "arm64" : "x64";
    asset = `dev-windows-${machine}.zip`;

    await mkdir(packageDir, { recursive: true });
    await writeFile(binarySource, `console.log("dev v${VERSION}");\n`);
    const built = await run([
      process.execPath,
      "build",
      "--compile",
      binarySource,
      "--outfile",
      binaryPath,
    ]);
    expect(built.exitCode).toBe(0);

    await writeFile(
      archiveScript,
      "param([string]$Source, [string]$Destination)\nCompress-Archive -LiteralPath $Source -DestinationPath $Destination -Force\n",
    );
    const packed = await run([
      "powershell.exe",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      archiveScript,
      binaryPath,
      archivePath,
    ]);
    expect(packed.exitCode).toBe(0);

    archive = new Uint8Array(await Bun.file(archivePath).arrayBuffer());
    checksum = createHash("sha256").update(archive).digest("hex");
    await generateInstallers(VERSION, installerDir);
    installerPath = join(installerDir, "dev-installer.ps1");

    server = Bun.serve({
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        const releasePath = `/download/v${VERSION}`;
        if (pathname === `${releasePath}/${asset}`) return new Response(archive);
        if (pathname === `${releasePath}/SHA256SUMS`) {
          return new Response(`${checksum}  ${asset}\n`);
        }
        return new Response("Not found", { status: 404 });
      },
    });
  });

  afterAll(async () => {
    server?.stop(true);
    if (tempRoot) {
      await rm(tempRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  });

  it("verifies, extracts, and runs the local release without changing user PATH", async () => {
    const installDir = join(tempRoot!, "install-bin");
    const installedPath = join(installDir, "dev.exe");
    const userPathBefore = await run([
      "powershell.exe",
      "-NoProfile",
      "-Command",
      "[Environment]::GetEnvironmentVariable('Path', 'User')",
    ]);
    const result = await run(
      ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installerPath],
      {
        DEV_INSTALL_DIR: installDir,
        DEV_NO_MODIFY_PATH: "1",
        DEV_RELEASES_URL: `http://127.0.0.1:${server!.port}`,
      },
    );

    expect(result.exitCode).toBe(0);
    const installed = await run([installedPath, "--version"]);
    expect(installed.exitCode).toBe(0);
    expect(installed.stdout.trim()).toBe(`dev v${VERSION}`);

    const userPathAfter = await run([
      "powershell.exe",
      "-NoProfile",
      "-Command",
      "[Environment]::GetEnvironmentVariable('Path', 'User')",
    ]);
    expect(userPathAfter.stdout).toBe(userPathBefore.stdout);
  }, 30_000);
});
