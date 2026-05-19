/* tools/package-for-friends.js
 *
 * Produces a friend-ready distribution bundle at:
 *   dist/taigan-bridge-vX.Y.Z/
 *     ├── taigan-bridge-vX.Y.Z.html   (renamed from dist/taigan-bridge.html
 *     │                                so versions don't collide if a
 *     │                                friend has an old one in Downloads)
 *     ├── README.txt                  (plain-text quick start for non-devs)
 *     └── LICENSE.md                  (the license, as required by
 *                                      redistribution terms)
 *
 * Run:    node tools/package-for-friends.js
 * Then:   upload the folder (or zip it via right-click → "Send to →
 *         Compressed folder" on Windows) and share the link.
 *
 * No new dependencies — pure fs.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PKG = require(path.join(ROOT, 'package.json'));
const VERSION = PKG.version;
const SRC_HTML = path.join(ROOT, 'dist', 'taigan-bridge.html');
const SRC_LICENSE = path.join(ROOT, 'LICENSE.md');
const OUT_DIR = path.join(ROOT, 'dist', `taigan-bridge-v${VERSION}`);
const OUT_HTML = path.join(OUT_DIR, `taigan-bridge-v${VERSION}.html`);
const OUT_LICENSE = path.join(OUT_DIR, 'LICENSE.md');
const OUT_README = path.join(OUT_DIR, 'README.txt');

if (!fs.existsSync(SRC_HTML)) {
  console.error('Build the dist file first: npm run build');
  process.exit(1);
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// 1. Copy the versioned HTML
fs.copyFileSync(SRC_HTML, OUT_HTML);

// 2. Copy LICENSE
if (fs.existsSync(SRC_LICENSE)) {
  fs.copyFileSync(SRC_LICENSE, OUT_LICENSE);
}

// 3. Generate a plain-text README aimed at a non-developer friend
//    who's never seen Taigan Bridge. Keep it short and concrete —
//    they want to know what the file is, how to open it, and what's
//    safe vs. not.
const README = `Taigan Bridge v${VERSION}

A free, single-file financial planning organizer for Americans
living in Japan. FBAR, US + JP taxes, retirement, estate, healthcare,
dual-citizenship — all bilingual, all running locally in your browser.


HOW TO OPEN
-----------
1. Save the file "taigan-bridge-v${VERSION}.html" somewhere you'll
   remember (Documents, Downloads, a folder of its own).
2. Double-click the file. It opens in your default browser. That's
   the entire installation — no setup, no signup.
3. (Optional) Bookmark the local file so you can come back to it
   easily. In Chrome / Edge / Firefox the URL will look like
   "file:///C:/Users/..." or "file:///Users/...".


HOW TO EVALUATE WITHOUT ENTERING YOUR REAL DATA
-----------------------------------------------
On the welcome screen, click "Try with sample data" and pick one
of the four fictional households. You can switch between them or
exit demo mode any time from Settings.


PRIVACY
-------
- Everything runs in your browser.
- Your data lives in your browser's local storage, on YOUR machine.
- The author has no analytics, no telemetry, no tracking.
- Nothing is sent anywhere unless you explicitly use an AI feature
  (and even then, the optional AI features use YOUR Claude API key
  going directly from your browser to Anthropic — the author has
  no visibility).
- You can export a JSON backup at any time (Settings → Backup) and
  delete everything with one click.


WHAT IT'S NOT
-------------
Not financial advice. Not tax advice. Not legal advice. Not medical
advice. Use it to organize your thinking, then talk to qualified
professionals before acting on anything.


FEEDBACK
--------
Use the "Send feedback" link in the app footer, or email
benjamin.eichhorn@gmail.com directly. Bug reports, suggestions,
"this feature would be useful" — all welcome.


LICENSE
-------
Free for personal, non-commercial use. See LICENSE.md for full terms.


Thanks for trying it.

— Ben
`;
fs.writeFileSync(OUT_README, README);

// 4. Report
const htmlKb = (fs.statSync(OUT_HTML).size / 1024).toFixed(1);
const totalFiles = fs.readdirSync(OUT_DIR).length;
console.log('Friend-ready bundle:');
console.log('  ' + path.relative(ROOT, OUT_DIR));
fs.readdirSync(OUT_DIR).forEach((f) => {
  const kb = (fs.statSync(path.join(OUT_DIR, f)).size / 1024).toFixed(1);
  console.log('    ' + f + '  (' + kb + ' KB)');
});
console.log('\nNext: zip this folder (right-click → Send to → Compressed folder on Windows)');
console.log('      or upload the folder contents to Google Drive and share the link.');
