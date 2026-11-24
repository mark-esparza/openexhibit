// OpenExhibit: medical-aware search over Wikimedia Commons.
// Copyright (C) 2026 OpenExhibit contributors. Licensed under the GNU AGPL v3 or later.
//
// How it works:
// 1. Ask Wikidata what the query means. Its aliases resolve shorthand ("KF ring", "BPPV", "DKA").
// 2. Rank candidates by how many medical identifiers they carry (MeSH, ICD, UMLS, anatomy and drug IDs),
//    so "MI" means myocardial infarction, not Michigan.
// 3. Search Commons three ways at once: the words typed, the canonical name, and the concept's Commons
//    category. Files found by several routes, or by the category, rank higher.
// 4. Pin the concept's own Wikidata images (main image, chemical structure) at the top for images.

import { apiGet, COMMONS_API, type Deps, type FileRecord, getFiles, imageInfoParams, toFileRecord, WIKIDATA_API } from "./core/commons.ts";
import { ToolError, clampInt } from "./core/util.ts";
import { toVideoRecord, videoInfoParams, type VideoRecord } from "./core/video.ts";

/** Wikimedia itself failed; reported as HTTP 502. */
export class UpstreamError extends Error {}

export type MediaType = "image" | "diagram" | "video";

/** Wikidata properties that mark an item as medical, with a display name. */
export const MEDICAL_PROPS: Record<string, string> = {
  P486: "MeSH",
  P672: "MeSH tree",
  P494: "ICD-10",
  P4229: "ICD-10-CM",
  P493: "ICD-9",
  P7807: "ICD-11",
  P2892: "UMLS",
  P699: "Disease Ontology",
  P1402: "FMA (anatomy)",
  P1323: "TA98 (anatomy)",
  P267: "ATC (drug)",
  P652: "UNII (drug)",
  P2175: "treats",
  P780: "signs and symptoms",
  P1995: "specialty",
};

const NOISE = /clinical trial|scholarly article|genetic element|protein.coding gene|\bgene\b|\bprotein\b|disambiguation/i;

export interface Concept {
  id: string;
  label: string;
  description?: string;
  aliases: string[];
  category?: string;
  medical_ids: Record<string, string>;
  url: string;
  pinned_files: string[];
}

export interface Candidate {
  id: string;
  label?: string;
  description?: string;
}

function claimValue(item: any, prop: string): string | undefined {
  const c = (item?.claims?.[prop] ?? []).find((x: any) => x.rank !== "deprecated");
  const v = c?.mainsnak?.datavalue?.value;
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof v.id === "string") return v.id;
  return undefined;
}

/** Strong identifiers that only medical concepts carry. */
const STRONG = ["P494", "P4229", "P493", "P7807", "P2892", "P699", "P1402", "P1323", "P267", "P652"];
/** Weaker medical signals: links to treatments, symptoms, specialties. */
const WEAK = ["P2175", "P780", "P1995"];

export function medicalScore(item: any, description = ""): number {
  const has = (p: string) => Boolean(item?.claims?.[p]?.length);
  let n = 0;
  for (const p of STRONG) if (has(p)) n += 2;
  for (const p of WEAK) if (has(p)) n += 1;
  // MeSH also catalogs places (tree codes starting with Z), so only count it for non-geographic headings.
  if (has("P486")) {
    const trees: string[] = (item.claims.P672 ?? []).map((c: any) => String(c?.mainsnak?.datavalue?.value ?? ""));
    if (trees.length === 0 || trees.some((t) => !t.startsWith("Z"))) n += 1;
  }
  if (NOISE.test(description)) n -= 6;
  return n;
}

/** Minimum medicalScore to treat a Wikidata item as a medical concept. */
export const MEDICAL_THRESHOLD = 2;

function toConcept(item: any): Concept {
  const medical_ids: Record<string, string> = {};
  for (const [p, name] of Object.entries(MEDICAL_PROPS)) {
    const v = claimValue(item, p);
    // Only show real identifiers (strings), not linked items like "treats".
    if (v && !/^Q\d+$/.test(v)) medical_ids[name] = v;
  }
  const pinned: string[] = [];
  for (const p of ["P18", "P117"]) {
    const v = claimValue(item, p);
    if (v) pinned.push("File:" + v);
  }
  return {
    id: item.id,
    label: item.labels?.en?.value ?? item.id,
    description: item.descriptions?.en?.value,
    aliases: (item.aliases?.en ?? []).map((a: any) => a.value).slice(0, 8),
    category: claimValue(item, "P373"),
    medical_ids,
    url: `https://www.wikidata.org/wiki/${item.id}`,
    pinned_files: pinned,
  };
}

