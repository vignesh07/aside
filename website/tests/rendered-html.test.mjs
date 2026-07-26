import assert from "node:assert/strict";
import test from "node:test";

async function render(pathname = "/", method = "GET", init = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const headers = new Headers({
    accept: "text/html",
    "x-forwarded-host": "aside.example",
    "x-forwarded-proto": "https",
  });

  for (const [name, value] of new Headers(init.headers)) {
    headers.set(name, value);
  }

  return worker.fetch(
    new Request(`https://aside.example${pathname}`, {
      ...init,
      method,
      headers,
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
  assert.match(html, /Subagent work stays attached:/);
  assert.match(html, /Codex and Claude\s+Code subagents fold beneath/);
  assert.match(html, /Search queries never leave your machine\./);
  assert.match(html, /Read-only is a boundary, not a slogan\./);
  assert.match(html, /Open source · MIT/);
  assert.match(html, /Aside is open source\./);
  assert.match(html, /View the source on GitHub/);
  assert.match(html, /https:\/\/github\.com\/vignesh07\/aside/);
  assert.match(html, /macOS preview · v0\.1\.8/);
  assert.match(
    html,
    /https:\/\/aside\.vgnsh\.xyz\/download\/mac-arm64/,
  );
  assert.match(
    html,
    /https:\/\/aside\.vgnsh\.xyz\/download\/mac-intel/,
  );
  assert.match(html, /https:\/\/aside\.vgnsh\.xyz\/og\.png/);
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/aside\.vgnsh\.xyz\/"\/>/,
  );
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

for (const [path, upstream] of [
  [
    "/download/mac-arm64",
    "https://aside-production-fd82.up.railway.app/download/mac-arm64",
  ],
  [
    "/download/mac-intel",
    "https://aside-production-fd82.up.railway.app/download/mac-intel",
  ],
]) {
  test(`${path} redirects to the stable release service`, async () => {
    for (const method of ["GET", "HEAD"]) {
      const response = await render(path, method);
      assert.equal(response.status, 307);
      assert.equal(response.headers.get("location"), upstream);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(await response.text(), "");
    }
  });
}

test("serves a no-store health endpoint", async () => {
  const response = await render("/health");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("keeps the analytics dashboard locked until an admin key is configured", async () => {
  const response = await render("/admin");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /Analytics isn(?:&#x27;|'|’)t configured yet\./);
  assert.match(html, /ASIDE_ADMIN_KEY/);
  assert.match(html, /name="robots" content="noindex, nofollow, nocache"/);
  assert.doesNotMatch(html, /Aside downloads/);
});

test("keeps admin auth redirects same-origin and clears path-scoped cookies", async () => {
  process.env.ASIDE_ADMIN_KEY = "aside-rendered-test-key-32-bytes-long";

  try {
    const invalidResponse = await render("/admin/session", "POST", {
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ key: "wrong" }),
    });
    assert.equal(invalidResponse.status, 303);
    assert.equal(invalidResponse.headers.get("location"), "/admin?error=invalid");
    assert.match(
      invalidResponse.headers.get("set-cookie") ?? "",
      /Path=\/admin/i,
    );
    assert.match(
      invalidResponse.headers.get("set-cookie") ?? "",
      /Max-Age=0/i,
    );

    const loginResponse = await render("/admin/session", "POST", {
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        key: process.env.ASIDE_ADMIN_KEY,
      }),
    });
    assert.equal(loginResponse.status, 303);
    assert.equal(loginResponse.headers.get("location"), "/admin");

    const sessionCookie = loginResponse.headers.get("set-cookie") ?? "";
    assert.match(sessionCookie, /HttpOnly/i);
    assert.match(sessionCookie, /Secure/i);
    assert.match(sessionCookie, /SameSite=strict/i);
    assert.match(sessionCookie, /Path=\/admin/i);

    const logoutResponse = await render("/admin/logout", "POST", {
      headers: {
        cookie: sessionCookie.split(";", 1)[0],
      },
    });
    assert.equal(logoutResponse.status, 303);
    assert.equal(logoutResponse.headers.get("location"), "/admin");
    assert.match(
      logoutResponse.headers.get("set-cookie") ?? "",
      /Path=\/admin/i,
    );
    assert.match(
      logoutResponse.headers.get("set-cookie") ?? "",
      /Max-Age=0/i,
    );
  } finally {
    delete process.env.ASIDE_ADMIN_KEY;
  }
});
