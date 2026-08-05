# DevHarmonics landing page

A single, self-contained static site — `index.html`, no build step, no
framework, no external dependencies. All CSS and the small progressive-
enhancement script (mobile nav) are inline, so the file opens correctly from
disk or from any static host.

## Run it locally

Open `index.html` directly in a browser, or serve the directory:

```bash
# any static server works; two examples
python -m http.server -d site 8000
npx serve site
```

Then visit the printed URL.

## Deploy

The page is plain static HTML, so any static host serves it: GitHub Pages,
Netlify, Cloudflare Pages, an S3 bucket, or a plain web server.

A GitHub Pages workflow is included at `.github/workflows/pages.yml`. It is
**manual only** (`workflow_dispatch`) — it never runs on push, so nothing is
published without an explicit click. To use it: enable Pages for the repository
(Settings → Pages → Source: GitHub Actions), then run the "Deploy landing page"
workflow from the Actions tab. It publishes the contents of `site/`.

## Maintaining it

- Keep claims tied to the code. Every capability on the page maps to something
  in `scripts/` or `docs/`; the honest-status section mirrors the manual's
  Known Limitations. When behavior changes, update both.
- The terminal transcripts use real output shapes (the `doctor` block is a real
  capture). Don't replace them with invented metrics, counts, or logos.
- Links point at the canonical repo and its `docs/` on `main`. If a doc moves,
  update the hrefs in `index.html`.
- The design commits to one dark theme on purpose (the product's control-room /
  audit-log identity). Contrast targets WCAG AA on the dark background.
