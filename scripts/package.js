#!/usr/bin/env node
/* =========================================================================
 * Build the Chrome Web Store upload.
 *
 *   npm run package   ->   dist/cadastral-digitizer-<version>.zip
 *
 * WHAT GOES IN IS DERIVED, NOT LISTED
 *
 * The file list is read from the extension's own declarations — the manifest's
 * service worker, popup and icons; background.js's MAIN_WORLD_FILES; the popup's
 * own <script src>. Nothing here restates them.
 *
 * That matters because a hand-written list is exactly what goes stale: add a
 * library to lib/ and a literal list silently ships an extension missing a file,
 * which Chrome accepts and then fails at runtime, in the store, for everyone.
 * The E2E suite already reads MAIN_WORLD_FILES for the same reason. If a
 * declaration and this script ever disagree, the script fails rather than
 * quietly shipping the difference.
 *
 * WHAT STAYS OUT
 *
 * node_modules, test/, .github/, scripts/, dist/ and the working documents. A
 * store package containing tests and CI config is not rejected outright, but it
 * inflates the download for every user and puts the project's whole history in
 * front of a reviewer who asked for an extension. The exclusion is asserted
 * rather than assumed: anything not derived from a declaration is refused.
 *
 * NO DEPENDENCIES, AND NO SECOND ZIP WRITER
 *
 * The archive is written with the project's own makeZipBytes — the one already
 * used for KMZ and Shapefile export, already tested by parsing its bytes back
 * and by handing them to the system `unzip`. Shelling out to `zip` would work
 * here and not on the Windows machines this is developed on; a second writer
 * would be one more thing to keep correct. The result is then read back with
 * the project's own ZIP reader as a final check, so a package that cannot be
 * opened is never handed over as if it could.
 * ========================================================================= */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const Exp = require(path.join(ROOT, 'lib', 'exporters.js'));
const Imp = require(path.join(ROOT, 'lib', 'importers.js'));

const read = (rel) => fs.readFileSync(path.join(ROOT, rel));
const readText = (rel) => read(rel).toString('utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/* Never shippable, whatever a declaration might say. */
const FORBIDDEN = [/^node_modules\//, /^test\//, /^\.github\//, /^scripts\//,
  /^dist\//, /^\.git\//, /\.md$/i, /\.txt$/i, /^package(-lock)?\.json$/];

function fail(message) {
  console.error(`\n  package: ${message}\n`);
  process.exit(1);
}

/* ---- Work out what the extension is actually made of ------------------- */
function collect() {
  const files = new Set();
  const why = new Map();
  const add = (rel, reason) => {
    const clean = String(rel).replace(/^\.?\//, '');
    if (!files.has(clean)) why.set(clean, reason);
    files.add(clean);
  };

  const manifest = JSON.parse(readText('manifest.json'));
  add('manifest.json', 'the manifest itself');

  if (manifest.background && manifest.background.service_worker) {
    add(manifest.background.service_worker, 'manifest.background.service_worker');
  }
  if (manifest.action && manifest.action.default_popup) {
    add(manifest.action.default_popup, 'manifest.action.default_popup');
  }
  for (const [size, icon] of Object.entries(manifest.icons || {})) {
    add(icon, `manifest.icons["${size}"]`);
  }

  // Every list of files background.js declares for injection. Matched by the
  // *_FILES naming convention rather than by name, so a list added later —
  // PDFJS_FILES was — ships without anyone having to remember this script.
  const bg = readText(manifest.background.service_worker);
  const lists = [...bg.matchAll(/(\w*_?FILES)\s*=\s*\[([^\]]*)\]/g)];
  if (!lists.length) fail('background.js declares no *_FILES list — this script reads those to know what to ship.');
  let named = 0;
  for (const [, listName, body] of lists) {
    for (const m of body.matchAll(/'([^']+)'/g)) { add(m[1], `background.js ${listName}`); named++; }
  }
  if (!named) fail('background.js declares file lists but none name any files.');

  // Any other file the worker injects by name, e.g. the isolated-world bridge.
  for (const m of bg.matchAll(/files:\s*\[\s*'([^']+)'\s*\]/g)) {
    add(m[1], 'injected by background.js');
  }

  // Whatever the popup loads.
  if (manifest.action && manifest.action.default_popup) {
    const html = readText(manifest.action.default_popup);
    for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
      add(m[1], `<script src> in ${manifest.action.default_popup}`);
    }
  }

  // The licence ships with the code it licenses.
  if (exists('LICENSE')) add('LICENSE', 'the MIT licence this is released under');

  return { manifest, files: [...files].sort(), why };
}

/* ---- Build ------------------------------------------------------------- */
function main() {
  const { manifest, files, why } = collect();

  const missing = files.filter((f) => !exists(f));
  if (missing.length) {
    fail(`declared but not present: ${missing.join(', ')}\n`
      + '  Something references a file that is not in the tree; shipping this would '
      + 'produce an extension that installs and then fails at runtime.');
  }

  for (const f of files) {
    // LICENSE has no extension and is deliberately allowed; everything else is
    // checked against the exclusion list so no working file can ride along.
    if (f === 'LICENSE') continue;
    const bad = FORBIDDEN.find((re) => re.test(f));
    if (bad) fail(`${f} matched an exclusion (${bad}) but something declared it. Refusing to ship it.`);
  }

  // A store build must not request standing host access; the whole permission
  // story of this extension is activeTab plus scripting.
  if (manifest.host_permissions) {
    fail('manifest.json requests host_permissions. This extension grants itself access '
      + 'per-tab through activeTab, and shipping standing host access would be a different '
      + 'product from the one described in the store listing.');
  }

  const entries = files.map((name) => ({ name, data: new Uint8Array(read(name)) }));
  const bytes = Exp.makeZipBytes(entries);

  const outDir = path.join(ROOT, 'dist');
  fs.mkdirSync(outDir, { recursive: true });
  const outName = `cadastral-digitizer-${manifest.version}.zip`;
  const outPath = path.join(outDir, outName);
  fs.writeFileSync(outPath, Buffer.from(bytes));

  /* ---- Read it back, so a broken archive is never handed over ---------- */
  const back = Imp.readZipEntries(new Uint8Array(fs.readFileSync(outPath)));
  if (!back.ok) fail(`the archive was written but cannot be read back: ${back.error}`);
  const gotNames = back.entries.map((e) => e.name).sort();
  const wantNames = files.slice().sort();
  if (JSON.stringify(gotNames) !== JSON.stringify(wantNames)) {
    fail(`the archive does not contain what was intended.\n  wrote: ${wantNames.join(', ')}\n  read back: ${gotNames.join(', ')}`);
  }
  // manifest.json must sit at the ROOT of the zip, or Chrome rejects the upload.
  if (!gotNames.includes('manifest.json')) {
    fail('manifest.json is not at the root of the archive; the Web Store will reject it.');
  }

  /* ---- Report ---------------------------------------------------------- */
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  const width = Math.max(...files.map((f) => f.length));
  console.log(`\n  ${manifest.name} ${manifest.version}\n`);
  for (const f of files) {
    const size = fs.statSync(path.join(ROOT, f)).size;
    console.log(`    ${f.padEnd(width)}  ${kb(size).padStart(9)}   ${why.get(f)}`);
  }
  console.log(`\n  ${files.length} files -> dist/${outName}  (${kb(bytes.length)})`);
  console.log('  Verified: every declared file present, nothing excluded rode along,');
  console.log('  archive reads back with manifest.json at its root.\n');
  console.log('  Upload at https://chrome.google.com/webstore/devconsole\n');
}

main();
