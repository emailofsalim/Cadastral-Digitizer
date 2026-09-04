# BhuNaksha / Cadastral Digitizer — Upgrade Instructions, adjusted to the real project

This is the v17 upgrade brief, rewritten against the code that actually exists in this
repository (v16.3.0, 434 tests). The original —
`BhuNaksha_Digitizer_Final_Upgrade_Instructions.txt` — has been removed from the working
tree now that it is fully implemented; it remains in history at `b34b065` for anyone
comparing this document against what was asked for.

The original brief was written without sight of the codebase, so it asks for a number of
things that are **already built and tested**, and it describes others in terms that do not
match this project's architecture. Implementing it literally would have meant rebuilding
working, tested subsystems — exactly the outcome the brief's own §27 and Final Principle
forbid.

Each section below states: **what the brief asked**, **what the project already has**, and
**what is actually being changed**. Nothing is dropped; several items are marked *already
satisfied* because they are.

---

## 0. Ground rules for this upgrade

- **The core is not replaced.** `lib/*.js` stays pure (no DOM, no map object), which is what
  makes the 434 tests meaningful. New logic goes into new pure libraries beside the existing
  ones; `page_inject.js` stays UI, gestures and glue.
- **No existing test is deleted or weakened.** The baseline is 434 tests / 0 failures
  (391 immediately, 420 with `jsdom`). It must not go down.
- **Existing DOM ids are preserved.** `test/browser_integration.test.js` drives the real
  widget through ids (`#xDxf`, `#xKmz`, `#xGeo`, `#xShp`, `#xWkt`, `#xCsv`, `#xArea`,
  `#delAll`, `#delLast`, `#gUndo`, …). Moving a control into a dropdown means **hiding it
  with CSS, not removing it from the DOM**, or the harness can no longer reach it.
- **Every button must survive being clicked blindly, twice, in any state** — there is a test
  that does exactly that (`driving every control raises no exception`).
- **No new runtime dependencies.** The extension ships unbundled with none, and it stays
  that way. KMZ inflation uses the platform's `DecompressionStream('deflate-raw')`, present
  in Chrome and in Node ≥18, rather than a bundled inflate.

---

## 1. Main buttons — exactly three

**Asked:** `IMPORT ▾ | EXPORT ▾ | SAVE PROJECT`, with project import/export living inside the
dropdowns and no separate permanent buttons.

**Have:** a flat `Export` card with nine buttons — DXF, KMZ, GeoJSON, Shapefile, WKT,
Vertices, Area report, Save project, Load project. No import path at all except project JSON
and QGIS `.points`.

**Doing:** one `Import ▾ | Export ▾ | Save Project` row replaces the card. Both menus are
rendered into the DOM at all times and shown/hidden with a CSS class, so the existing export
ids keep working. `Save project` / `Load project` move inside the menus as
*Export → Project JSON* and *Import → Project JSON*; the standalone **Save Project** button
is the quick-save described in §20, which is a different action.

## 2. Automatic cadastral overlay on import

**Asked:** importing DXF / CSV / KML / KMZ / Project JSON creates the layer, overlays it on
the map, preserves plot numbers, attributes, CRS and precision, and never makes the user
position the geometry by hand. Ask rather than guess when the CRS is unclear.

**Have:** nothing. There is no import of geometry in any format.

**Doing:** new `lib/importers.js`. Imported rings become ordinary shapes in `st.shapes`
through the same `makeShape` path a traced parcel uses, so they are overlaid by the existing
renderer with no positioning step. Coordinates are carried through unrounded. When a file
declares no CRS and the session has none, the import **asks** — it does not guess. KML/KMZ
is the one exception where the CRS is known by specification (WGS 84 lon/lat).

## 3. Move / shift cadastral geometry

**Asked:** move whole parcels inside the Edit workflow, by drag and by precise X/Y, for both
imported and digitized geometry, never moving the basemap or unrelated parcels, recoverable
through undo/reset.

**Have:** Edit mode drags a **vertex**. There is no whole-geometry move.

**Doing:** a `move` mode. Select a parcel, drag it bodily; or type ΔX/ΔY and apply. Map pan
is untouched — the existing gesture layer already separates *tap/drag on a handle* (the tool)
from *drag on the map* (a pan), and moving a parcel hooks the same handle mechanism, so
§26's separation holds by construction rather than by convention.

## 4. Non-destructive geometry shift

**Asked:** `Original → Transformation → Display → Export`, with translation/rotation/scale
stored separately so a shift can be undone, reset, compared and exported.

**Have:** two mechanisms that already do most of this — `st.backups[shapeId]` holds the
pre-correction original with a per-shape revert (`↺`), and `lib/history.js` snapshots the
whole session for undo/redo.

