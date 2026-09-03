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
> scripts, no CDN references, no `eval()`, no `new Function()`, and no
> `importScripts()` of anything outside the package. The libraries the extension
> injects are its own files, listed in the manifest's package.

Verified against the shipped files: no `eval`, no `new Function`, no remote
`<script src>`, and no `fetch`, `XMLHttpRequest`, `sendBeacon` or `WebSocket`
anywhere in `background.js`, `content.js`, `page_inject.js`, `popup.js` or
`lib/*.js`.

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
2. **Screen capture for PDFs.** `chrome.tabs.captureVisibleTab` is covered by
   `activeTab` and needs no separate permission, but if asked: Chrome renders
   PDFs in an internal viewer whose pixels an extension cannot read, so
   digitizing a PDF page requires capturing the rendered tab. The capture is
   drawn to a canvas in the page and never leaves the device.
