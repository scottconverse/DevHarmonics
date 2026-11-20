# DevHarmonics landing page

A static site: `index.html`, `assets/site.css`, `assets/site.js` and `assets/favicon.svg`.
There is no build step, no framework and no external request. All asset paths are
relative, so it works from disk, from a local server, and under the GitHub Pages
project path `https://scottconverse.github.io/DevHarmonics/`.

## Run it locally

Open `index.html` in a browser, or serve the folder:

```bash
python -m http.server -d site 8000
npx serve site
```

## Deploy

`.github/workflows/pages.yml` uploads `site/` as the Pages artifact. It is manual
only (`workflow_dispatch`). To publish: Settings, Pages, Source: GitHub Actions,
then run the "Deploy landing page" workflow from the Actions tab.

## Maintaining it

- Every claim must trace to code or docs in this repository. The page draws on
  `docs/USER_MANUAL.md`, `docs/ARCHITECTURE.md`, `docs/FALSIFICATION.md`,
  `livefire/README.md` and `scripts/config.mjs` (the default ceilings). When
  behavior changes, update the page with it.
- The terminal blocks are real output (the `doctor` capture and the retained
  live-fire result) or are labeled as a shape. Do not replace them with invented
  numbers, logos or testimonials.
- Doc links point at `main` on GitHub. If a doc moves, update the hrefs.
- One dark theme on purpose (control-room and audit-log identity). Design tokens
  live at the top of `assets/site.css`.
- Keep the page free of the U+2014 character; use commas, colons or periods.
