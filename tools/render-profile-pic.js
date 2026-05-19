/* tools/render-profile-pic.js
 *
 * One-shot Node script that reads the two profile-pic SVGs from
 * src/assets/ and writes PNGs at 400/800/1200 px into
 * dist/profile-pics/. Run via:
 *
 *   npm install sharp --no-save && node tools/render-profile-pic.js
 *
 * No new entry in package.json — sharp is a one-time install for
 * generating the launch-day profile pics. Re-run only if the SVG
 * source changes.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SRC = path.join(__dirname, '..', 'src', 'assets');
const OUT = path.join(__dirname, '..', 'dist', 'profile-pics');
const SIZES = [400, 800, 1200];

const VARIANTS = [
  { svg: 'profile-pic.svg',    prefix: 'taigan-mark' },
  { svg: 'profile-pic-jp.svg', prefix: 'taigan' },
];

async function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  for (const v of VARIANTS) {
    const svgPath = path.join(SRC, v.svg);
    if (!fs.existsSync(svgPath)) {
      console.warn('[skip] missing:', svgPath);
      continue;
    }
    const svgBuf = fs.readFileSync(svgPath);
    for (const size of SIZES) {
      // Base pipeline — render SVG at the requested size with the
      // navy background fill. Compose against a solid sRGB
      // background so the output has no alpha channel and no
      // embedded ICC profile (some upload validators — BMaC in
      // particular — choke on alpha + profiled PNGs even though
      // they're standards-compliant).
      const base = sharp(svgBuf, { density: 300 })
        .resize(size, size, { fit: 'contain', background: '#0E2A4F' })
        .flatten({ background: '#0E2A4F' })  // drop alpha
        .toColorspace('srgb')                 // force sRGB
        .withMetadata({ icc: undefined });    // strip embedded ICC

      // PNG — bit-clean, no profile, no metadata
      const pngPath = path.join(OUT, `${v.prefix}-${size}.png`);
      await base.clone().png({ compressionLevel: 9, palette: false }).toFile(pngPath);

      // JPG — universally accepted by every upload validator
      const jpgPath = path.join(OUT, `${v.prefix}-${size}.jpg`);
      await base.clone().jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toFile(jpgPath);

      const pngKB = (fs.statSync(pngPath).size / 1024).toFixed(1);
      const jpgKB = (fs.statSync(jpgPath).size / 1024).toFixed(1);
      console.log(`  ${v.prefix}-${size}.png  (${pngKB} KB) · .jpg (${jpgKB} KB)`);
    }
  }
  console.log('\nDone →', OUT);
}

main().catch((err) => { console.error(err); process.exit(1); });
