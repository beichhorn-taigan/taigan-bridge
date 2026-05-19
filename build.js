#!/usr/bin/env node
/*
 * Taigan Bridge — build.js
 *
 * Reads src/index.html, inlines every <link rel="stylesheet"> and
 * <script src="..."> reference, embeds build metadata (version, build
 * hash, build date, canary UUIDs), and writes the result to
 * dist/taigan-bridge.html as a single self-contained file.
 *
 * Usage: node build.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, 'src');
const SRC_HTML = path.join(SRC_DIR, 'index.html');
const DIST_DIR = path.join(ROOT, 'dist');
const DIST_HTML = path.join(DIST_DIR, 'taigan-bridge.html');
const PKG = require(path.join(ROOT, 'package.json'));
const canary = require(path.join(ROOT, 'tools', 'canary.js'));

function buildHash() {
  const stamp = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return (stamp + rand).slice(-8);
}

function readLicenseComment() {
  const licensePath = path.join(ROOT, 'LICENSE.md');
  if (!fs.existsSync(licensePath)) return '';
  const text = fs.readFileSync(licensePath, 'utf8').trim();
  return `<!--\nTaigan Bridge — License\n\n${text}\n-->\n`;
}

function inlineStylesheets(html) {
  return html.replace(
    /<link\s+[^>]*rel=["']stylesheet["'][^>]*>/gi,
    (tag) => {
      const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
      if (!hrefMatch) return tag;
      const href = hrefMatch[1];
      if (/^https?:\/\//i.test(href)) return tag;
      const filePath = path.join(SRC_DIR, href);
      if (!fs.existsSync(filePath)) {
        console.warn(`  [warn] stylesheet not found, skipping: ${href}`);
        return tag;
      }
      const css = fs.readFileSync(filePath, 'utf8');
      return `<style data-source="${href}">\n${css}\n</style>`;
    },
  );
}

function inlineScripts(html) {
  return html.replace(
    /<script\s+[^>]*src=["']([^"']+)["'][^>]*><\/script>/gi,
    (tag, src) => {
      if (/^https?:\/\//i.test(src)) return tag;
      const filePath = path.join(SRC_DIR, src);
      if (!fs.existsSync(filePath)) {
        console.warn(`  [warn] script not found, skipping: ${src}`);
        return tag;
      }
      let js = fs.readFileSync(filePath, 'utf8');
      // Defense against the nested-script gotcha: any literal
      // </script> inside JS string content (template literals, etc.)
      // would terminate the surrounding inlined <script> block early
      // and break execution. Escape every closing tag so the HTML
      // parser doesn't see it; the runtime JS treats <\/script> as
      // </script> identically.
      const escaped = js.replace(/<\/script\b/gi, '<\\/script');
      if (escaped !== js) {
        const count = (js.match(/<\/script\b/gi) || []).length;
        console.log(`  [escape] auto-escaped ${count} literal </script> in ${src}`);
        js = escaped;
      }
      return `<script data-source="${src}">\n${js}\n</script>`;
    },
  );
}

function inlineSvgAssets(html) {
  // Inline <img src="assets/*.svg"> tags so the dist file has zero
  // file dependencies. Leaves remote URLs and non-svg images alone.
  let out = html.replace(
    /<img\s+([^>]*?)src=["']([^"']+\.svg)["']([^>]*)>/gi,
    (tag, before, src, after) => {
      if (/^https?:\/\//i.test(src) || src.startsWith('data:')) return tag;
      const filePath = path.join(SRC_DIR, src);
      if (!fs.existsSync(filePath)) return tag;
      const svg = fs.readFileSync(filePath, 'utf8');
      const b64 = Buffer.from(svg).toString('base64');
      return `<img ${before}src="data:image/svg+xml;base64,${b64}"${after}>`;
    },
  );
  // Inline <link rel="icon" href="...svg"> for the favicon.
  out = out.replace(
    /<link\s+([^>]*?)href=["']([^"']+\.svg)["']([^>]*)>/gi,
    (tag, before, src, after) => {
      if (!/rel=["'][^"']*icon[^"']*["']/i.test(tag)) return tag;
      if (/^https?:\/\//i.test(src) || src.startsWith('data:')) return tag;
      const filePath = path.join(SRC_DIR, src);
      if (!fs.existsSync(filePath)) return tag;
      const svg = fs.readFileSync(filePath, 'utf8');
      const b64 = Buffer.from(svg).toString('base64');
      return `<link ${before}href="data:image/svg+xml;base64,${b64}"${after}>`;
    },
  );
  return out;
}

function stampMetadata(html, meta) {
  let out = html;
  out = out.replace(/<meta\s+name=["']tb-version["'][^>]*>/i,
    `<meta name="tb-version" content="${meta.version}">`);
  out = out.replace(/<meta\s+name=["']tb-build-hash["'][^>]*>/i,
    `<meta name="tb-build-hash" content="${meta.buildHash}">`);
  out = out.replace(/<meta\s+name=["']tb-build-date["'][^>]*>/i,
    `<meta name="tb-build-date" content="${meta.buildDate}">`);

  // Stamp visible elements with data-* attributes.
  out = out.replace(/(<[^>]*\sdata-version[^>]*>)([^<]*)(<\/)/gi,
    (m, open, _inner, close) => `${open}${meta.version}${close}`);
  out = out.replace(/(<[^>]*\sdata-build-hash[^>]*>)([^<]*)(<\/)/gi,
    (m, open, _inner, close) => `${open}${meta.buildHash}${close}`);
  out = out.replace(/(<[^>]*\sdata-build-date[^>]*>)([^<]*)(<\/)/gi,
    (m, open, _inner, close) => `${open}${meta.buildDate}${close}`);
  return out;
}

function injectInlineContent(html) {
  // Inline content files the runtime would otherwise fetch(). The
  // dist file is meant to work from file://, where fetch() of sibling
  // files is blocked.
  //
  // Onboarding questions ride along in src/content/inline.js — that
  // file is already <script src="...">'d in index.html and gets
  // inlined by the regular script-inlining pass. Here we inject:
  //   - About modal copy (content/about.html)
  //   - License text (LICENSE.md, project root)
  //   - Changelog (CHANGELOG.md, project root)
  // All three land at window.TB.content.* so the runtime can reach
  // them synchronously without a fetch.
  const aboutPath = path.join(SRC_DIR, 'content', 'about.html');
  if (!fs.existsSync(aboutPath)) return html;
  const aboutHtml = fs.readFileSync(aboutPath, 'utf8');

  const licensePath = path.join(ROOT, 'LICENSE.md');
  const licenseText = fs.existsSync(licensePath)
    ? fs.readFileSync(licensePath, 'utf8') : '';

  const changelogPath = path.join(ROOT, 'CHANGELOG.md');
  const changelogText = fs.existsSync(changelogPath)
    ? fs.readFileSync(changelogPath, 'utf8') : '';

  // Same nested-script gotcha as inlineScripts() — JSON.stringify
  // produces correct JS string literals, but the HTML parser still
  // closes a <script> block on the literal byte sequence "</script>"
  // (and is similarly nervous about "</style>" / "<!--" sequences).
  // Escape every "</" as "<\/" — JS treats the backslash before
  // a forward slash as a no-op, so the runtime string is identical;
  // the HTML parser, however, no longer sees a closing tag.
  function escapeForScriptInline(text) {
    return JSON.stringify(text).replace(/<\//g, '<\\/');
  }
  const tag =
    '<script data-source="content/about-inline.js">\n' +
    'window.TB = window.TB || {}; ' +
    'window.TB.content = window.TB.content || {}; ' +
    'window.TB.content.aboutHtml = ' + escapeForScriptInline(aboutHtml) + ';\n' +
    'window.TB.content.licenseText = ' + escapeForScriptInline(licenseText) + ';\n' +
    'window.TB.content.changelogText = ' + escapeForScriptInline(changelogText) + ';\n' +
    '</script>';

  // Insert just after the inline.js block so TB.content already
  // exists. If inline.js isn't referenced (shouldn't happen), fall
  // back to inserting before state.js.
  //
  // CRITICAL: pass a callback to .replace() instead of a string,
  // because the inlined content (about/license/changelog) contains
  // dollar-prefixed sequences ($10K, $200, etc.) that String.replace
  // would otherwise interpret as backref patterns — `$10` would
  // expand to "<entire group 1>0" and inject the inline.js block
  // right back into the middle of the changelog string. Function
  // replacements bypass that special-character handling entirely.
  if (/data-source="content\/inline\.js"/i.test(html)) {
    return html.replace(
      /<script\s+data-source="content\/inline\.js"[\s\S]*?<\/script>/i,
      (match) => match + '\n  ' + tag,
    );
  }
  return html.replace(
    /<script\s+data-source="scripts\/state\.js"/i,
    (match) => tag + '\n  ' + match,
  );
}

function injectCanary(html) {
  const block = canary.commentBlock();
  // Insert just after <html ...> or after <!DOCTYPE>.
  return html.replace(
    /(<!DOCTYPE[^>]*>\s*<html[^>]*>)/i,
    (m) => `${m}\n${block}`,
  );
}

function injectLicenseHeader(html) {
  const license = readLicenseComment();
  if (!license) return html;
  return license + html;
}

function pad(n) { return String(n).padStart(2, '0'); }

function isoDate(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function main() {
  if (!fs.existsSync(SRC_HTML)) {
    console.error(`[error] missing source HTML: ${SRC_HTML}`);
    process.exit(1);
  }
  if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });

  const meta = {
    version: PKG.version,
    buildHash: buildHash(),
    buildDate: isoDate(new Date()),
  };

  console.log(`Taigan Bridge build`);
  console.log(`  version    ${meta.version}`);
  console.log(`  buildHash  ${meta.buildHash}`);
  console.log(`  buildDate  ${meta.buildDate}`);

  let html = fs.readFileSync(SRC_HTML, 'utf8');
  html = inlineStylesheets(html);
  html = inlineScripts(html);
  html = inlineSvgAssets(html);
  html = injectInlineContent(html);
  html = stampMetadata(html, meta);
  html = injectCanary(html);
  html = injectLicenseHeader(html);

  // TODO(v0.x): pipe `html` through javascript-obfuscator using the
  // configuration in tools/obfuscate.config.js before writing to disk.
  // The obfuscator should be applied only to <script> blocks (not to
  // the surrounding HTML or CSS) — see docs/BUILD.md for the planned
  // pipeline. For v0.1 we ship a clean, readable build.

  fs.writeFileSync(DIST_HTML, html, 'utf8');
  const bytes = fs.statSync(DIST_HTML).size;
  const kb = (bytes / 1024).toFixed(1);
  console.log(`  output     ${path.relative(ROOT, DIST_HTML)}`);
  console.log(`  size       ${bytes} bytes (${kb} KB)`);
}

main();
