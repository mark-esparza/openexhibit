import { test } from "node:test";
import assert from "node:assert/strict";
import { createSite, type Env } from "../src/worker.ts";
import { imagePage, mockFetch } from "./fixtures.ts";

const BASE = "https://openexhibit.example.workers.dev";
const assets = { fetch: async (r: Request) => new Response(`asset:${new URL(r.url).pathname}`, { headers: { "content-type": "text/html" } }) };
const commons = () => mockFetch([(u) => (u.hostname === "commons.wikimedia.org" ? { body: { query: { pages: [imagePage("File:Heart.jpg", { index: 1 })] } } } : { status: 503, body: "" })]);

function site(env: Env, m = commons()) {
  return { handle: createSite({ env, fetch: m.fetch }), calls: m.calls };
}

test("maintenance mode takes down every page and the API without touching Wikimedia", async () => {
  const { handle, calls } = site({ MAINTENANCE: "true", ASSETS: assets });
  const home = await handle(new Request(BASE + "/"));
  assert.equal(home.status, 503);
  assert.match(await home.text(), /temporarily unavailable/);
  assert.equal(home.headers.get("x-robots-tag"), "noindex");
  assert.equal(home.headers.get("retry-after"), "86400");

  const asset = await handle(new Request(BASE + "/app.js"));
  assert.equal(asset.status, 503, "static files are also offline");

  const api = await handle(new Request(BASE + "/api/search?q=heart"));
  assert.equal(api.status, 503);
  assert.match(((await api.json()) as any).error, /temporarily unavailable/);
  assert.equal(calls.length, 0, "no Wikimedia requests while down");

  const robots = await handle(new Request(BASE + "/robots.txt"));
  assert.equal(await robots.text(), "User-agent: *\nDisallow: /\n");
});

test("maintenance flag accepts TRUE and anything else means up", async () => {
  assert.equal((await site({ MAINTENANCE: "TRUE", ASSETS: assets }).handle(new Request(BASE + "/"))).status, 503);
  assert.equal((await site({ MAINTENANCE: "false", ASSETS: assets }).handle(new Request(BASE + "/"))).status, 200);
  assert.equal((await site({ ASSETS: assets }).handle(new Request(BASE + "/"))).status, 200);
});

test("when up, static files pass through with security headers", async () => {
  const res = await site({ MAINTENANCE: "false", ASSETS: assets }).handle(new Request(BASE + "/style.css"));
  assert.equal(await res.text(), "asset:/style.css");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("strict-transport-security"), "max-age=31536000");
  assert.match(res.headers.get("permissions-policy")!, /camera=\(\)/);
});

test("rate limit: over the limit gets 429 and makes no Wikimedia calls", async () => {
  let allowed = 2;
  const keys: string[] = [];
  const limiter = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: allowed-- > 0 }) };
  const { handle, calls } = site({ MAINTENANCE: "false", ASSETS: assets, API_LIMITER: limiter });
  const req = () => new Request(BASE + "/api/health", { headers: { "CF-Connecting-IP": "203.0.113.9" } });
  assert.equal((await handle(req())).status, 200);
  assert.equal((await handle(req())).status, 200);
  const blocked = await handle(req());
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "60");
  assert.match(((await blocked.json()) as any).error, /wait a minute/);
  assert.deepEqual(keys, ["203.0.113.9", "203.0.113.9", "203.0.113.9"]);
  assert.equal(calls.length, 0);

  const page = await handle(new Request(BASE + "/"));
  assert.equal(page.status, 200, "pages are not rate limited, only the API");
});

test("API is same-origin only, GET only, with a URL length cap", async () => {
  const { handle } = site({ MAINTENANCE: "false", ASSETS: assets });
  const ok = await handle(new Request(BASE + "/api/health"));
  assert.equal(ok.headers.get("access-control-allow-origin"), null);
  assert.equal(ok.headers.get("x-robots-tag"), "noindex");
  assert.equal((await handle(new Request(BASE + "/api/health", { method: "OPTIONS" }))).status, 405);
  assert.equal((await handle(new Request(BASE + "/api/search?q=x", { method: "POST", body: "x" }))).status, 405);
  assert.equal((await handle(new Request(BASE + "/api/search?q=" + "a".repeat(2100)))).status, 414);
});
