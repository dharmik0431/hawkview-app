# Frontend site identity

Login and signed-in pages display `Version <phase>.<PR number>`, for example `Version 1.296`. The UI shows only this plain release label, with no expandable details, source hash, or build time. Unstamped work displays `Version 1.local`; invalid release metadata displays `Version unavailable`. The label identifies the frontend release PR, independently of the API revision. Technical source identity remains internal to the build tooling and is not displayed in the UI. A push does not update the live site until that frontend is compiled and published. The user-confirmed GAS production publisher is `https://hawkview-app.ai.studio`; its public status must not be inferred from which Next compilation phase it uses.

`next.config.js` generates immutable metadata during `next build`, including direct invocation without npm lifecycle scripts. Next embeds the same literal into server and browser bundles. `next start` and standalone startup do not scan source or generate another identity. No Git checkout or backend request is needed, including Google AI Studio builds without `.git`. The public release label is tracked separately from this generated technical identity.

Next reloads configuration in separate build workers. The initial build process puts validated metadata in the internal `__HAWKVIEW_FRONTEND_BUILD_CONTEXT` environment entry, inherited by its workers. Each worker verifies the same source root and fingerprint and reuses the original time. Do not configure this internal entry in hosting or shell settings; start each production build as a fresh process. Malformed contexts or source changes during a build fail rather than create inconsistent server/client identities. This context is not hashed or exported; only the three technical identity fields are compiled when the identity module is consumed. Server startup neither reads nor replaces it.

The fingerprint covers sorted relative paths and actual bytes under `app`, `components`, `lib`, `types`, and `public`, plus `package.json`, `package-lock.json`, `next.config.js`, `tsconfig.json`, `tailwind.config.ts`, `postcss.config.js`, and the generator. All ordinary nonprivate files under `public` are included, including PDF/video/text and future asset formats. Other roots use the explicit source/asset extension list in `scripts/frontend-build-identity.cjs`; tests with those extensions are included consistently. Changing these inputs changes the fingerprint, including uncommitted edits in a hosted editor. Missing required inputs or symlinks in included paths fail the production build.

Hidden paths and names containing private/secret/credential segments are excluded before traversal; build outputs, backend files, environment files, Git data, node_modules, reports and personal documents outside the explicit inputs are excluded. File and directory symlinks in candidate inputs are rejected rather than followed. No environment values or credentials are hashed or displayed. The manifest is deliberately bounded, not a scan of the whole repository. New build-input directories, config filenames or non-public asset extensions must be added explicitly when introduced.

For internal source verification, compute the fingerprint of a reviewed export with this read-only command from the checkout:

```sh
node scripts/frontend-build-identity.cjs
```

Compare full technical hashes from the exact source exports or build artifacts under review. The visible release label does not expose a hash or prove that two source snapshots match. Use the exact exported source/lockfile/configuration bytes consumed by the frontend publisher. Source transformations during export can legitimately change the hash. Internal production metadata includes UTC build time to distinguish rebuilding the same source; that time records building, not when hosting published it. Republishing the same prebuilt artifact keeps its identity. An old browser tab correctly retains its old identity until it loads a newer build.

For Next's development compilation path, the internal technical identity is a timestamp-free source fingerprint. A webpack runtime value embeds the deterministic fingerprint in the identity module. Explicit file and directory dependencies plus a hash cache version invalidate it for included source edits and new/deleted assets. When the technical identity module is consumed, normal HMR or Next's full reload delivers the updated identity with compiled code; this metadata has no build time. The plain release label is read separately from tracked release metadata. This also works when a publisher uses that compilation path for a public site. It does not infer the publisher's commands from its hostname. Legacy development metadata is still parsed for compatibility; newly compiled source uses `kind: source`.

Invalid or missing technical metadata does not affect the plain release label, which depends only on tracked release metadata. Production identity generation itself fails rather than silently minting a fallback. No Git SHA is exposed, avoiding misleading provenance for dirty or Gitless builds. Disconnected old tabs retain their loaded version until they receive newer compiled code. Keep input files stable while a compilation runs; the internal fingerprint does not certify an atomic snapshot of concurrently edited source. Development support here uses the repository's standard webpack Next path, not an untested alternate compiler.

The internal technical identity is a source-build identity, not a cryptographic digest of every compiled byte, runtime configuration attestation, deployment counter, or proof that the API matches. Runtime settings, Node/platform/compiler differences, external content and API deployments may change behavior independently. Google AI Studio publication remains separate; local build tests alone do not prove the displayed identity is live.

## Stamping a release

`lib/config/frontend-release.json` tracks the human release label with `phase` (a positive integer) and `pullRequest` (a positive integer or `null`). Keep phase 1 until a phase change is explicitly agreed. The JSON is already covered by the source fingerprint. `null` means local, unstamped work; it never guesses a future PR number.

Create the draft PR first, obtain its actual assigned number, then run the following with that number (296 is only an example):

```sh
node scripts/frontend-release.cjs stamp 296
HAWKVIEW_PULL_REQUEST_NUMBER=296 node scripts/frontend-release.cjs check
```

Commit the resulting JSON change to the same PR. Every PR targeting main must stamp its own actual number, including documentation and backend changes. The existing frontend quality gate checks exact equality with GitHub's PR event number before installing dependencies. Null, malformed, and stale values fail. Manual workflow dispatch skips this PR-specific check because it has no PR event. The check never writes files, creates commits, or calls GitHub; stamping is an explicit local action, so there is no automatic commit loop. A later PR changing only unrelated files must still update the release JSON. Branch protection must require the quality gate to prevent bypass by direct pushes.

Multiple pushes to the same PR keep the same public label. The technical source fingerprint distinguishes included frontend source revisions; the label is the integrating PR identifier, not a per-push counter. The label changes on the live GAS site only after the updated frontend is compiled and published. It does not identify the independently deployed API. New work copied from a previous release can retain that previous label until deliberately reset to null or stamped; the PR guard prevents merging it with the old PR number.
