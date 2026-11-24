import { test } from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../src/worker.ts";
import { medicalScore } from "../src/medsearch.ts";
import { imagePage, mockFetch, videoPage } from "./fixtures.ts";

const BASE = "https://openexhibit.example.workers.dev";
const isCommons = (u: URL) => u.hostname === "commons.wikimedia.org";
const isWikidata = (u: URL) => u.hostname === "www.wikidata.org";

const ENTITIES: Record<string, any> = {
  Q1166: {
    id: "Q1166",
    labels: { en: { value: "Michigan" } },
    descriptions: { en: { value: "state of the United States of America" } },
    claims: { P486: [{ mainsnak: { datavalue: { value: "D008824" } } }], P672: [{ mainsnak: { datavalue: { value: "Z01.107.567.875.580.200" } } }], P373: [{ mainsnak: { datavalue: { value: "Michigan" } } }] },
  },
  Q12152: {
    id: "Q12152",
    labels: { en: { value: "myocardial infarction" } },
    descriptions: { en: { value: "interruption of blood supply to a part of the heart" } },
    aliases: { en: [{ value: "MI" }, { value: "heart attack" }] },
    claims: {
      P486: [{ mainsnak: { datavalue: { value: "D009203" } } }],
      P494: [{ mainsnak: { datavalue: { value: "I21" } } }],
      P780: [{ mainsnak: { datavalue: { value: { id: "Q1234" } } } }],
      P373: [{ mainsnak: { datavalue: { value: "Myocardial infarction" } } }],
      P18: [{ mainsnak: { datavalue: { value: "AMI scheme.png" } } }],
    },
  },
  Q999: { id: "Q999", labels: { en: { value: "MI trial" } }, descriptions: { en: { value: "clinical trial" } }, claims: { P486: [{ mainsnak: { datavalue: { value: "D1" } } }] } },
};

function routes(searchIds: string[]) {
  return mockFetch([
    (u) =>
      isWikidata(u) && u.searchParams.get("action") === "wbsearchentities"
        ? { body: { search: searchIds.map((id) => ({ id, label: ENTITIES[id]?.labels.en.value, description: ENTITIES[id]?.descriptions?.en?.value, match: { type: "alias", text: id === "Q12152" ? "MI" : "x" } })) } }
        : undefined,
    (u) => (isWikidata(u) ? { body: { entities: Object.fromEntries((u.searchParams.get("ids") ?? "").split("|").map((id) => [id, ENTITIES[id] ?? { id, missing: "" }])) } } : undefined),
    (u) => {
      if (!isCommons(u)) return undefined;
      const titles = u.searchParams.get("titles");
      if (titles) return { body: { query: { pages: titles.split("|").map((t) => imagePage(t, { mime: "image/png" })) } } };
      const s = u.searchParams.get("gsrsearch") ?? "";
      if (s.includes("filetype:video")) return { body: { query: { pages: [videoPage("File:MI echo.webm", { index: 1 })] } } };
      if (s.startsWith('incategory:"Myocardial infarction"')) return { body: { query: { pages: [imagePage("File:Infarct histology.jpg", { index: 1 }), imagePage("File:ECG STEMI.png", { index: 2, mime: "image/png" })] } } };
      if (s.startsWith("myocardial infarction")) return { body: { query: { pages: [imagePage("File:ECG STEMI.png", { index: 1, mime: "image/png" }), imagePage("File:Paper.pdf", { index: 2, mime: "application/pdf" })] } } };
      return { body: { query: { pages: [imagePage("File:Michigan flag.jpg", { index: 1 }), imagePage("File:ECG STEMI.png", { index: 2, mime: "image/png" })] } } };
    },
  ]);
}

async function get(api: (r: Request) => Promise<Response>, path: string) {
  const res = await api(new Request(BASE + path));
  return { status: res.status, body: (await res.json()) as any, headers: res.headers };
}

test("medicalScore weighs identifiers, ignores geographic MeSH, and penalizes noise", () => {
  assert.equal(medicalScore(ENTITIES.Q12152, "interruption of blood supply"), 4, "ICD-10 2 + MeSH 1 + symptoms 1");
  assert.equal(medicalScore(ENTITIES.Q1166, "state"), 0, "MeSH Z (places) does not count");
  assert.equal(medicalScore(ENTITIES.Q999, "clinical trial"), -5);
});

