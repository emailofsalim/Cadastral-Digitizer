# Chrome Web Store submission

Paste-ready answers for the Developer Dashboard's **Privacy practices** tab, plus
a privacy policy you can host.

Every claim below was checked against the shipped code rather than remembered.
Where something is arguable, it says so — a reviewer who finds an omission you
did not mention treats everything else you wrote with more suspicion, so the one
outbound navigation this extension makes is declared up front rather than left
to be discovered.

Build the upload with `npm run package`.

---

## Single purpose

> Digitize cadastral and survey parcel boundaries from map portals, scanned
> sheets, images and PDF pages, and export them as DXF, KML, KMZ, GeoJSON,
> Shapefile, WKT or CSV.

A single purpose statement is not a feature list, and the store rejects ones that
read like one. Everything the extension does — tracing, ground control points,
topology clean-up, coordinate conversion — exists to turn a parcel boundary into
an exportable file, which is why they belong to one purpose rather than several.

---

## Permission justifications

### `activeTab`

> The extension digitizes the map, scanned sheet or PDF page the user is
> currently looking at. `activeTab` gives it access to that one tab, only after
> the user clicks the toolbar button or presses the keyboard shortcut, and only
> for that visit.
>
> This is deliberately used *instead of* host permissions. Cadastral portals run
> on hundreds of separate government domains across many countries, and there is
> no realistic match pattern that covers them without requesting read-and-change
> access to every site the user visits. `activeTab` gives the same capability
> scoped to a single deliberate user action, so the extension can work on any
> portal without holding standing access to any of them.

### `scripting`

