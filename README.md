# OpenExhibit

Medical education search for freely licensed images, diagrams and videos from Wikimedia Commons, with a ready credit line for every file.

Live site: [openexhibit.mesparza.workers.dev](https://openexhibit.mesparza.workers.dev)

> OpenExhibit is for education, not diagnosis. Media is not reviewed for accuracy.
> Wikimedia Commons is a trademark of the Wikimedia Foundation. OpenExhibit is not affiliated with or endorsed by the Wikimedia Foundation.

## What makes the search medical

A plain Commons search for `MI` returns pictures of Michigan. OpenExhibit first works out what you mean:

1. **Interpret.** Wikidata's search matches the query against names and aliases, which covers shorthand such as `KF ring`, `BPPV` and `DKA`.
2. **Rank by medical evidence.** Each candidate is scored by the medical identifiers it carries (MeSH, ICD 9, 10 and 11, UMLS, Disease Ontology, FMA and TA98 anatomy codes, ATC and UNII drug codes). Clinical trials, articles and genes are pushed down. So `MI` resolves to myocardial infarction.
3. **Search three ways.** Commons is searched for the words typed, the standard medical name, and the concept's Commons category. A file found by several routes, or by the category, ranks higher.
4. **Pin the concept's own images.** For images and diagrams, the concept's Wikidata image and chemical structure appear first.

Every results page shows a Search Details table, with the interpretation, identifiers, other possible meanings, and the exact searches run, so nothing is hidden.

## Features

- Images, diagrams (SVG) and videos
- File pages with full size media, author, license, categories and three credit formats (standard, AMA, HTML), each with a Copy button
- Videos play in the page, preferring the MPEG 4 copy for iPhone and Safari, with English captions when available
- Share-alike warning on BY SA files
- Late 1990s academic look, readable on phones

## API

| Endpoint | Returns |
| --- | --- |
| `GET /api/search?q=MI&type=image\|diagram\|video[&concept=Q12152][&limit=20]` | Interpretation, alternatives, searches run, ranked results |
| `GET /api/file?title=File:Name.jpg` | Full file details, playable video sources, credit lines |
| `GET /api/captions?title=File:Name.webm&lang=en` | WebVTT captions, served from this origin |
| `GET /api/health` | Version |

Responses are cached at the edge for an hour to keep load on Wikimedia low.

## Run and deploy

Requires Node 22.18 or newer.

```sh
npm install
npm test          # API tests with mocked Wikimedia responses
npm run dev       # http://localhost:8787
npm run deploy    # Cloudflare Workers (free plan is enough)
```

Set `CONTACT` in `wrangler.jsonc` to a URL or email you check; it is sent in the User-Agent header as [Wikimedia's policy](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy) asks.

## Taking the site offline

Set `"MAINTENANCE": "true"` in `wrangler.jsonc` and push. Every page and API call then returns a short "temporarily unavailable" page (HTTP 503, not indexed by search engines) and no requests reach Wikimedia. Set it back to `"false"` and push to bring the site back. Because the switch lives in the code, a later deploy cannot turn the site back on by accident.

## Safeguards

- **Rate limit:** 30 API calls per minute per visitor (Cloudflare rate limiting binding); extra calls get HTTP 429.
- **Same-origin API:** no CORS headers, so other websites cannot use the API from their pages. Only GET is accepted, and URLs over 2048 characters are refused.
- **Input checks:** queries capped at 200 characters, results at 40, concept IDs and caption languages validated, and media fetched only from Wikimedia hosts.
- **Security headers:** strict Content Security Policy, no framing, HSTS, and camera, microphone and location access disabled.
- **Crawlers:** `robots.txt` keeps search engines off `/api/`, and API responses carry `noindex`.
- **Caching:** results cached at the edge for an hour, keeping load on Wikimedia low.
- **Cost:** on the Cloudflare Workers free plan, traffic over the daily request allowance is refused rather than billed.

## Related

- [wikimedia-commons-mcp](https://github.com/mark-esparza/wikimedia-commons-mcp): the same Commons tools as a connector for Claude. The files in `src/core/` come from that project under the MIT License.

## License

OpenExhibit is free software under the GNU Affero General Public License, version 3 or later. If you run a modified version for others over a network, you must offer them its source code. See `LICENSE`.

Media shown by OpenExhibit belongs to its authors and keeps its own license, which the site displays for every file.
