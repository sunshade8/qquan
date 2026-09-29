import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the QQuant product shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /QQuant/);
  assert.match(html, /TradingView/);
  assert.match(html, /CSV fallback/);
  assert.match(html, /Chart commands/);
  assert.match(html, /Backtest/);
  assert.match(html, /MARKET INTELLIGENCE HQ/);
  assert.match(html, /Lab JARVIS/);
  assert.match(html, /News JARVIS/);
  assert.match(html, />Lab</);
  assert.match(html, /aria-label="Primary navigation"/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("keeps secrets server-only and starter assets removed", async () => {
  const [analysisRoute, envExample, clientSource] = await Promise.all([
    readFile(new URL("../lib/claude.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../app/quant-workspace.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(analysisRoute, /ANTHROPIC_API_KEY/);
  assert.match(analysisRoute, /claude-opus-5/);
  assert.doesNotMatch(clientSource, /sk-ant-|ANTHROPIC_API_KEY/);
  assert.doesNotMatch(envExample, /sk-ant-/);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
  await assert.rejects(access(new URL("../app/_sites-preview/preview.css", import.meta.url)));
});
