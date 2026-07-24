import assert from "node:assert/strict";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`https://aside.example${pathname}`, {
      headers: {
        accept: "text/html",
        "x-forwarded-host": "aside.example",
        "x-forwarded-proto": "https",
      },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the finished Aside landing page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Aside — Ask about the work\./);
  assert.match(html, /Ask about the work\./);
  assert.match(html, /Don(?:&#x27;|')t interrupt it\./);
  assert.match(html, /Dashboards show status\. Aside lets you ask why\./);
  assert.match(html, /Search the work, not just the title/);
  assert.match(html, /Find the thread from what happened inside it\./);
  assert.match(html, /Coming next:/);
  assert.match(html, /Codex subagents, folded beneath/);
  assert.match(html, /Search queries never leave your machine\./);
  assert.match(html, /Read-only is a boundary, not a slogan\./);
  assert.match(
    html,
    /https:\/\/aside-production-fd82\.up\.railway\.app\/download\/mac-arm64/,
  );
  assert.match(
    html,
    /https:\/\/aside-production-fd82\.up\.railway\.app\/download\/mac-intel/,
  );
  assert.match(html, /https:\/\/aside\.vgnsh\.xyz\/og\.png/);
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/aside\.vgnsh\.xyz\/"\/>/,
  );
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("serves a no-store health endpoint", async () => {
  const response = await render("/health");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { status: "ok" });
});
