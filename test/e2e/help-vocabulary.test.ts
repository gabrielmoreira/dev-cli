import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Help speaks the user's words: these name how dev works inside, not what a
// person or an agent reading the help has in front of them.
const INTERNAL_TERMS = [
  "canonical",
  "inventory",
  "desired vs observed",
  "discovery source",
  "scoped registry",
  "$dev_root",
  "admin repo",
];

/** Every description in the agent help, with where it sits in the command tree. */
function descriptions(node: unknown, path = "dev"): { path: string; text: string }[] {
  if (Array.isArray(node)) return node.flatMap((item) => descriptions(item, path));
  if (!node || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  const here = typeof record.name === "string" ? `${path} ${record.name}` : path;
  return Object.entries(record).flatMap(([key, value]) =>
    key === "description" && typeof value === "string"
      ? [{ path: here, text: value }]
      : descriptions(value, here),
  );
}

it("describes every command and argument without internal vocabulary", async () => {
  const home = await mkdtemp(join(tmpdir(), "dev-help-vocabulary-"));
  try {
    const child = Bun.spawn(
      [Bun.which("bun")!, join(process.cwd(), "src", "cli.ts"), "--help", "--llms"],
      {
        cwd: home,
        env: { ...process.env, HOME: home, USERPROFILE: home, CI: "1", DEV_ROOT: undefined },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    const schema = JSON.parse(stdout) as {
      commands: unknown;
      resources: { task: string; action: string; note?: string }[];
    };
    const all = descriptions(schema.commands);
    expect(all.length).toBeGreaterThan(100);
    // The agent block is prose too, and a reader meets it through --help and --llms.
    const resources = schema.resources.flatMap(({ task, action, note }) => [
      { path: `dev resources: ${task}`, text: task },
      { path: `dev resources: ${task}`, text: action },
      ...(note ? [{ path: `dev resources: ${task}`, text: note }] : []),
    ]);
    expect(resources.length).toBeGreaterThan(0);
    const leaks = [...all, ...resources].flatMap(({ path, text }) =>
      INTERNAL_TERMS.filter((term) => text.toLowerCase().includes(term)).map(
        (term) => `${path}: '${term}' in "${text}"`,
      ),
    );
    expect(leaks).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