test("an exact name match beats a related concept with more identifiers", async () => {
  const anatomy = { id: "Q846961", labels: { en: { value: "brachial plexus" } }, claims: { P1402: [{ mainsnak: { datavalue: { value: "45245" } } }], P486: [{ mainsnak: { datavalue: { value: "D001917" } } }] } };
  const neuropathy = {
    id: "Q18556023",
    labels: { en: { value: "brachial plexus neuropathy" } },
    claims: Object.fromEntries(["P494", "P4229", "P2892", "P699"].map((p) => [p, [{ mainsnak: { datavalue: { value: "X" } } }]])),
  };
  const ents: Record<string, any> = { Q846961: anatomy, Q18556023: neuropathy };
  const m = mockFetch([
    (u) => (isWikidata(u) && u.searchParams.get("action") === "wbsearchentities" ? { body: { search: [{ id: "Q18556023", match: { type: "label", text: "brachial plexus neuropathy" } }, { id: "Q846961", match: { type: "label", text: "brachial plexus" } }] } } : undefined),
    (u) => (isWikidata(u) ? { body: { entities: ents } } : undefined),
    (u) => (isCommons(u) ? { body: { query: { pages: [1, 2, 3, 4, 5].map((i) => imagePage(`File:BP ${i}.svg`, { index: i, mime: "image/svg+xml" })) } } } : undefined),
  ]);
  const { body } = await get(createApi({ fetch: m.fetch }), "/api/search?q=brachial%20plexus&type=diagram");
  assert.equal(body.concept.id, "Q846961");
  assert.equal(body.alternatives[0].id, "Q18556023");
});

test("thin results also search the closest related concepts", async () => {
  const vertigo = { id: "Q2", labels: { en: { value: "benign paroxysmal positional vertigo" } }, claims: { P494: [{ mainsnak: { datavalue: { value: "H81.1" } } }] } };
  const nystagmus = { id: "Q1", labels: { en: { value: "positional nystagmus" } }, claims: { P494: [{ mainsnak: { datavalue: { value: "H55" } } }], P2892: [{ mainsnak: { datavalue: { value: "C1" } } }] } };
  const m = mockFetch([
    (u) => (isWikidata(u) && u.searchParams.get("action") === "wbsearchentities" ? { body: { search: [{ id: "Q1", match: { type: "alias", text: "BPPV" } }, { id: "Q2", match: { type: "alias", text: "BPPV" } }] } } : undefined),
    (u) => (isWikidata(u) ? { body: { entities: { Q1: nystagmus, Q2: vertigo } } } : undefined),
    (u) => {
      if (!isCommons(u)) return undefined;
      const s = u.searchParams.get("gsrsearch") ?? "";
      if (s.startsWith("benign paroxysmal positional vertigo")) return { body: { query: { pages: [videoPage("File:Dix Hallpike.webm", { index: 1 }), videoPage("File:Epley.webm", { index: 2 })] } } };
      if (s.startsWith("positional nystagmus")) return { body: { query: { pages: [videoPage("File:Nystagmus.webm", { index: 1 })] } } };
      return { body: { query: { pages: [] } } };
    },
  ]);
  const { body } = await get(createApi({ fetch: m.fetch }), "/api/search?q=BPPV&type=video");
  assert.equal(body.concept.id, "Q1");
  assert.deepEqual(body.searched.map((s: any) => s.route), ["your words", "medical name", "related term"]);
  assert.deepEqual(body.results.map((r: any) => r.title).sort(), ["File:Dix Hallpike.webm", "File:Epley.webm", "File:Nystagmus.webm"]);
});

test("'MI' is read as myocardial infarction, not Michigan, and searched three ways", async () => {
  const m = routes(["Q1166", "Q999", "Q12152"]);
  const { status, body } = await get(createApi({ fetch: m.fetch }), "/api/search?q=MI&type=image");
  assert.equal(status, 200);
  assert.equal(body.concept.id, "Q12152");
  assert.deepEqual(body.concept.medical_ids, { MeSH: "D009203", "ICD-10": "I21" }, "linked items like signs and symptoms are not shown as IDs");
  assert.equal(body.concept.category, "Myocardial infarction");
  assert.deepEqual(body.alternatives, [], "non-medical and noise candidates are not offered");
  assert.deepEqual(body.searched.map((s: any) => s.route), ["your words", "medical name", "Commons category"]);
  const titles = body.results.map((r: any) => r.title);
  assert.equal(titles[0], "File:AMI scheme.png", "Wikidata image pinned first");
  assert.equal(titles[1], "File:ECG STEMI.png", "found by all three routes");
  assert.ok(titles.indexOf("File:Infarct histology.jpg") < titles.indexOf("File:Michigan flag.jpg"));
  assert.ok(!titles.includes("File:Paper.pdf"));
  assert.deepEqual(body.results[1].found_by.sort(), ["Commons category", "medical name", "your words"]);
});

test("queries with no medical meaning fall back to a plain search", async () => {
  const m = routes(["Q1166"]);
  const { body } = await get(createApi({ fetch: m.fetch }), "/api/search?q=Michigan");
  assert.equal(body.concept, null, "a place with a geographic MeSH code is not a medical concept");
  assert.deepEqual(body.searched.map((s: any) => s.route), ["your words"]);
  assert.equal(body.results[0].title, "File:Michigan flag.jpg");
});

