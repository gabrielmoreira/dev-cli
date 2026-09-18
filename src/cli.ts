#!/usr/bin/env bun
import { runCli } from "./cli/index.ts";
export * from "./cli/index.ts";

if (import.meta.main) {
  runCli()
    .then((code) => {
      if (code !== 0) {
        process.exit(code);
      }
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
