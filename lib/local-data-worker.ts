import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { openSync, mkdirSync, closeSync } from "node:fs";
import { dataDirectory } from "./runtime/local-sqlite.ts";
let worker: ReturnType<typeof spawn> | undefined;
export function startDataWorker() {
  if (worker && worker.exitCode === null) return;
  const root = dataDirectory();
  mkdirSync(root + "/logs", { recursive: true, mode: 0o700 });
  const log = openSync(root + "/logs/data-worker.log", "a", 0o600);
  worker = spawn(
    process.env.QQUAN_PYTHON || resolve(".venv/bin/python"),
    [resolve("scripts/data/store.py"), "worker"],
    { detached: true, stdio: ["ignore", log, log], env: process.env },
  );
  closeSync(log);
  worker.on("error", () => {
    worker = undefined;
  });
  worker.unref();
}
