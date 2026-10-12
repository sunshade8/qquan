import { spawn } from "node:child_process";
import { resolve } from "node:path";
const child = spawn(
  process.env.QQUAN_PYTHON || resolve(".venv/bin/python"),
  [resolve("scripts/data/store.py"), "worker"],
  { stdio: "inherit", env: process.env },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