test("a chosen concept id skips the guess; video type adds the filter and skips pinning", async () => {
  const m = routes([]);
  const { body } = await get(createApi({ fetch: m.fetch }), "/api/search?q=heart%20attack&type=video&concept=Q12152");
  assert.equal(body.concept.id, "Q12152");
  assert.ok(body.searched.every((s: any) => s.search.endsWith(" filetype:video")));
  assert.equal(body.results[0].title, "File:MI echo.webm");
  assert.equal(body.results[0].duration_seconds, 36.3);
  assert.ok(!m.calls.some((c) => c.url.searchParams.get("action") === "wbsearchentities"));
});

test("bad input gives a 400 with a readable message; bad concept ids are rejected", async () => {
  const api = createApi({ fetch: routes([]).fetch });
  const empty = await get(api, "/api/search?q=%20%20");
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /Type something/);
  const bad = await get(api, "/api/search?q=x&concept=Q1|Q2");
  assert.equal(bad.status, 400);
  assert.equal((await get(api, "/api/nope")).status, 404);
  const post = await api(new Request(BASE + "/api/search?q=x", { method: "POST" }));
  assert.equal(post.status, 405);
});

test("Wikidata down: search still works; Commons down: 502, not empty results", async () => {
  const m = mockFetch([
    (u) => (isWikidata(u) ? { status: 503, body: "down" } : undefined),
    (u) => (isCommons(u) ? { body: { query: { pages: [imagePage("File:Heart.jpg", { index: 1 })] } } } : undefined),
  ]);
  const ok = await get(createApi({ fetch: m.fetch }), "/api/search?q=heart");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.concept, null);
  assert.equal(ok.body.results[0].title, "File:Heart.jpg");

  const api = createApi({ fetch: mockFetch([() => ({ status: 503, body: "down" })]).fetch });
  const r = await get(api, "/api/search?q=heart");
  assert.equal(r.status, 502);
  assert.match(r.body.error, /could not be reached/);
  const api2 = createApi({ fetch: (async () => { throw new TypeError("network"); }) as unknown as typeof fetch });
  const r2 = await get(api2, "/api/search?q=heart");
  assert.equal(r2.status, 502);
});

test("/api/file returns image details with three credit styles", async () => {
  const m = mockFetch([(u) => (isCommons(u) ? { body: { query: { pages: [imagePage("File:ECG STEMI.png", { mime: "image/png" })] } } } : undefined)]);
  const { body, headers } = await get(createApi({ fetch: m.fetch }), "/api/file?title=ECG%20STEMI.png");
  assert.equal(body.kind, "image");
  assert.match(body.credits.tasl, /^"ECG STEMI" by Dr\. Example/);
  assert.match(body.credits.ama, /Wikimedia Commons\. Accessed /);
  assert.match(body.credits.html, /^<a href=/);
  assert.equal(headers.get("cache-control"), "public, max-age=3600");
});

test("/api/file returns playable sources for videos", async () => {
  const m = mockFetch([(u) => (isCommons(u) ? { body: { query: { pages: [videoPage("File:MI echo.webm")] } } } : undefined)]);
  const { body } = await get(createApi({ fetch: m.fetch }), "/api/file?title=MI%20echo.webm");
  assert.equal(body.kind, "video");
  assert.match(body.phone_friendly_url, /360p\.mpeg4\.mov$/);
  assert.ok(body.credits.tasl);
});

test("successful responses are cached and reused", async () => {
  const store = new Map<string, Response>();
  const cache = { match: async (r: Request) => store.get(r.url)?.clone(), put: async (r: Request, res: Response) => void store.set(r.url, res) } as unknown as Cache;
  const m = routes(["Q1166"]);
  const api = createApi({ fetch: m.fetch, cache });
  await get(api, "/api/search?q=Michigan");
  const n = m.calls.length;
  const again = await get(api, "/api/search?q=Michigan");
  assert.equal(again.status, 200);
  assert.equal(m.calls.length, n, "second request served from cache");
  await get(api, "/api/search?q=%20");
  assert.equal(store.size, 1, "errors are not cached");
});

test("/api/captions proxies VTT from Commons and validates input", async () => {
  const m = mockFetch([(u) => (isCommons(u) && u.searchParams.get("action") === "timedtext" ? { body: u.searchParams.get("lang") === "en" ? "WEBVTT\n\n00:00.000 --> 00:01.000\nHi" : "", headers: { "content-type": "text/vtt" } } : undefined)]);
  const api = createApi({ fetch: m.fetch });
  const ok = await api(new Request(BASE + "/api/captions?title=Heart_attack_video.webm&lang=en"));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "text/vtt; charset=utf-8");
  assert.match(await ok.text(), /^WEBVTT/);
  assert.equal(m.calls[0].url.searchParams.get("title"), "File:Heart attack video.webm");
  assert.equal((await api(new Request(BASE + "/api/captions?title=X.webm&lang=fr"))).status, 400);
  assert.equal((await api(new Request(BASE + "/api/captions?title=X.webm&lang=e%26n"))).status, 400);
  assert.equal((await api(new Request(BASE + "/api/captions?title=https://evil.example/x"))).status, 400);
});