**Adjustment worth stating.** Rebuilding the pipeline so that `points` becomes a *derived*
value computed from `sourcePoints × transform` would touch every consumer of `s.points` —
tracing, editing, topology, quality scoring, all seven exporters — for no gain the existing
backup + snapshot already provides, and it would put the most heavily tested paths in the
program at risk. The brief's own §27 says not to do this.

**Doing instead, satisfying every bullet §4 actually lists:** `s.points` stays the live,
displayed and exported geometry (so §25 is true for free — a corrected parcel exports
corrected). Alongside it each shape gains `s.shift = { dx, dy, rotationDeg, scale }`,
a **separately stored, cumulative record** of every transform applied to it. That gives
undo (Ctrl+Z), reset (revert to `backups`), comparison (the record states exactly what was
done, in metres and degrees), and export of the corrected geometry.

## 5. Cadastral alignment — *already satisfied*

`lib/gcp_math.js` (1188 lines, its own test suites) already provides translation, similarity,
affine, projective and thin-plate spline, with RANSAC + Huber robust fitting, leave-one-out
cross-validation and automatic model selection. It already defaults to **translation** — the
least-distorting model — exactly as §5's last line asks.

The select → reference → calculate → preview → apply workflow exists, including the live
dashed preview and a confirmation stating furthest movement and distortion.

**Doing:** nothing to the maths. The GCP card becomes collapsible (§7) and the shift
bookkeeping from §4 records what an apply did.

## 6. GCP CSV import

**Asked:** a format-selection popup before loading, supporting auto-detect, `ID,E,N,Z`,
`ID,X,Y,Z`, `ID,Lat,Lon,Elev` and custom column mapping; a preview; delimiter and CRS
selection; import only after confirmation. Retain existing fitting and outlier detection.

**Have:** `Exp.parseGcpPointsFile` reads the QGIS `.points` format only, and imports
immediately with no preview.

**Doing:** a real format dialog in front of it — delimiter sniffing, a parsed preview of the
first rows, per-column role assignment, CRS choice, and an explicit Import button. The QGIS
`.points` path is kept as a recognised format, not replaced. Fitting, residuals and outlier
rejection are untouched.

## 7. Collapsible cadastral tools

**Asked:** make How This Works, Cleanup, Edit, Ground Control Point, Import/Export and
Settings collapsible; keep the map area uncluttered.

**Have:** only Settings collapses.

**Doing:** all six become `<details>` sections with their open/closed state persisted.
`<details>` keeps the contents in the DOM when closed, which is what preserves the test
harness's reach.

## 8. Undo / Redo

**Asked:** `Undo | Redo | Remove Last | Reset Everything` at the head of the editing
controls; extend the existing history rather than replacing it; cover creation, deletion,
vertex edits, movement, shifting, cleanup and GCP changes.

**Have:** `lib/history.js` snapshots the whole session document and already covers every one
of those operations except movement and shifting, which do not exist yet. A test
(`R14`) *finds every line that mutates the session and requires a recorded step*, so new
mutations cannot skip history. Undo/redo buttons exist but sit mid-panel; Remove last and
Reset everything sit in the Shapes card.

**Doing:** the four buttons move into one bar at the top of the editing controls. Move and
shift commit through the same `commit(label)` the rest of the program uses. `#delLast`,
`#delAll`, `#gUndo`, `#gRedo` keep their ids.

## 9. Cleanup — *already satisfied, made collapsible*

Regularise, snap shared edges, overlap detection, quality scoring and geometry validation all
exist in `lib/topology.js` and are undoable. They already work on any shape in `st.shapes`,
so they work on imported geometry the moment §2 lands — that is the point of §23.

## 10. Edit

**Asked:** Select, Move Geometry, Move Vertex, Add Vertex, Delete Vertex, Rotate, Scale,
Copy, Duplicate, Delete.

**Have:** one `edit` mode where dragging a handle moves a vertex, tapping an edge inserts one
and alt-tapping a handle deletes one. Delete-shape exists in the shape list. No select, move,
rotate, scale, copy or duplicate.

**Doing:** an Edit card that names all of them. Move Vertex / Add Vertex / Delete Vertex are
the existing behaviours given explicit buttons rather than being discoverable only by
modifier key — the underlying handlers are unchanged. Select, Move Geometry, Rotate, Scale,
Copy, Duplicate and Delete are new, acting on the selected parcel. Rotate and Scale take a
numeric value and operate about the parcel's own centroid, so a rotation does not also
translate it.

## 11. Image / PDF workspace — *largely satisfied, extended*

Import/open, position (pan/zoom), GCP georeferencing and digitization over the drawing all
exist in `lib/raster_workspace.js` + `lib/viewport.js`.

**Adding:** rotation, opacity and lock, which the workspace does not have; plus RF scale and
scale-bar calibration (§12–13).