/** Work out which medical concept a query most likely means. Returns null if nothing medical matches. */
export async function interpret(deps: Deps, query: string, forcedId?: string): Promise<{ concept: Concept | null; alternatives: Candidate[] }> {
  let hits: any[] = [];
  let ids: string[];
  if (forcedId) {
    if (!/^Q\d+$/.test(forcedId)) throw new ToolError("Invalid concept id");
    ids = [forcedId];
  } else {
    const s = await apiGet(deps, WIKIDATA_API, { action: "wbsearchentities", search: query, language: "en", uselang: "en", type: "item", limit: "7" });
    hits = s?.search ?? [];
    ids = hits.map((h) => String(h.id));
  }
  if (ids.length === 0) return { concept: null, alternatives: [] };

  const e = await apiGet(deps, WIKIDATA_API, { action: "wbgetentities", ids: ids.join("|"), props: "claims|labels|descriptions|aliases", languages: "en" });
  const entities = e?.entities ?? {};

  const scored = ids
    .map((id, pos) => {
      const item = entities[id];
      if (!item || item.missing !== undefined) return null;
      const desc = item.descriptions?.en?.value ?? hits[pos]?.description ?? "";
      const med = medicalScore(item, desc);
      const q = query.trim().toLowerCase();
      const label = String(item.labels?.en?.value ?? "").toLowerCase();
      const match = hits[pos]?.match ?? {};
      // An exact name match beats a related concept with more identifiers ("brachial plexus" is the structure, not the neuropathy).
      const exactLabel = label === q;
      const exactAlias = !exactLabel && match.type === "alias" && String(match.text ?? "").toLowerCase() === q;
      const score = med + (exactLabel ? 6 : 0) + (exactAlias ? 3 : 0) + (item.claims?.P373 ? 1 : 0) - pos * 0.3;
      return { id, item, med, score };
    })
    .filter((x): x is { id: string; item: any; med: number; score: number } => x !== null);

  const medical = scored.filter((x) => forcedId || x.med >= MEDICAL_THRESHOLD).sort((a, b) => b.score - a.score);
  const best = medical[0];
  const alternatives = medical
    .slice(1, 5)
    .map((x) => ({ id: x.id, label: x.item.labels?.en?.value, description: x.item.descriptions?.en?.value }));
  return { concept: best ? toConcept(best.item) : null, alternatives };
}

function filterFor(type: MediaType): string {
  return type === "diagram" ? " filetype:drawing" : type === "video" ? " filetype:video" : "";
}

async function commonsSearch(deps: Deps, search: string, type: MediaType, n: number): Promise<(FileRecord | VideoRecord)[]> {
  const params: Record<string, string> = {
    action: "query",
    generator: "search",
    gsrsearch: search + filterFor(type),
    gsrnamespace: "6",
    gsrlimit: String(n),
    ...(type === "video" ? videoInfoParams(320) : imageInfoParams(320)),
  };
  const data = await apiGet(deps, COMMONS_API, params);
  const pages: any[] = data?.query?.pages ?? [];
  pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const out: (FileRecord | VideoRecord)[] = [];
  for (const p of pages) {
    const rec = type === "video" ? toVideoRecord(p) : toFileRecord(p);
    if (!rec) continue;
    if (type !== "video" && !(rec.mime ?? "").startsWith("image/")) continue;
    out.push(rec);
  }
  return out;
}

export interface SearchResult {
  title: string;
  description?: string;
  mime?: string;
  width?: number;
  height?: number;
  duration_seconds?: number;
  thumb_url?: string;
  page_url: string;
  license: string;
  author: string;
  attribution: string;
  found_by: string[];
}

export interface SearchResponse {
  query: string;
  type: MediaType;
  concept: Concept | null;
  alternatives: Candidate[];
  searched: { route: string; search: string; hits: number }[];
  results: SearchResult[];
}

function quoteCategory(name: string): string {
  return `incategory:"${name.replace(/"/g, "")}"`;
}

