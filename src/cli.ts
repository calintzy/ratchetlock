#!/usr/bin/env node
import { runInit } from "./commands/init.js";
import { runCheck } from "./commands/check.js";
import { runFreeze } from "./commands/freeze.js";
import { runAddFail } from "./commands/addFail.js";
import { runStatus } from "./commands/status.js";
import { runLint } from "./commands/lint.js";

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);

  if (subcommand === "init") {
    await runInit(rest);
    return;
  }

  if (subcommand === "check") {
    await runCheck(rest);
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

  if (subcommand === "lint") {
    await runLint(rest);
    return;
  }

  console.error(
    [
      "Usage: ratchetlock <init|check|freeze|add-fail|status|lint> [options]",
      "",
      "  check [--prompt <id>] [--live] [--probe-locked] [--retry <N>]",
      "  freeze [--prompt <id>] [--note <text>] [--allow-partial] [--retry <N>]",
      "",
      "  --retry <N>  라이브 형식 위반 시 실패 케이스만 최대 N회 재생성(기본 0=재시도 없음).",
      "               --live/freeze에서만 유효 — 결정적 replay 경로에선 무시된다.",
    ].join("\n"),
  );
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
