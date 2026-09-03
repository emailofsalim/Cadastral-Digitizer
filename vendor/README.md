# Vendored third-party code

## PDF.js

- Package: pdfjs-dist
- Version: 3.11.174
- Licence: Apache-2.0 (see LICENSE-pdfjs)
- Upstream: https://github.com/mozilla/pdf.js
- Files: build/pdf.min.js, build/pdf.worker.min.js (UMD builds)

Vendored rather than taken from a CDN so PDF rendering works offline and no
remote code is ever executed. The UMD builds are used because they load as
classic scripts, which is what chrome.scripting.executeScript injects.

To update: npm pack pdfjs-dist@<version>, then copy build/pdf.min.js and
build/pdf.worker.min.js here along with the upstream LICENSE.
