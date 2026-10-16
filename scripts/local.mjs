/** Local app + independent download/research processes. No trading tick. */
import { spawn } from "node:child_process";
import { loadEnvFile } from "node:process";
try {
  loadEnvFile(".dev.vars");
} catch { /* .dev.vars is optional */ }
if (process.env.VERCEL) throw Error("Local runtime cannot run on Vercel");
const children = [
  spawn(
    process.env.QQUAN_PYTHON || ".venv/bin/python",
    ["scripts/data/store.py", "worker"],
    { stdio: "inherit", env: process.env, detached: true },
  ),
  spawn("npm", ["run", "dev"], {
    stdio: "inherit",
    env: process.env,
    detached: true,
  }),
  spawn("node", ["scripts/trading-runner.mjs", "--generation-only"], {
    stdio: "inherit",
    env: process.env,
    detached: true,
  }),
];
if (process.env.LOCAL_DATA_SITE_URL) children.push(spawn("npm", ["run", "data:bridge"], {stdio:"inherit",env:process.env,detached:true}));
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    try {
      process.kill(-c.pid, "SIGTERM");
    } catch { /* already exited */ }
  }
}
for (const c of children) {
  c.on("error", (e) => {
    console.error(e.message);
    stop();
    process.exitCode = 1;
  });
  c.on("exit", (code) => {
    // An existing detached downloader already owns the singleton lock.
    if (c === children[0] && code === 0) return;
    if (!stopping) process.exitCode = code || 1;
    stop();
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
