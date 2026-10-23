import { expect, test } from "@playwright/test"
import { readFile, writeFile } from "node:fs/promises"
import JSZip from "jszip"
import { exampleCircuitJson } from "./exampleCircuitJson"

// Standalone review evidence harness; copy into playwright-tests to run.
// The converter itself is real. Only the first resolver call is forced to fail.
const before = process.env.RETRY_REPRO_BEFORE === "1"
const mode = before ? "BEFORE" : "AFTER"
const injectedError = "TEST: first converter import intentionally rejected"
const modelBase = "http://127.0.0.1:5177/retry-repro-models/"
const circuitJson = exampleCircuitJson.map((element) =>
  element.type === "cad_component"
    ? {
        ...element,
        model_wrl_url: `${modelBase}${element.cad_component_id}.wrl`,
      }
    : element,
)

test.use({
  viewport: { width: 1440, height: 1000 },
  video: { mode: "on", size: { width: 1440, height: 1000 } },
})

test(`${mode}: retry KiCad download without reloading`, async ({
  page,
}, info) => {
  test.setTimeout(90_000)
  let navigations = 0
  let downloads = 0
  const errors: string[] = []
  const moduleResponses: { url: string; status: number }[] = []
  const steps: unknown[] = []
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++
  })
  page.on("download", () => downloads++)
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("response", (response) => {
    if (response.url().includes("circuit-json-to-kicad")) {
      moduleResponses.push({ url: response.url(), status: response.status() })
    }
  })
  await page.route("**/package_releases/get_preview_circuit_json?*", (route) =>
    route.fulfill({
      json: {
        preview_circuit_json_response: {
          circuit_json_found: true,
          circuit_json: circuitJson,
        },
      },
    }),
  )
  await page.route(`${modelBase}**`, (route) =>
    route.fulfill({
      contentType: "model/vrml",
      body: "#VRML V2.0 utf8\nShape { geometry Box { size 1 1 1 } }\n",
    }),
  )
  await page.addInitScript(
    ({ injectedError }) => {
      let attempts = 0
      Object.assign(globalThis, {
        retryReproAttempts: () => attempts,
        tscircuitDynamicImportResolver: (
          specifier: string,
          fallback: (specifier: string) => Promise<unknown>,
        ) => {
          if (specifier !== "circuit-json-to-kicad") return fallback(specifier)
          attempts++
          if (attempts === 1) return Promise.reject(new Error(injectedError))
          return fallback("circuit-json-to-kicad@0.0.241")
        },
      })
    },
    { injectedError },
  )

  const attempts = () =>
    page.evaluate(() =>
      (
        globalThis as unknown as { retryReproAttempts: () => number }
      ).retryReproAttempts(),
    )
  const show = async (message: string) => {
    const calls = await attempts()
    const state = {
      message,
      importerCalls: calls,
      downloads,
      navigations,
      errors: [...errors],
    }
    steps.push(state)
    // Clearly marked test instrumentation, not application UI.
    await page.evaluate(
      ({ mode, state }) => {
        let panel = document.getElementById("retry-repro-panel")
        if (!panel) {
          panel = document.createElement("pre")
          panel.id = "retry-repro-panel"
          panel.style.cssText =
            "position:fixed;bottom:16px;left:24px;right:24px;z-index:2147483647;margin:0;padding:22px;background:#101c30;color:#ecf4ff;border:3px solid #659bff;border-radius:10px;font:20px/1.55 monospace;white-space:pre-wrap;pointer-events:none"
          document.body.append(panel)
        }
        panel.textContent = `${mode} | PR #5544 | TEST INSTRUMENTATION\nLocal example circuit; first import failure injected; real converter on retry.\n${state.message}\nImporter calls: ${state.importerCalls}   ZIP downloads: ${state.downloads}   Page navigations: ${state.navigations}\nObserved injected failures: ${state.errors.filter((e) => e.includes("TEST:")).length}`
      },
      { mode, state },
    )
    await page.waitForTimeout(1800) // Make the recorded evidence readable.
  }
  const clickProject = async () => {
    await page.getByRole("button", { name: "Download", exact: true }).click()
    await page.getByRole("menuitem", { name: "KiCad", exact: true }).hover()
    await page.waitForTimeout(700)
    await page.getByRole("menuitem", { name: "Project kicad_*.zip" }).click()
  }

  await page.goto("http://127.0.0.1:5177/testuser/my-test-board#files")
  await expect(
    page.getByRole("button", { name: "Download", exact: true }),
  ).toBeVisible()
  await show("Click 1: request Download > KiCad > Project.")
  await clickProject()
  await expect
    .poll(() => errors.filter((e) => e === injectedError).length)
    .toBe(1)
  expect(await attempts()).toBe(1)
  expect(downloads).toBe(0)
  await show(
    "Click 1 failed as injected. The next resolver call is allowed to load.",
  )
  await show("Click 2: retry on the SAME page; no reload or cache clearing.")

  let zipFiles: string[] = []
  if (before) {
    await clickProject()
    await expect
      .poll(() => errors.filter((e) => e === injectedError).length)
      .toBe(2)
    expect(await attempts()).toBe(1)
    expect(downloads).toBe(0)
    await show(
      "RESULT: second click reused the rejected promise. No new import; no ZIP.",
    )
  } else {
    const pendingDownload = page.waitForEvent("download", { timeout: 60_000 })
    await clickProject()
    await expect.poll(attempts).toBe(2)
    await show(
      "Second import started. Waiting for the real converter and ZIP download...",
    )
    const download = await pendingDownload
    expect(download.suggestedFilename()).toBe("my-test-board_kicad.zip")
    const zipPath = info.outputPath("my-test-board_kicad.zip")
    await download.saveAs(zipPath)
    const zip = await JSZip.loadAsync(await readFile(zipPath))
    zipFiles = Object.keys(zip.files).sort()
    for (const extension of ["kicad_pcb", "kicad_sch", "kicad_pro"]) {
      expect(
        await zip.file(`my-test-board.${extension}`)?.async("string"),
      ).toBeTruthy()
    }
    expect(errors.filter((e) => e === injectedError)).toHaveLength(1)
    expect(await attempts()).toBe(2)
    expect(downloads).toBe(1)
    await show(
      "RESULT: ZIP downloaded. Verified non-empty PCB, schematic and project files.",
    )
  }
  expect(navigations).toBe(1)
  expect(errors.every((error) => error === injectedError)).toBe(true)
  await page.screenshot({ path: info.outputPath(`${mode.toLowerCase()}.png`) })
  await writeFile(
    info.outputPath("observations.json"),
    JSON.stringify(
      {
        mode,
        controlledFirstFailure: true,
        fixture: "playwright-tests/exampleCircuitJson.ts",
        converter: "circuit-json-to-kicad@0.0.241",
        steps,
        moduleResponses,
        zipFiles,
      },
      null,
      2,
    ),
  )
  await page.waitForTimeout(2500)
})
