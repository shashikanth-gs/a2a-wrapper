# a2a-wrapper website

The documentation site for [a2a-wrapper](https://github.com/shashikanth-gs/a2a-wrapper), built with [Fumadocs](https://fumadocs.dev) on Next.js. Live at <https://a2a-wrapper.allsrc.dev>.

This folder is **not** part of the npm workspaces: it has its own `package.json` and lockfile, so the wrapper packages and their CI are unaffected.

## Develop

```bash
cd website
npm install
npm run dev        # http://localhost:3000
```

`npm run dev` and `npm run build` first run `npm run sync` (see below).

## Where content lives

| Kind | Location | Edit here? |
|---|---|---|
| Hand-written pages (intro, getting started, concepts, guides, reference, AI, roadmap) | `content/docs/**/*.mdx` | Yes |
| Package reference, Security guide, Contributing, per-package changelogs | `content/docs/**/*.md`, **generated** | No: edit the source file in the repo |
| Sidebar order | `meta.json` in each folder | Yes |

`scripts/sync-reference.mjs` copies these repo files into the docs on every dev/build, so the docs can never drift from the code:

| Docs page | Source file |
|---|---|
| `reference/packages/*` | each package's `README.md` |
| `guides/security` | `docs/security.md` |
| `community/contributing` | `CONTRIBUTING.md` |
| `community/changelog/*` | each package's `CHANGELOG.md` |

It also copies the demo GIFs from `docs/assets/` into `public/media/`. The generated files are git-ignored.

## SEO and AI features (built in)

- Per-page title, description, canonical URL, Open Graph and Twitter cards, with a generated OG image for every docs page (`/og/docs/...`)
- `sitemap.xml`, `robots.txt`, and schema.org JSON-LD (`WebSite`, `SoftwareSourceCode`, `TechArticle`, `BreadcrumbList`, `SoftwareApplication`, `FAQPage`)
- `/llms.txt` and `/llms-full.txt`
- Every page as Markdown: append `.md` to the URL, or send `Accept: text/markdown`
- "Copy Markdown" and "Open in..." buttons on each page
- A read-only docs MCP server at `/mcp` (tools: `search_docs`, `get_page`, `list_pages`)
- Full-text search (Orama) at `/api/search`

Set `NEXT_PUBLIC_SITE_URL` if the site is served from a different origin than `https://a2a-wrapper.allsrc.dev`.

## Build and check

```bash
npm run lint
npm run types:check
npm run build
npm run start
```

## Deploy

The site needs a Node runtime because of the search API, the MCP route and the Markdown content negotiation in `src/proxy.ts`, so it cannot be exported as plain static files.

- **Vercel:** import the repository and set the **Root Directory** to `website`. No other settings are needed.
- **Anywhere Node runs:** `npm run build && npm run start`.
- **Cloudflare:** use an adapter such as OpenNext for Cloudflare.

The build reads files from the repository root (READMEs, changelogs), so the deploy must check out the whole repository, not just this folder.
