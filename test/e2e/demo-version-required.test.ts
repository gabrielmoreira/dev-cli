import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const bash =
  process.platform === "win32"
    ? join(dirname(Bun.which("git") ?? ""), "..", "bin", "bash.exe")
    : "bash";

describe.skipIf(process.platform === "win32" && !existsSync(bash))(
  "demo render version input",
  () => {
    it("rejects an unset DEV_VERSION before loading demo credentials", async () => {
      const root = await mkdtemp(join(tmpdir(), "dev-cli-demo-version-"));
      try {
        const script = join(root, "docs", "demo", "render.sh");
        await mkdir(dirname(script), { recursive: true });
        // Run the actual renderer in a root without a .env, so even a regression cannot build.
        await copyFile(join(process.cwd(), "docs", "demo", "render.sh"), script);
        const env: NodeJS.ProcessEnv = { ...process.env, OPENROUTER_API_KEY: "" };
        delete env.DEV_VERSION;
        const child = Bun.spawn([bash, "--noprofile", "--norc", script.replace(/\\/g, "/")], {
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
        ]);
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain("DEV_VERSION is required");
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  },
);
