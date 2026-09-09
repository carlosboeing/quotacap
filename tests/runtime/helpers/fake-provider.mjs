#!/usr/bin/env node
// Fake provider CLI for cancellation tests (--mode canned|hang|slow).
// Unknown args are ignored so this file can also stand in for a real
// provider binary on PATH: defaults come from QC_FAKE_* env, flags override.
import fs from "node:fs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const mode = arg("mode") ?? process.env.QC_FAKE_MODE ?? "canned";
const pidfile = arg("pidfile") ?? process.env.QC_FAKE_PIDFILE;
const readyMark = arg("ready-mark") ?? process.env.QC_FAKE_READY;
const completeMark = arg("complete-mark") ?? process.env.QC_FAKE_DONE;
const delayMs = parseInt(arg("delay-ms") ?? process.env.QC_FAKE_DELAY_MS ?? "0", 10);
const emit = arg("emit") ?? process.env.QC_FAKE_EMIT ?? "";
const exitCode = parseInt(arg("exit-code") ?? process.env.QC_FAKE_EXIT ?? "0", 10);

if (process.env.QC_FAKE_IGNORE_TERM === "1") {
  process.on("SIGTERM", () => {});
}
if (pidfile) fs.writeFileSync(pidfile, String(process.pid));
if (readyMark) fs.writeFileSync(readyMark, "ready\n");

if (mode === "hang") {
  setInterval(() => {}, 1000);
} else {
  if (mode === "slow" && delayMs > 0) {
    await new Promise((r) => setTimeout(r, delayMs));
  }
  if (emit) process.stdout.write(emit);
  if (completeMark) fs.writeFileSync(completeMark, "done\n");
  process.exit(exitCode);
}
