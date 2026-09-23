# Frontend site identity

Login and signed-in pages display `Site <12-character source fingerprint>`. Open its details for the full SHA-256 and UTC build time. This identifies the frontend source compiled into the loaded site, independently of the API revision. A push does not update the live site until that frontend is built and published.

`next.config.js` generates immutable metadata during `next build`, including direct invocation without npm lifecycle scripts. Next embeds the same literal into server and browser bundles. `next start` and standalone startup do not scan source or generate another identity. No Git checkout, backend request or manually incremented version is needed, including Google AI Studio builds without `.git`.

Next reloads configuration in separate build workers. The initial build process puts validated metadata in the internal `__HAWKVIEW_FRONTEND_BUILD_CONTEXT` environment entry, inherited by its workers. Each worker verifies the same source root and fingerprint and reuses the original time. Do not configure this internal entry in hosting or shell settings; start each production build as a fresh process. Malformed contexts or source changes during a build fail rather than create inconsistent server/client identities. This context is not hashed or exported; only the three public identity fields are compiled. Server startup neither reads nor replaces it.

The fingerprint covers sorted relative paths and actual bytes under `app`, `components`, `lib`, `types`, and `public`, plus `package.json`, `package-lock.json`, `next.config.js`, `tsconfig.json`, `tailwind.config.ts`, `postcss.config.js`, and the generator. All ordinary nonprivate files under `public` are included, including PDF/video/text and future asset formats. Other roots use the explicit source/asset extension list in `scripts/frontend-build-identity.cjs`; tests with those extensions are included consistently. Changing these inputs changes the fingerprint, including uncommitted edits in a hosted editor. Missing required inputs or symlinks in included paths fail the production build.

Hidden paths and names containing private/secret/credential segments are excluded before traversal; build outputs, backend files, environment files, Git data, node_modules, reports and personal documents outside the explicit inputs are excluded. File and directory symlinks in candidate inputs are rejected rather than followed. No environment values or credentials are hashed or displayed. The manifest is deliberately bounded, not a scan of the whole repository. New build-input directories, config filenames or non-public asset extensions must be added explicitly when introduced.

To compare a reviewed source export with the visible site, run this read-only command from the checkout:

```sh
node scripts/frontend-build-identity.cjs
```

Compare the full hash, not only the short display. Use the exact exported source/lockfile/configuration bytes consumed by the frontend publisher. Source transformations during export can legitimately change the hash. Compare the UTC build time to distinguish rebuilding the same source; that time records building, not when hosting published it. Republishing the same prebuilt artifact keeps its identity. An old browser tab correctly retains its old identity until it loads a newer build.

Development displays `Development`; it does not claim a startup hash remains accurate through hot reload. Invalid or missing compiled metadata displays `Version unavailable`; production generation itself fails rather than silently minting a fallback. No Git SHA is exposed in v1, avoiding misleading provenance for dirty or Gitless builds.

This is a source-build identity, not a cryptographic digest of every compiled byte, runtime configuration attestation, deployment counter, or proof that the API matches. Runtime settings, Node/platform/compiler differences, external content and API deployments may change behavior independently. Google AI Studio publication remains separate; local build tests alone do not prove the displayed identity is live.
