/* Taigan Bridge — tools/obfuscate.config.js
 *
 * Configuration for javascript-obfuscator, used in the production
 * pipeline to make the distributed dist/taigan-bridge.html costly
 * to fork or rebrand. Not yet wired into build.js — see the TODO
 * marker in build.js and docs/BUILD.md for the planned pipeline.
 *
 * Tuned for a balance of size and runtime cost. controlFlowFlattening
 * and deadCodeInjection slow the result down measurably; we cap their
 * thresholds so the user-facing UI stays responsive.
 */

module.exports = {
  compact: true,

  stringArray: true,
  rotateStringArray: true,
  stringArrayEncoding: ['rc4'],
  stringArrayThreshold: 0.85,

  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,

  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,

  splitStrings: true,
  splitStringsChunkLength: 10,

  transformObjectKeys: true,
  unicodeEscapeSequence: false,

  identifierNamesGenerator: 'mangled-shuffled',
  renameGlobals: false,

  selfDefending: true,
  debugProtection: false,
  disableConsoleOutput: false,

  numbersToExpressions: true,
  simplify: true,

  sourceMap: false,
  sourceMapMode: 'separate',
};