## 12–13. RF drawing scale and scale-bar calibration

**Asked:** enter an RF such as 1:2000 and have the application use it as the real-world
drawing scale, distinct from screen zoom; also calibrate from two picked points and a known
ground distance; store the calibration in the project.

**Have:** nothing. A raster is pixels until GCP georeferencing gives it world coordinates.

**Doing:** new maths in `lib/geom_edit.js`, exposed on the workspace card.

Ground distance from an RF requires the drawing's physical resolution, because an RF relates
*paper* distance to *ground* distance. For a scanned sheet that is the scan DPI:

```
ground_metres_per_pixel = RF_denominator / (DPI / 0.0254)
```

So the RF field is paired with a DPI field, defaulting to 300 with the common values
offered. This is stated in the panel rather than hidden, because an RF alone cannot yield a
scale and quietly assuming a DPI would be exactly the sort of silent guess §2 forbids.

The scale-bar route needs no DPI and is therefore the more reliable one: two picked points
plus a typed ground distance give metres-per-pixel directly. Both write the same
`st.calibration` record, both are stored in the project, and neither is affected by screen
zoom — the viewport's scale is a display property and is never read by the calibration.

## 14. Image / PDF + GCP georeferencing — *already satisfied*

`Import Drawing → Set RF Scale → Add GCPs → Match → Calculate → Preview → Apply` — every
stage but the RF one already exists and reuses the same solver as the live map. §12 adds the
missing stage.

## 15. PDF handling — *already satisfied*

The project already refuses to pretend it can read PDFium pixels and routes PDFs through
`chrome.tabs.captureVisibleTab`, with the screen-resolution limitation stated in the UI. A
real PDF through this path is covered by the Chrome E2E suite. Unchanged.

## 16–18. DXF, CSV vertices and KMZ/KML import

**Doing, in `lib/importers.js`:**

- **DXF** — ASCII DXF, `LWPOLYLINE` / `POLYLINE` / `LINE` entities, layers preserved on
  `shape.layer`, absolute coordinates carried through untouched, plot numbers taken from
  `TEXT`/`MTEXT` falling inside a ring where present.
- **CSV vertices** — `ID,X,Y`, `ID,E,N`, `ID,X,Y,Z`, `ID,Lat,Lon`, with delimiter sniffing,
  column mapping and CRS selection; rings are grouped by the id column so one file can carry
  many parcels.
- **KML/KMZ** — `Polygon`, `LinearRing`, `MultiGeometry` and `Placemark` name/description
  and `ExtendedData` attributes. KMZ is a ZIP: stored entries are read directly, deflated
  entries through `DecompressionStream`. Anything unsupported is **skipped with a count**,
  not a crash, as §18 requires.

All three produce ordinary shapes, so §23 holds by construction.

## 19–20. Project JSON and Save Project

**Have:** `serialiseSession()` stores shapes, control points, backups, plot metadata, CRS and
project name. It does **not** store georeference points, workspace calibration, layers,
styles or shift records.

**Doing:** extended to store everything §19 lists, with a `schema` field so an older project
still loads. Save Project becomes a main button that writes `ProjectName.json` and, once
named, updates that project rather than making duplicates.

## 21. Google Earth compatibility — *already satisfied*

KML and KMZ exports exist, escape their text correctly, and carry plot numbers, names,
descriptions and corrected coordinates. Unchanged.

## 22. Capture View — *already satisfied, improved*

Exists as the PDF path. **Adding:** the widget hides itself for the duration of the capture
and restores afterwards, which is the part of §22 that is achievable. Browser security
prevents OS-level minimisation and the panel does not claim otherwise.

## 23–24. Imported geometry uses the existing editing system; layer model

Imported rings are the same shape objects as digitized ones, so Edit, Move, Cleanup, GCP,
Undo/Redo, area calculation and export all apply unchanged — no second editor.

**Adding** a `source` field (`traced` / `drawn` / `imported`) and a `layer` name, so the
Reference Map / Imported / Digitized / Drawing / GCP distinction §24 asks for is visible and
filterable, while both remain independently selectable and editable.

## 25. Export after correction — *already satisfied*

Because `s.points` is the corrected geometry (see §4), every exporter emits corrected
coordinates. The `shift` record makes what was corrected explicit rather than implicit.

## 26. Operations kept distinct — *already satisfied by design*

Map pan, geometry move, RF scale, screen zoom and GCP georeferencing are separate code paths
touching separate state. The gesture layer already distinguishes a tool tap from a map pan,
and the calibration never reads viewport scale.

## 27. Existing architecture

