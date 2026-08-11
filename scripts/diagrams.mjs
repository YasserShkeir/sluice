// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Render the architecture diagrams from their HTML sources.
 *
 * The diagrams under `assets/architecture/` are not hand-drawn images: each one
 * is a plain HTML page in `assets/architecture/src/`, laid out for a single A4
 * landscape sheet. This script drives headless Chrome twice over those sources:
 *
 *   1. one screenshot per page  -> assets/architecture/NN-name.png  (2x, 2246x1588)
 *   2. one combined print run   -> assets/architecture/sluice-architecture.pdf
 *
 * Chrome is the only dependency, and it is one everybody working on a browser
 * capture tool already has. Nothing here reaches the network.
 *
 *   node scripts/diagrams.mjs            # png + pdf
 *   node scripts/diagrams.mjs --png      # png only
 *   node scripts/diagrams.mjs --pdf      # pdf only
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC_DIR = join(ROOT, 'assets/architecture/src');
const PNG_DIR = join(ROOT, 'assets/architecture');
// Beside the PNGs rather than in docs/, which is gitignored — the combined sheet
// is the thing you hand someone, so it has to survive a clone.
const PDF_PATH = join(ROOT, 'assets/architecture/sluice-architecture.pdf');

/** A4 landscape at 96dpi. Chrome's print box is the same sheet, so PNG and PDF agree. */
const PAGE_W = 1123;
const PAGE_H = 794;
/** 2x, which lands on 2246x1588 — legible when GitHub scales the image down. */
const SCALE = 2;

/** Chrome, wherever this machine keeps it. */
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const cache = join(homedir(), '.cache/puppeteer/chrome');
  if (existsSync(cache)) {
    for (const build of readdirSync(cache).sort().reverse()) {
      candidates.push(
        join(cache, build, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        join(cache, build, 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        join(cache, build, 'chrome-linux64/chrome'),
      );
    }
  }
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('No Chrome found. Set CHROME_PATH to a Chrome/Chromium binary.');
  return found;
}

const CHROME = findChrome();
const pages = readdirSync(SRC_DIR)
  .filter((f) => /^\d\d-.*\.html$/.test(f))
  .sort();
if (pages.length === 0) throw new Error(`No NN-name.html sources in ${SRC_DIR}`);

/** A throwaway profile keeps the run from touching the user's real Chrome state. */
const profile = mkdtempSync(join(tmpdir(), 'sluice-diagrams-'));

/**
 * Headless Chrome writes the file and then, often enough to matter, declines to
 * exit. Cap it and judge the run by whether the artifact appeared, not by how
 * gracefully the browser left.
 */
function chrome(args, artifact) {
  try {
    execFileSync(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-extensions',
        '--virtual-time-budget=4000',
        `--user-data-dir=${profile}`,
        ...args,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], timeout: 45_000, killSignal: 'SIGKILL' },
    );
  } catch (e) {
    if (!existsSync(artifact)) throw e;
  }
  if (!existsSync(artifact)) throw new Error(`Chrome produced nothing at ${artifact}`);
}

const only = process.argv.slice(2);
const wantPng = only.length === 0 || only.includes('--png');
const wantPdf = only.length === 0 || only.includes('--pdf');

try {
  if (wantPng) {
    for (const page of pages) {
      const out = join(PNG_DIR, `${basename(page, '.html')}.png`);
      rmSync(out, { force: true });
      chrome(
        [
          `--screenshot=${out}`,
          `--window-size=${PAGE_W},${PAGE_H}`,
          `--force-device-scale-factor=${SCALE}`,
          `file://${join(SRC_DIR, page)}`,
        ],
        out,
      );
      console.log(`png  ${out.slice(ROOT.length)}`);
    }
  }

  if (wantPdf) {
    // One sheet per source, in filename order. Each source is a standalone page,
    // so the combined document only needs their bodies plus a page break.
    const css = readFileSync(join(SRC_DIR, 'diagram.css'), 'utf8');
    const bodies = pages.map((p) => {
      const html = readFileSync(join(SRC_DIR, p), 'utf8');
      return html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));
    });
    const combined = join(profile, 'combined.html');
    writeFileSync(
      combined,
      `<!doctype html><meta charset="utf-8"><title>Sluice architecture</title><style>${css}
       /* The shared sheet rules pin body to one 1123x794 page with overflow hidden.
          In the combined document body is the scroll container for five of them. */
       body { width: auto; height: auto; display: block; overflow: visible; padding: 0 }
       @page { size: A4 landscape; margin: 0 }
       .sheet { break-after: page }
       .sheet:last-child { break-after: auto }</style>
       ${bodies.map((b) => `<div class="sheet">${b}</div>`).join('\n')}`,
    );
    // docs/ is gitignored, so a fresh clone has no such directory to write into.
    mkdirSync(dirname(PDF_PATH), { recursive: true });
    rmSync(PDF_PATH, { force: true });
    chrome([`--print-to-pdf=${PDF_PATH}`, '--no-pdf-header-footer', `file://${combined}`], PDF_PATH);
    console.log(`pdf  ${PDF_PATH.slice(ROOT.length)}`);
  }
} finally {
  rmSync(profile, { recursive: true, force: true });
}
