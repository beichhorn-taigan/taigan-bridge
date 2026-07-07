# Build & Distribution

## Development

```bash
npm install
npm run dev      # serves src/ on http://localhost:4747 with no caching
```

Edit any file under `src/`. Refresh the browser. Files are loaded
individually via relative `<link>` and `<script>` tags so source maps
and errors point to the actual file you edited.

## Production build

```bash
npm run build    # produces dist/taigan-bridge.html
```

`build.js` performs the following passes:

1. Reads `src/index.html`.
2. Inlines every `<link rel="stylesheet" href="...">` whose URL is
   relative — replaces the tag with a `<style>` block carrying a
   `data-source` attribute pointing to the original path.
3. Inlines every `<script src="...">` whose URL is relative — same
   treatment, with a `data-source` attribute.
4. Inlines `<img src="*.svg">` references as `data:image/svg+xml`
   URLs so the file has zero external dependencies after build
   (Google Fonts is the only remaining network reference, and is
   loaded via CSS `@import` from `tokens.css`).
5. Generates an 8-character build hash (`<base36 timestamp> +
   <random hex>`) and stamps it into:
   - `<meta name="tb-build-hash">`
   - any element with `data-build-hash`
6. Stamps the build date and version in the same way.
7. Embeds three random canary UUIDs as an HTML comment block (see
   `tools/canary.js`) immediately after `<html>`.
8. Embeds the full `LICENSE.md` text as an HTML comment at the very
   top of the file.
9. Writes the result to `dist/taigan-bridge.html` and prints the
   build hash, file size, and output path.

## Production obfuscation (deferred post-launch)

Obfuscation remains a non-goal post-v1.0.3. The production distribution
*could* run the inlined `<script>` blocks through `javascript-obfuscator`
using `tools/obfuscate.config.js` — the hook exists in `build.js` as a
TODO — but the cost/benefit doesn't justify the added build complexity
until demand warrants it. The intended sequence (if implemented) would be:

1. Extract each `<script data-source="...">` block.
2. Run its contents through `javascript-obfuscator` with the
   shared config.
3. Re-insert the obfuscated source.
4. Leave HTML and CSS untouched (the obfuscator targets JS only).

Source maps are disabled. The obfuscation pipeline is a "raise the
cost of forking" measure, not a security boundary — client-side code
is never copy-proof. We aim for **copy-evident**: build hashes plus
canary UUIDs make unauthorized redistributions traceable.

## Distribution channel

- **GitHub Releases**: The dist build is attached to each Git release
  tag as a single HTML file (`taigan-bridge-v1.0.3.html`).
- **Hosted demo**: Fresh build is published to `taiganjp.com/tools/taigan-bridge/`
  with analytics injection (GoatCounter) to track active users.
- Build hash: Each release embeds a fresh `BUILD_HASH` in version.json
  and version.js so users can verify authenticity if distributing copies.
- Each new release bumps `version` in `package.json` and adds an
  entry to `CHANGELOG.md` before a build.

## Pre-release checklist

- [ ] `package.json` version bumped.
- [ ] `CHANGELOG.md` entry added.
- [ ] `npm run build` succeeds with no warnings.
- [ ] `dist/taigan-bridge.html` opens directly from the filesystem
      (`file://...`) and the onboarding wizard runs end-to-end.
- [ ] Build hash appears in the footer and About modal.
- [ ] License comment appears at the top of the dist file.
- [ ] Canary UUIDs are present (search for `c1:` in the dist file).
