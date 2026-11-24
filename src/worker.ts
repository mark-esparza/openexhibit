// OpenExhibit Cloudflare Worker: front door for the static site in /public and its JSON API.
// Every request passes through here first (assets.run_worker_first), so maintenance mode and
// rate limits cover the whole site, not just the API.
// Copyright (C) 2026 OpenExhibit contributors. Licensed under the GNU AGPL v3 or later.

import { apiText, COMMONS_API, type Deps, formatAttribution, getFile, normalizeTitle } from "./core/commons.ts";
import { ToolError } from "./core/util.ts";
import { getVideo } from "./core/video.ts";
import { medicalSearch, type MediaType, UpstreamError } from "./medsearch.ts";

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  CONTACT?: string;
  /** "true" takes the whole site offline with a 503 page. Set in wrangler.jsonc so redeploys keep it. */
  MAINTENANCE?: string;
  /** Static files in /public. */
  ASSETS?: { fetch(request: Request): Promise<Response> };
  /** Per-visitor API rate limit (Cloudflare Workers rate limiting binding). */
  API_LIMITER?: RateLimiter;
}

const VERSION = "0.2.0";
const MAX_URL_LENGTH = 2048;
const DEFAULT_CONTACT = "https://github.com/mark-esparza/openexhibit";
const TYPES: MediaType[] = ["image", "diagram", "video"];

function json(body: unknown, status = 200, cacheSeconds = 0): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // No Access-Control-Allow-Origin: other websites cannot call this API from their pages.
      "Cache-Control": cacheSeconds ? `public, max-age=${cacheSeconds}` : "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
    },
  });
}

export function createApi(opts: { fetch: typeof fetch; contact?: string; cache?: Cache | null }) {
  const deps: Deps = { fetch: opts.fetch, userAgent: `OpenExhibit/${VERSION} (${opts.contact || DEFAULT_CONTACT})` };

  async function route(url: URL): Promise<Response> {
    if (url.pathname === "/api/health") return json({ ok: true, version: VERSION });

    if (url.pathname === "/api/search") {
      const type = (TYPES as string[]).includes(url.searchParams.get("type") ?? "") ? (url.searchParams.get("type") as MediaType) : "image";
      const concept = url.searchParams.get("concept") || undefined;
      const res = await medicalSearch(deps, url.searchParams.get("q") ?? "", type, url.searchParams.get("limit") ?? 20, concept);
      return json(res, 200, 3600);
    }

    if (url.pathname === "/api/file") {
      const title = url.searchParams.get("title") ?? "";
      const rec = await getFile(deps, title, 800, true);
      const isVideo = /^(video\/|application\/ogg)/.test(rec.mime ?? "") && rec.duration_seconds !== 0;
      const detail = isVideo ? await getVideo(deps, rec.title).catch(() => rec) : rec;
      const now = new Date();
      return json(
        {
          ...detail,
          kind: "sources" in detail ? "video" : "image",
          credits: { tasl: formatAttribution(rec, "tasl", now), ama: formatAttribution(rec, "ama", now), html: formatAttribution(rec, "html", now) },
        },
        200,
        3600,
      );
    }

    if (url.pathname === "/api/captions") {
      // Served from our own origin so <track> works without cross-origin setup.
      const title = normalizeTitle(url.searchParams.get("title") ?? "");
      const lang = url.searchParams.get("lang") ?? "en";
      if (!/^[a-z]{2,3}(-[a-z0-9]+)?$/i.test(lang)) throw new ToolError("Invalid language code");
      const vtt = await apiText(deps, COMMONS_API, { action: "timedtext", title, lang, trackformat: "vtt" });
      if (!vtt.trimStart().startsWith("WEBVTT")) throw new ToolError("No captions in that language");
      return new Response(vtt, { headers: { "Content-Type": "text/vtt; charset=utf-8", "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" } });
    }

    return json({ error: "Not found" }, 404);
  }

  return async function handle(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed" }, 405);
    if (request.url.length > MAX_URL_LENGTH) return json({ error: "Request too long" }, 414);
    const url = new URL(request.url);

    const cache = opts.cache ?? null;
    // The version is part of the key so a deploy never serves results ranked by older code.
    const keyUrl = new URL(url.toString());
    keyUrl.searchParams.set("_v", VERSION);
    const cacheKey = new Request(keyUrl.toString(), { method: "GET" });
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }

    let res: Response;
    try {
      res = await route(url);
    } catch (e) {
      if (e instanceof UpstreamError) res = json({ error: e.message }, 502);
      else if (e instanceof ToolError) res = json({ error: e.message }, 400);
      else {
        console.error("API error", e);
        res = json({ error: "Wikimedia could not be reached. Please try again." }, 502);
      }
    }
    if (cache && res.status === 200 && res.headers.get("Cache-Control")?.startsWith("public")) {
      await cache.put(cacheKey, res.clone());
    }
    return res;
  };
}

const MAINTENANCE_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>OpenExhibit</title>
<style>body{font:16px "Times New Roman",Times,serif;text-align:center;margin:24vh 16px}
b{display:inline-block;background:#000066;color:#fff;border:2px outset #808080;padding:8px 18px;font:bold 40px Arial,Helvetica,sans-serif}
p{margin-top:20px}</style></head>
<body><b>OpenExhibit</b><p>OpenExhibit is temporarily unavailable. Please check back later.</p></body></html>`;

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
  return out;
}

export function maintenanceResponse(url: URL): Response {
  const headers: Record<string, string> = { "Retry-After": "86400", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
  if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { status: 200, headers: { ...headers, "Content-Type": "text/plain" } });
  if (url.pathname.startsWith("/api/")) return new Response(JSON.stringify({ error: "OpenExhibit is temporarily unavailable." }), { status: 503, headers: { ...headers, "Content-Type": "application/json" } });
  return new Response(MAINTENANCE_PAGE, { status: 503, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
}

/** The whole site's request handler, exported for tests. */
export function createSite(opts: { env: Env; fetch: typeof fetch; cache?: Cache | null }) {
  const api = createApi({ fetch: opts.fetch, contact: opts.env.CONTACT, cache: opts.cache });
  return async function site(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (String(opts.env.MAINTENANCE).toLowerCase() === "true") return withSecurityHeaders(maintenanceResponse(url));

    if (url.pathname.startsWith("/api/")) {
      // Each visitor gets a fixed number of API calls per minute; every search costs several Wikimedia requests.
      if (opts.env.API_LIMITER) {
        const key = request.headers.get("CF-Connecting-IP") ?? "unknown";
        const { success } = await opts.env.API_LIMITER.limit({ key });
        if (!success) {
          const r = json({ error: "Too many searches in a short time. Please wait a minute and try again." }, 429);
          r.headers.set("Retry-After", "60");
          return withSecurityHeaders(r);
        }
      }
      return withSecurityHeaders(await api(request));
    }

    if (!opts.env.ASSETS) return withSecurityHeaders(new Response("Not found", { status: 404 }));
    return withSecurityHeaders(await opts.env.ASSETS.fetch(request));
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cache = typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : null;
    return createSite({ env, fetch: (i, init) => fetch(i, init), cache })(request);
  },
};
