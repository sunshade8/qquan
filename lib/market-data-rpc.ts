import { spawn } from "node:child_process";
import { resolve } from "node:path";
export function dataRPC<T>(input: object): Promise<T> {
  return new Promise((accept, reject) => {
    const child = spawn(
      process.env.QQUAN_PYTHON || resolve(".venv/bin/python"),
      [resolve("scripts/data/store.py"), "rpc"],
      { stdio: ["pipe", "pipe", "pipe"], env: process.env },
    );
    const timer = setTimeout(() => { child.kill(); reject(new Error("로컬 저장소 조회 시간 초과: 실행기를 확인하세요.")); }, 95_000);
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 80_000_000) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("로컬 데이터 런타임 설치 필요: npm run data:setup"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(output);
        if (code || result.error)
          reject(new Error(result.error || "Local data failed"));
        else accept(result);
      } catch {
        reject(
          new Error(
            "로컬 데이터 실행 오류: npm run data:setup 확인. " +
              errors.slice(-300),
          ),
        );
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
