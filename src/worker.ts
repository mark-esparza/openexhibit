// OpenExhibit Cloudflare Worker: JSON API for the static site in /public.
// Copyright (C) 2026 OpenExhibit contributors. Licensed under the GNU AGPL v3 or later.

import { apiText, COMMONS_API, type Deps, formatAttribution, getFile, normalizeTitle } from "./core/commons.ts";
import { ToolError } from "./core/util.ts";
import { getVideo } from "./core/video.ts";
import { medicalSearch, type MediaType, UpstreamError } from "./medsearch.ts";

export interface Env {
  CONTACT?: string;
}

const VERSION = "0.1.1";
const DEFAULT_CONTACT = "https://github.com/mark-esparza/openexhibit";
const TYPES: MediaType[] = ["image", "diagram", "video"];

function json(body: unknown, status = 200, cacheSeconds = 0): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": cacheSeconds ? `public, max-age=${cacheSeconds}` : "no-store",
      "X-Content-Type-Options": "nosniff",
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
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET" } });
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cache = typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : null;
    return createApi({ fetch: (i, init) => fetch(i, init), contact: env.CONTACT, cache })(request);
  },
};