> The extension's tools have to run inside the page, because the geometry it
> reads belongs to the page's own map library — an OpenLayers, Leaflet, MapLibre,
> Mapbox GL or Google Maps instance whose coordinate methods are only reachable
> from the page's JavaScript world, not from an isolated content script.
>
> `scripting` is used to inject the extension's own bundled files, in the page
> world, when the user activates it on a tab. All injected code ships inside the
> extension package; nothing is fetched or evaluated from a remote source.
>
> One further injection happens on demand: when the user opens a PDF, the
> bundled PDF rendering library (Mozilla's PDF.js, in `vendor/`) is injected into
> the same tab so the file can be rasterised locally. It is 1.4 MB and is of no
> use to sessions that never open a PDF, which is the only reason it is injected
> on demand rather than at activation. It is read from the extension package like
> every other injected file, and needs no permission beyond the `activeTab` grant
> the user has already given that tab.

### Why there are no host permissions

Worth stating explicitly in the listing description, because it is unusual and it
is the strongest thing about this extension's privacy posture:

> This extension requests no host permissions. It has no standing access to any
> website. Nothing happens until you click its toolbar button on a tab, and the
> access it receives then covers that tab, that visit, and nothing else.

---

## Remote code

**Answer: No, I am not using remote code.**

> All executable code ships inside the extension package. There are no remote
> scripts, no CDN references, and nothing is loaded or evaluated from outside the
> package at any point. The extension bundles one third-party library — Mozilla's
> PDF.js, under Apache-2.0, used to render PDF pages locally — which is included
> verbatim in the package and never fetched.

Verified against the extension's **own** files: no `eval`, no `new Function`, no
remote `<script src>`, and no `fetch`, `XMLHttpRequest`, `sendBeacon` or
`WebSocket` anywhere in `background.js`, `content.js`, `page_inject.js`,
`popup.js` or `lib/*.js`.

**PDF.js is a general-purpose library and does contain such constructs**, in code
paths this extension does not take. Stated plainly rather than glossed, because a
reviewer running a string search will find them:

| Found in `vendor/*.js` | Why it does not run here |
|---|---|
| `eval("require")(…)` | A Node.js-only branch, guarded by PDF.js's `isNodeJS` check. It cannot be reached in a browser. |
| `new Function` | PDF.js's compiler for PostScript functions embedded in a PDF. The extension passes `isEvalSupported: false`, which is exactly the option that turns it off; PDF.js then interprets those functions instead. |
| `importScripts` | Part of PDF.js's Web Worker bootstrap. The extension runs it on the main thread instead — see below — so no worker is ever created and that path is never entered. |
| `fetch` / `XMLHttpRequest` | PDF.js's transports for fetching a PDF **by URL**, and for character maps and standard font data. The extension hands it the file's bytes directly and configures no `cMapUrl` or `standardFontDataUrl`, so no transport is constructed and no URL exists to request. |

That last row is asserted by a test, not just described: the end-to-end suite
imports a real PDF in real Chrome with a request listener attached, and requires
the count of network requests made during the import to be **zero**.

**Why the renderer runs on the main thread.** PDF.js normally rasterises in a Web
Worker. A worker would have to be created from a `chrome-extension:` URL inside
the *page's* world, where the visited site's own Content-Security-Policy applies
— a site with a `worker-src` directive would block it, and PDF import would fail
on that site with nothing the user could do about it. Loading the worker bundle
into the same context is PDF.js's own documented way of running without a worker
thread, and it is what the extension does.

---

## Data usage

Tick **none** of the data categories. The extension collects nothing, in the
store's sense of the word: no data is transmitted off the user's device.

All three certifications can be accepted honestly:

- ✅ I do not sell or transfer user data to third parties, outside of approved use cases
- ✅ I do not use or transfer user data for purposes unrelated to my item's single purpose
- ✅ I do not use or transfer user data to determine creditworthiness or for lending purposes

### What the extension holds, and where

Useful to have ready if a reviewer asks, and accurate:

| What | Where it lives | Leaves the device? |
|---|---|---|
| Traced parcel geometry, control points, project state | `sessionStorage` / `localStorage` on the portal's own origin | No |
| Saved named projects | `localStorage` | No |
| Settings (tolerances, defaults, panel state) | `localStorage` | No |
| Screen captures used for PDF digitizing | Held in the page, drawn to a canvas | No |
| Exported files (DXF, KML, KMZ, GeoJSON, Shapefile, WKT, CSV, project JSON) | Written to the user's Downloads folder | No |

There is no analytics, no telemetry, no crash reporting, and no server operated
by the developer. The extension has no backend.

### The one outbound navigation — declare this

**"Check on map"** opens `openstreetmap.org` in a new tab with the current map
centre in the URL, so the operator can confirm a UTM zone is right before
exporting. It is a link, opened only when that button is pressed.

Suggested wording:

> The extension makes no network requests of its own. One optional feature,
> "Check on map", opens openstreetmap.org in a new tab with the current map
> centre's coordinate in the link, so the user can visually confirm their
> coordinate system is correct. This happens only when the user presses that
> button, and is equivalent to the user typing those coordinates into
> OpenStreetMap themselves. No data is sent to the developer, who operates no
> server.

This is not "collecting user data" under the store's definition and does not
require ticking a data category. Declaring it anyway costs nothing and removes
the chance of a reviewer finding an undisclosed external hostname in the code.

---

## Privacy policy

The store asks for a policy URL. Host this anywhere stable — a GitHub Pages page
or a gist is fine — and paste the link into the dashboard.

> ### Privacy Policy — Cadastral Digitizer
>
> *Last updated: [date]*
>
> **Cadastral Digitizer does not collect, store, transmit or sell any personal
> information.**
>
> The extension runs entirely on your computer. It has no server, no analytics,
> no telemetry and no account system. The developer receives nothing from your
> use of it and cannot see what you digitize.
>
> **What the extension stores on your own device**
>
> Your digitized parcels, ground control points, saved projects and settings are
> kept in your browser's local storage, on the site you are working on. They stay
> on your computer, are readable only by you, and are removed when you clear your
> browser data. Files you export are written to your Downloads folder.
>
> **Access to websites**
>
> The extension requests no standing access to any website. It can act only on
> the tab you are viewing, and only after you click its toolbar button or press
> its keyboard shortcut, for that visit alone.
>
> **Network activity**
>
> The extension makes no network requests. One optional feature, "Check on map",
> opens OpenStreetMap in a new tab with your current map centre in the link, so
> you can confirm your coordinate system is correct. This happens only when you
> press that button. OpenStreetMap's own privacy policy applies to that page.
>
> **Contact**
>
> [your contact email] · Source code: https://github.com/emailofsalim/Cadastral-Digitizer

---

## Before you submit

- [ ] `npm run package` → upload `dist/cadastral-digitizer-<version>.zip`
- [ ] Screenshots (1280×800 or 640×400). The strongest ones are a traced parcel
      over a live portal, the RF calibration on a scanned sheet, and an export
- [ ] Store icon at 128×128 — already shipped as `icon128.png`
- [ ] Privacy policy hosted, URL pasted in
- [ ] Category: **Productivity** or **Developer Tools**; Productivity fits better
      for a surveying tool
- [ ] The description should lead with the no-host-permissions point. Reviewers
      see a lot of extensions asking for far more than this one does, and it is a
      genuine differentiator rather than a marketing line

### Two things likely to draw a question

1. **`scripting` with page-world injection.** Unusual enough to be looked at.
   The justification above answers it directly: the page's map object is only
   reachable from the page's own JavaScript world. Being specific about *why*
   is what makes this read as a technical necessity rather than over-reach.
2. **Screen capture.** `chrome.tabs.captureVisibleTab` is covered by `activeTab`
   and needs no separate permission, but if asked: it exists for a map canvas
   the page protects from being read, and for a PDF already open in Chrome's
   internal viewer, whose pixels an extension cannot read. The capture is drawn
   to a canvas in the page and never leaves the device.
3. **A 1.4 MB minified third-party file.** `vendor/pdf.min.js` and
   `vendor/pdf.worker.min.js` are Mozilla's PDF.js, unmodified, with the upstream
   licence in `vendor/LICENSE-pdfjs` and the exact version and source recorded in
   `vendor/README.md`. The Remote code section above covers what a string search
   through them will turn up.