export async function medicalSearch(deps: Deps, rawQuery: string, type: MediaType, limitIn: unknown, forcedId?: string): Promise<SearchResponse> {
  const query = String(rawQuery ?? "").trim().replace(/\s+/g, " ");
  if (!query && !forcedId) throw new ToolError("Type something to search for");
  if (query.length > 200) throw new ToolError("Search is too long (200 characters max)");
  const limit = clampInt(limitIn, 1, 40, 20);

  if (forcedId && !/^Q\d+$/.test(forcedId)) throw new ToolError("Invalid concept id");
  // If Wikidata is unavailable, still search Commons with the words typed.
  const { concept, alternatives } = await interpret(deps, query || "x", forcedId).catch(() => ({ concept: null, alternatives: [] as Candidate[] }));

  const routes: { route: string; search: string; weight: number }[] = [];
  if (query) routes.push({ route: "your words", search: query, weight: concept ? 1.5 : 3 });
  if (concept && concept.label.toLowerCase() !== query.toLowerCase()) routes.push({ route: "medical name", search: concept.label, weight: 2 });
  if (concept?.category) routes.push({ route: "Commons category", search: quoteCategory(concept.category), weight: 3 });

  const each = Math.min(50, Math.max(limit, 20));
  const settled = await Promise.allSettled(routes.map((r) => commonsSearch(deps, r.search, type, each)));
  if (routes.length === 0 || settled.every((s) => s.status === "rejected")) throw new UpstreamError("Wikimedia Commons could not be reached. Please try again.");
  const lists = settled.map((s) => (s.status === "fulfilled" ? s.value : ([] as (FileRecord | VideoRecord)[])));

  // Too few hits? Also try the closest related medical concepts (BPPV video search also tries the vertigo item).
  const firstPass = new Set(lists.flat().map((r) => r.title)).size;
  if (concept && firstPass < 5 && alternatives.length) {
    // Only related names that share a real word with the concept, so "heart murmur" never wanders to "Levine scale".
    const words = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
    const base = words(`${concept.label} ${query}`);
    const extra = alternatives
      .filter((a) => a.label && !routes.some((r) => r.search.toLowerCase() === a.label!.toLowerCase()))
      .filter((a) => [...words(a.label!)].some((w) => base.has(w)))
      .slice(0, 2);
    const more = await Promise.allSettled(extra.map((a) => commonsSearch(deps, a.label!, type, each)));
    extra.forEach((a, i) => {
      routes.push({ route: "related term", search: a.label!, weight: 0.8 });
      const m = more[i];
      lists.push(m.status === "fulfilled" ? m.value : []);
    });
  }

  const merged = new Map<string, { rec: FileRecord | VideoRecord; score: number; by: Set<string> }>();
  lists.forEach((list, i) => {
    list.forEach((rec, rank) => {
      const entry = merged.get(rec.title) ?? { rec, score: 0, by: new Set<string>() };
      entry.score += routes[i].weight / (1 + rank * 0.15);
      entry.by.add(routes[i].route);
      merged.set(rec.title, entry);
    });
  });

  // The concept's own Wikidata images go first for image searches.
  if (concept && type !== "video" && concept.pinned_files.length) {
    const { found } = await getFiles(deps, concept.pinned_files, 320).catch(() => ({ found: [] as FileRecord[], missing: [] }));
    for (const rec of found) {
      if (type === "diagram" && rec.mime !== "image/svg+xml") continue;
      const entry = merged.get(rec.title) ?? { rec, score: 0, by: new Set<string>() };
      entry.score += 100;
      entry.by.add("Wikidata image");
      merged.set(rec.title, entry);
    }
  }

  const results = [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ rec, by }) => ({
      title: rec.title,
      description: rec.description,
      mime: rec.mime,
      width: rec.width,
      height: rec.height,
      duration_seconds: rec.duration_seconds,
      thumb_url: rec.thumb_url,
      page_url: rec.page_url,
      license: rec.license,
      author: rec.author,
      attribution: rec.attribution,
      found_by: [...by],
    }));

  return {
    query,
    type,
    concept,
    alternatives,
    searched: routes.map((r, i) => ({ route: r.route, search: r.search + filterFor(type), hits: lists[i].length })),
    results,
  };
}
