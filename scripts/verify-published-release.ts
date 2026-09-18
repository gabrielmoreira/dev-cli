#!/usr/bin/env bun

const version = Bun.argv[2];
if (!version) {
  throw new Error("Usage: bun scripts/verify-published-release.ts <version>");
}

const process = Bun.spawn(
  ["mise", "exec", `github:gabrielmoreira/dev-cli@${version}`, "--", "dev", "--version"],
  {
    stdout: "pipe",
    stderr: "inherit",
  },
);
const output = (await new Response(process.stdout).text()).trim();
const exitCode = await process.exited;
if (exitCode !== 0) {
  throw new Error(`Mise installation smoke test failed with exit code ${exitCode}`);
}

const expected = `dev v${version}`;
if (output !== expected) {
  throw new Error(
    `Installed CLI reported ${JSON.stringify(output)}; expected ${JSON.stringify(expected)}`,
  );
}

console.log(output);
