/* Taigan Bridge — tools/canary.js
 *
 * Generates three canary UUIDs and returns them as an HTML comment
 * block ready for injection into the dist file. The UUIDs are not
 * referenced by any runtime code — they exist purely as forensic
 * markers to identify unauthorized copies.
 *
 * Each build gets fresh UUIDs. If a copy of the dist file shows up
 * in the wild, the embedded canary identifies which build it came
 * from (and therefore which release channel it leaked through).
 */

const crypto = require('crypto');

function uuid() {
  // Prefer the runtime's own UUID generator when available.
  if (crypto.randomUUID) return crypto.randomUUID();
  const buf = crypto.randomBytes(16);
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const hex = buf.toString('hex');
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20, 32),
  ].join('-');
}

function commentBlock() {
  const ids = [uuid(), uuid(), uuid()];
  return [
    '<!--',
    '  Taigan Bridge — embedded build identifiers.',
    '  Removal or alteration of these markers does not grant rights',
    '  under the LICENSE and may constitute evidence of willful',
    '  infringement (see LICENSE.md, "Forensic notice").',
    '  c1: ' + ids[0],
    '  c2: ' + ids[1],
    '  c3: ' + ids[2],
    '-->',
  ].join('\n');
}

module.exports = { uuid, commentBlock };