`page_inject.js`, `raster_workspace.js`, `gcp_math.js`, `history.js`, `exporters.js`,
`crs.js`, `topology.js`, `site_adapters.js`, `tracer.js`, `viewport.js` are all extended in
place or left alone. Two new pure libraries are added rather than growing existing ones past
their subject: `lib/importers.js` and `lib/geom_edit.js`. The map-adapter architecture is
untouched.

*(Note: the brief names `site_adapters.js` and the tracer/viewport separately; both are
preserved exactly.)*

## 28–29. Workflows and final UI principle

Both are consequences of the above rather than separate work.

## 30. Regression testing

Run the existing suite; add tests for every new capability; delete nothing. New coverage:
`test/importers.test.js`, `test/geom_edit.test.js`, plus new requirement assertions in
`test/requirements.test.js` for the three-button UI, collapsible sections, the Edit tool set,
move/shift, RF and scale-bar calibration, and the extended project schema.

---

## Summary

| § | Status |
|---|---|
| 5, 9, 14, 15, 21, 25, 26 | Already satisfied — verified, left alone |
| 11, 22 | Mostly satisfied — extended |
| 1, 6, 7, 8, 10, 19, 20, 24 | Existing subsystems restructured or extended |
| 2, 3, 4, 12, 13, 16, 17, 18 | Genuinely new |
| 23, 27, 28, 29 | Constraints, honoured throughout |

One deliberate deviation from the literal brief, stated plainly: **§4's non-destructive
pipeline is implemented as a separately-stored transform record over live geometry, not as
derived display geometry**, because the latter would rewrite every consumer of `s.points`
and put the most-tested paths in the program at risk for no capability §4 actually asks for.
Undo, reset, compare and export-corrected all work.

One thing the brief could not know: **an RF alone does not determine ground scale** — it
needs the drawing's physical resolution too. That is surfaced as an explicit DPI field rather
than assumed.

---

## Delivered

Version **17.0.0**. Test suite **434 → 549, zero failures**, no existing test deleted or
weakened. Without optional dev dependencies 477 run immediately and 72 skip cleanly; with
`jsdom` installed, 535 run.

**New files**

| File | Purpose |
|---|---|
| `lib/importers.js` | DXF, KML/KMZ, GeoJSON and CSV readers. Pure, DOM-free. |
| `lib/geom_edit.js` | Move/rotate/scale, the shift record, RF and scale-bar calibration. Pure, DOM-free. |
| `test/importers.test.js` | 35 tests |
| `test/geom_edit.test.js` | 27 tests |

**Extended in place:** `page_inject.js` (UI, gestures, wiring), `lib/raster_workspace.js`
(`setLocked`, `setDisplayStyle`), `lib/exporters.js` (KML writer reuse, numerical fix),
`background.js` (injection list), `test/requirements.test.js` (+24 traceability assertions),
`test/browser_integration.test.js` (+29 tests driving the new UI in a real DOM).

**Untouched:** `lib/crs.js`, `lib/gcp_math.js`, `lib/tracer.js`, `lib/topology.js`,
`lib/viewport.js`, `lib/history.js`, `lib/site_adapters.js` — the CRS, GCP, tracing,
topology, viewport, history and map-adapter cores are exactly as they were.

### Two arithmetic defects found and fixed while building this

Both were pre-existing, both the same failure mode, and both are the one this project
already has form for — correct on small test coordinates, wrong at the magnitudes the
program actually runs at.

- **`centroidOfRing` was 13 cm out on a rotated plot at Jharkhand UTM values.** The shoelace
  centroid is a ratio of two sums that grow with the square of the coordinate magnitude while
  the answer depends on their difference; the cross products reach ~1.1 × 10¹² for a plot of
  ~1600 m². This surfaced *because* Rotate and Scale turn about the centroid — a pivot 13 cm
  off translates the parcel while claiming only to rotate it. Both centroid implementations
  now accumulate in a local frame; drift under rotation is exactly zero at every angle tested.
- **`signedArea` had the same flaw**, costing ~0.15 ppm on a rotated plot. Far below any
  cadastral tolerance, but noise where double precision should give ~10⁻¹³, and area is this
  program's headline output. Error on a rotated 1600 m² plot went from 2.4 × 10⁻⁴ m² to
  1 × 10⁻⁸ m².

### One test exemption added, with its own guard

`test/requirements.test.js` finds every line that mutates the session and requires a
`commit()` above it. It correctly flagged the two new mutation sites. Both are genuinely
committed — `onPointerMove` by `onPointerDown` (the pre-drag ring is what undo restores, the
same reason the vertex drag is already exempt), and `applyShiftToShape` by each of its three
callers. Both were added to the exemption list, and a **new test (`R17r2`) asserts that every
call site of `applyShiftToShape` has a `commit()` above it**, so the exemption cannot become a
hole if a future caller forgets.

### Not done

Nothing in the brief was skipped. The only deviation is §4's implementation strategy, stated
above and in the README.
