# PR #5544: browser evidence for retrying a failed converter import

PR: https://github.com/tscircuit/tscircuit.com/pull/5544

Recorded on 2026-10-23 using the local website, Chromium and the repository's existing `playwright-tests/exampleCircuitJson.ts` fixture. These are unedited Playwright browser recordings. The panel at the bottom is explicitly marked **TEST INSTRUMENTATION** and reports observed resolver calls, download events and page navigations; it is not production UI.

The first `circuit-json-to-kicad` resolver invocation deliberately rejects with `TEST: first converter import intentionally rejected`. On subsequent invocations, it delegates to the real published `circuit-json-to-kicad@0.0.241` converter. The converter and ZIP generation are not mocked. The fixture's two 3D models use small local VRML responses to avoid unrelated model-service failures.

This isolates the website's rejected-promise cache. It is not a recording of a live CDN outage, and does not claim that browser-native module-cache failures or permanent network failures can always recover.

## Recorded results

| After two Download → KiCad → Project clicks | Original loader | Fixed loader |
| --- | --- | --- |
| Resolver/importer calls | 1 | 2 |
| Observed injected rejections | 2 (same cached rejection) | 1 |
| ZIP download events | 0 | 1 |
| Main-frame navigations | 1 (initial visit only) | 1 (initial visit only) |

- [Before recording — 13 seconds](before.webm)
- [After recording — 28 seconds](after.webm)
- [Before screenshot](before.png) / [after screenshot](after.png)
- [Before observations](before-observations.json) / [after observations](after-observations.json)
- [Downloaded ZIP](my-test-board_kicad.zip)

The successful run received HTTP 200 from `https://jscdn.tscircuit.com/circuit-json-to-kicad/0.0.241/+esm`. The downloaded ZIP contains non-empty `my-test-board.kicad_pcb`, `my-test-board.kicad_sch` and `my-test-board.kicad_pro` files, plus the two local VRML model files.

## Exact code comparison

- Fixed checkout: `9e335b8a36f712b564a7098955c399aad6b7ac27` (PR head).
- Original loader: `src/lib/utils/load-internal-dynamic-modules.ts` from parent `fc590861bb6eb5e192e2425736f5e411e537037b`.
- Both browser runs used the same PR checkout and harness. For the before run, only the loader file was replaced with its parent version, removing the rejection handler. The file was restored after recording. There were no reloads, cache clearing or source changes between the two clicks within either run.
- The ordinary Bun regression failed against the original loader and passed against the fixed loader: [before unit log](before-unit.log), [after unit log](after-unit.log).
- The browser harness has an explicit before mode which asserts the known buggy result. Its passing before-run status means it reproduced the bug, not that the original loader passes the regression.

## Repeat the recorded browser reproduction

Use a fresh checkout so the before comparison does not affect unrelated local edits:

```sh
git clone https://github.com/tscircuit/tscircuit.com.git kicad-retry-review
cd kicad-retry-review
git fetch origin pull/5544/head
git checkout --detach 9e335b8a36f712b564a7098955c399aad6b7ac27
bun install --frozen-lockfile
bunx playwright install chromium
curl -fL https://raw.githubusercontent.com/anil08607/tscircuit.com/docs/pr-5544-browser-proof/kicad-retry-repro.spec.ts -o playwright-tests/kicad-retry-repro.spec.ts
```

Start `bun run start:playwright-server` in another terminal in that checkout, and wait for `http://127.0.0.1:5177` to be ready. Then run:

```sh
# Fixed version: second click must download a valid ZIP.
bunx playwright test playwright-tests/kicad-retry-repro.spec.ts --workers=1 --retries=0 --output=../retry-after

# Original loader: second click must receive the cached rejection.
git show fc590861bb6eb5e192e2425736f5e411e537037b:src/lib/utils/load-internal-dynamic-modules.ts > src/lib/utils/load-internal-dynamic-modules.ts
RETRY_REPRO_BEFORE=1 bunx playwright test playwright-tests/kicad-retry-repro.spec.ts --workers=1 --retries=0 --output=../retry-before

# Restore the fix and run the normal regression.
git restore --source=9e335b8a36f712b564a7098955c399aad6b7ac27 -- src/lib/utils/load-internal-dynamic-modules.ts
bun test bun-tests/load-internal-dynamic-modules.test.ts
```

Each browser run saves `video.webm`, a final screenshot and `observations.json` in its test output directory. The after run also saves the downloaded ZIP. The default harness mode expects recovery and will fail on the original loader.

## Quick manual validation

Open a circuit package's Files tab in a fresh page session on the original site and separately on the PR preview/local fixed build. Before the first KiCad download, run this in DevTools:

```js
let retryDemoAttempts = 0
globalThis.tscircuitDynamicImportResolver = (specifier, fallback) => {
  if (specifier !== "circuit-json-to-kicad") return fallback(specifier)
  console.log("KiCad resolver call", ++retryDemoAttempts)
  if (retryDemoAttempts === 1) {
    return Promise.reject(new Error("TEST: first converter import intentionally rejected"))
  }
  return fallback("circuit-json-to-kicad@0.0.241")
}
```

Click **Download → KiCad → Project**, allow the injected failure to finish, then click it again without reloading. Original loader: count stays at 1 and the same error repeats. Fixed loader: count reaches 2 and the real converter can produce a ZIP if its CDN and the circuit are otherwise working. A fresh page session removes the temporary hook. Do not run this after KiCad has already loaded successfully, because the successful cache would bypass the hook.

The fix only permits the next user request to retry. It does not add an automatic retry loop or change error-toast UI. This evidence branch is separate from the production PR diff.
