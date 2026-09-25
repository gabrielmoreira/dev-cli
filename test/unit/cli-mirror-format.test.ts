import { describe, expect, test } from "bun:test";
import { formatMirrorSync } from "../../src/cli/mirror.ts";
import type { MirrorSyncResult } from "../../src/mirror.ts";

const result = (skipped: MirrorSyncResult["skipped"]): MirrorSyncResult => ({
  updated: [],
  skipped,
  stashed: [],
  refreshFailures: [],
  trace: { totalMs: 0, stages: [], slowestItems: [] },
});

describe("formatMirrorSync", () => {
  test("counts a mirror already at its remote as up to date, not skipped", () => {
    const lines = formatMirrorSync(
      result([{ path: "/m/a", branch: "main", status: "skipped", reason: "UP_TO_DATE" }]),
    );
    expect(lines).toEqual(["○ 1 up to date"]);
  });

  test("names a failed fast-forward by git's fatal line, not its whole stderr", () => {
    const stderr = [
      "Failed to fast-forward worktree at /m/wiki:",
      "warning: unable to unlink 'docs/a.md': Permission denied",
      "error: unable to create file docs/b.md: Permission denied",
      "fatal: cannot create directory at 'docs/c': Permission denied",
    ].join("\n");
    const lines = formatMirrorSync(
      result([
        {
          path: "/m/wiki",
          branch: "main",
          status: "skipped",
          reason: `FAST_FORWARD_FAILED: ${stderr}`,
        },
      ]),
    );
    expect(lines.slice(1)).toEqual([
      "  ⚠ /m/wiki (main): fast-forward failed: fatal: cannot create directory at 'docs/c': Permission denied",
    ]);
  });
});
