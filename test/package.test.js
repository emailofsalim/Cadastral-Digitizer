/* =========================================================================
 * The Chrome Web Store package.
 *
 * The failure this exists to prevent: add a library to lib/, forget to ship it,
 * and Chrome accepts the upload — then every user gets an extension that
 * installs cleanly and dies on first use, in the store, where fixing it costs a
 * review cycle. `npm run package` derives its file list from the extension's own
 * declarations precisely so that cannot happen, and this asserts it actually
 * does by building a real archive and reading it back.
 * ========================================================================= */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const Imp = require('../lib/importers.js');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const PKG = JSON.parse(read('package.json'));
const MANIFEST = JSON.parse(read('manifest.json'));

/* Built once and shared: the script is fast, but running it per test would
 * write the same archive five times over. */
let built = null;
function build() {
  if (built) return built;
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'package.js')],
    { cwd: ROOT, stdio: 'pipe' });
  const zipPath = path.join(ROOT, 'dist', `cadastral-digitizer-${MANIFEST.version}.zip`);
  assert.ok(fs.existsSync(zipPath), `the package should be written to ${zipPath}`);
  const parsed = Imp.readZipEntries(new Uint8Array(fs.readFileSync(zipPath)));
  assert.strictEqual(parsed.ok, true, 'the archive must be readable');
  built = { zipPath, names: parsed.entries.map((e) => e.name), bytes: fs.statSync(zipPath).size };
  return built;
}

test('there is a package script', () => {
  assert.strictEqual(PKG.scripts.package, 'node scripts/package.js');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'package.js')));
});

test('the package contains every file the extension declares', () => {
  const { names } = build();

  // The page-world payload, read from background.js exactly as the extension
  // itself reads it — so adding a library cannot be forgotten here.
  const bg = read('background.js');
  const injected = [...bg.match(/MAIN_WORLD_FILES\s*=\s*\[([^\]]*)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(injected.length >= 10, 'sanity: the injected list should be substantial');
  for (const f of injected) {
    assert.ok(names.includes(f), `${f} is injected at runtime but missing from the package`);
  }

  // Everything else the manifest and popup point at.
  assert.ok(names.includes('manifest.json'), 'the Web Store requires manifest.json at the archive root');
  assert.ok(names.includes(MANIFEST.background.service_worker));
  assert.ok(names.includes(MANIFEST.action.default_popup));
  for (const icon of Object.values(MANIFEST.icons)) {
    assert.ok(names.includes(icon), `icon ${icon} must ship`);
  }
  assert.ok(names.includes('content.js'), 'the isolated-world bridge must ship');
  assert.ok(names.includes('popup.js'), "the popup's own script must ship");
});

test('the package carries nothing a user should not be downloading', () => {
  const { names } = build();
  for (const n of names) {
    assert.ok(!/^node_modules\//.test(n), `${n} must not ship`);
    assert.ok(!/^test\//.test(n), `${n} must not ship`);
    assert.ok(!/^\.github\//.test(n), `${n} must not ship`);
    assert.ok(!/^scripts\//.test(n), `${n} must not ship`);
    assert.ok(!/^dist\//.test(n), 'the package must not contain itself');
    assert.ok(!/\.test\.js$/.test(n), `${n} must not ship`);
    // The licence is the one extension-less file that belongs.
    assert.ok(n === 'LICENSE' || /\.(js|json|html|png)$/.test(n),
      `${n} is not a file this extension needs`);
  }
  assert.ok(!names.some((n) => /^README|\.md$/i.test(n)),
    'working documents are not part of the product');
});

test('the packaged manifest asks for no standing host access', () => {
  // The whole permission story is activeTab plus scripting. A store build that
  // quietly requested host_permissions would be a different product from the
  // one the listing describes.
  const { names } = build();
  assert.ok(names.includes('manifest.json'));
  assert.strictEqual(MANIFEST.host_permissions, undefined);
  assert.deepStrictEqual(MANIFEST.permissions.slice().sort(), ['activeTab', 'scripting']);
});

test('the package is named for the version it contains, and is a sane size', () => {
  const { zipPath, bytes } = build();
  assert.match(path.basename(zipPath), new RegExp(`${MANIFEST.version.replace(/\./g, '\\.')}\\.zip$`));
  // Chrome's limit is far above this; the point is catching a package that has
  // swallowed node_modules, which would be tens of megabytes.
  assert.ok(bytes > 50 * 1024, `suspiciously small package: ${bytes} bytes`);
  assert.ok(bytes < 5 * 1024 * 1024, `package is ${(bytes / 1048576).toFixed(1)} MB — something unwanted got in`);
});
