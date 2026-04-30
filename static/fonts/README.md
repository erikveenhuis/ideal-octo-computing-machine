# Fonts for SVG Export

This directory hosts the `.otf` font files that
[`static/js/components/font-manager.js`](../js/components/font-manager.js)
embeds (base64) into SVG exports so the downloaded file always renders
identically, regardless of whether the recipient has the font installed.

## What is shipped today

Only four DIN Pro variants are committed:

```
static/fonts/DIN Pro/
  COPYRIGHT.txt        # license / attribution for the font family
  dinpro.otf           # Regular
  dinpro_bold.otf      # Bold
  dinpro_italic.otf    # Italic
  dinpro_medium.otf    # Medium
```

These are the four weights actually used by the Mapbox styles in
[`static/js/gpx-config.js`](../js/gpx-config.js). The
`FontManager.setupDefaultMappings()` table also references several other
DIN Pro variants (Light, Black, Condensed, …) so that *if* you drop those
files into `DIN Pro/`, they will be picked up automatically. Until then,
requests for those variants will quietly fall back through the Mapbox
fallback chain.

## Adding a font

1. Place the `.otf` file under `static/fonts/<Family>/<file>.otf`.
2. Update `setupDefaultMappings()` in
   [`font-manager.js`](../js/components/font-manager.js) so the Mapbox
   font name (e.g. `My Font Bold`) maps to the relative path
   (`<Family>/myfont_bold.otf`).
3. Export an SVG and confirm in DevTools that the response for
   `/static/fonts/<Family>/<file>.otf` is 200 (not 404).

## Conventions

- **Format**: `.otf` only. The base64 embedding pipeline assumes OTF;
  TTF would also work but has not been tested.
- **Naming**: lowercase, underscores, e.g. `dinpro_bold.otf`. Keep file
  names ASCII so they survive URL-encoding from arbitrary clients.
- **Size**: keep individual files under ~1 MB. Each embedded font roughly
  doubles in size after base64 encoding inside the SVG.

## Licensing

DIN Pro is a commercial typeface licensed for the project; see
[`DIN Pro/COPYRIGHT.txt`](DIN%20Pro/COPYRIGHT.txt). Do **not** open the
embedded fonts in a public CDN — the base64 embed is allowed because the
SVG is delivered to the same end user, but a public extraction would
violate the license.
