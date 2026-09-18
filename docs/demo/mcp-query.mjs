import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const server = spawn("dev", ["qmd", "--root", "/demo/dev", "x", "mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
});
const lines = createInterface({ input: server.stdout });
const pending = new Map();
let nextId = 1;
let stderr = "";

server.stderr.on("data", (chunk) => {
  stderr += chunk;
});
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});

function send(message) {
  server.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 15_000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

try {
  const initialized = await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "dev-cli-demo", version: "1.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const result = await request("tools/call", {
    name: "query",
    arguments: {
      searches: [{ type: "lex", query: '"release checklist"' }],
      intent: "Find the release procedure in the demo platform documentation",
      limit: 1,
      rerank: false,
    },
  });
  const text = result.content?.find((item) => item.type === "text")?.text ?? "No text result";
  const excerpt = text.split("\n").filter(Boolean).slice(0, 6).join("\n");
  console.log(`MCP handshake: ${initialized.serverInfo.name} ${initialized.serverInfo.version}`);
  console.log("MCP tool call: query (lexical, no model download)");
  console.log(excerpt);
} catch (error) {
  console.error(stderr.trim() || error.message);
  process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
}
