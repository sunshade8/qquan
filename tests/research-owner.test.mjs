import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./helpers/strategy-test-loader.mjs", import.meta.url);
globalThis.__strategyTestEnv = {};
const { researchOwnerFrom, RESEARCH_COOKIE_NAME } = await import("../lib/research-owner.ts");

const OWNER = "124708b7-9115-443a-9a6b-d66228baf898";
const request = (cookie) => new Request("http://127.0.0.1:3000/api/invest/ct", { headers: cookie ? { cookie } : {} });

test("every browser resolves to QQUAN_OWNER_ID, so switching browsers keeps research history", () => {
  globalThis.__strategyTestEnv.QQUAN_OWNER_ID = OWNER;
  try {
    assert.equal(researchOwnerFrom(request()), OWNER);
    assert.equal(researchOwnerFrom(request(`${RESEARCH_COOKIE_NAME}=0c173392-2d95-4590-93b4-bce9bee173cc`)), OWNER);
  } finally {
    delete globalThis.__strategyTestEnv.QQUAN_OWNER_ID;
  }
});

test("without a configured owner the per-browser cookie still identifies the owner", () => {
  const cookie = "0c173392-2d95-4590-93b4-bce9bee173cc";
  assert.equal(researchOwnerFrom(request(`${RESEARCH_COOKIE_NAME}=${cookie}`)), cookie);
  assert.notEqual(researchOwnerFrom(request()), cookie);
});
