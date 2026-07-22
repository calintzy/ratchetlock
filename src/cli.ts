#!/usr/bin/env node
import { runInit } from "./commands/init.js";
import { runFreeze } from "./commands/freeze.js";
import { runAddFail } from "./commands/addFail.js";
import { runStatus } from "./commands/status.js";

const NOT_IMPLEMENTED = new Set(["check"]);

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);

  if (subcommand === "init") {
    await runInit(rest);
    return;
  }

  if (subcommand === "freeze") {
    await runFreeze(rest);
    return;
  }

  if (subcommand === "add-fail") {
    await runAddFail(rest);
    return;
  }

  if (subcommand === "status") {
    await runStatus(rest);
    return;
  }

  if (subcommand && NOT_IMPLEMENTED.has(subcommand)) {
    console.error(`ratchetlock ${subcommand}: not implemented`);
    process.exitCode = 1;
    return;
  }

  console.error("Usage: ratchetlock <init|check|freeze|add-fail|status> [options]");
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
