import { describe, expect, it } from "bun:test";
import * as herdr from "../../src/herdr.ts";

const SESSIONS_TABLE = `name                 status   directory                    socket
default              running  C:\\Users\\x\\herdr           C:\\Users\\x\\herdr\\herdr.sock
review               running  C:\\Users\\x\\herdr\\review   C:\\Users\\x\\herdr\\review\\herdr.sock
old                  stopped  C:\\Users\\x\\herdr\\old      C:\\Users\\x\\herdr\\old\\herdr.sock
`;

function fakeDeps(options: {
  sessions?: string;
  chooseSession?: (sessions: herdr.HerdrSession[]) => Promise<string>;
}) {
  const calls: string[][] = [];
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
  const deps: herdr.HerdrDeps = {
    run: async (args) => {
      calls.push(args);
      const scoped = args[0] === "--session";
      if (scoped && args[1] !== "review" && args[1] !== "default") {
        throw new Error(`unexpected session ${args[1]}`);
      }
      const command = (scoped ? args.slice(2) : args).filter((arg) => !arg.startsWith("--"));
      if (command[0] === "session") return ok(options.sessions ?? SESSIONS_TABLE);
      if (command[0] === "status") return ok("status: running");
      if (command[0] === "pane")
        return ok(JSON.stringify({ result: { type: "pane_list", panes: [] } }));
      if (command[0] === "agent" && command[1] === "list") {
        return ok(JSON.stringify({ result: { type: "agent_list", agents: [] } }));
      }
      if (command[0] === "workspace" && command[1] === "create") {
        return ok(
          JSON.stringify({
            result: {
              type: "workspace_created",
              workspace: { workspace_id: "w9" },
              root_pane: { pane_id: "w9:p1", cwd: "/ws/payment-fix" },
            },
          }),
        );
      }
      if (command[0] === "agent" && command[1] === "start") {
        return ok(
          JSON.stringify({
            result: {
              type: "agent_started",
              agent: { name: "payment-fix-omp", pane_id: "w9:p1", workspace_id: "w9" },
            },
          }),
        );
      }
      if (command[0] === "workspace" && command[1] === "focus") {
        return ok(
          JSON.stringify({ result: { type: "workspace_info", workspace: { workspace_id: "w9" } } }),
        );
      }
      throw new Error(`unexpected herdr call: ${args.join(" ")}`);
    },
    canonicalize: async (path) => path,
    startServer: () => {},
    wait: async () => {},
    interactions: options.chooseSession ? { chooseSession: options.chooseSession } : undefined,
  };
  return { deps, calls };
}

const input = { workspace: "payment-fix", path: "/ws/payment-fix", insideHerdr: false };

describe("herdr session resolution", () => {
  it("parses the session table", () => {
    expect(herdr.parseSessions(SESSIONS_TABLE)).toEqual([
      { name: "default", running: true },
      { name: "review", running: true },
      { name: "old", running: false },
    ]);
  });

  it("refuses to guess when several sessions are running", async () => {
    const { deps } = fakeDeps({});
    const error = await herdr.startWorkspace(input, deps).catch((cause) => cause);
    expect(error).toBeInstanceOf(herdr.HerdrError);
    expect(error.code).toBe("HERDR_AMBIGUOUS_SESSION");
    expect(error.message).toContain("default, review");
    expect(error.message).toContain("--session");
  });

  it("asks which session to use and scopes every command to the answer", async () => {
    const seen: herdr.HerdrSession[][] = [];
    const { deps, calls } = fakeDeps({
      chooseSession: async (sessions) => {
        seen.push(sessions);
        return "review";
      },
    });

    const result = await herdr.startWorkspace(input, deps);

    expect(seen[0]?.map((session) => session.name)).toEqual(["default", "review"]);
    expect(result.session).toBe("review");
    const scoped = calls.filter((call) => call[0] !== "session");
    expect(scoped.length).toBeGreaterThan(0);
    for (const call of scoped) expect(call.slice(0, 2)).toEqual(["--session", "review"]);
  });

  it("uses the only running session without asking", async () => {
    const { deps, calls } = fakeDeps({
      sessions:
        "name status directory socket\nreview running /a /a/herdr.sock\nold stopped /b /b/herdr.sock\n",
      chooseSession: async () => {
        throw new Error("must not prompt");
      },
    });

    const result = await herdr.startWorkspace(input, deps);

    expect(result.session).toBe("review");
    expect(calls.some((call) => call[0] === "session")).toBe(true);
  });

  it("rejects a session that is not running", async () => {
    const { deps } = fakeDeps({});
    const error = await herdr
      .startWorkspace({ ...input, session: "old" }, deps)
      .catch((cause) => cause);
    expect(error.code).toBe("HERDR_SESSION_NOT_RUNNING");
    expect(error.message).toContain("default, review");
  });

  it("inherits the surrounding session inside a pane", async () => {
    const { deps, calls } = fakeDeps({});

    const result = await herdr.startWorkspace({ ...input, insideHerdr: true }, deps);

    expect(result.session).toBeUndefined();
    expect(calls.some((call) => call[0] === "session")).toBe(false);
    expect(calls.some((call) => call.includes("--session"))).toBe(false);
  });
});
