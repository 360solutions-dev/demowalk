import * as fs from "fs";
import * as path from "path";

import { chromium, type CDPSession, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";

import type { CaptureManifest, DemoConfig, FrameMeta, Journey, StepContext } from "./types";

/**
 * Walks a journey on the LIVE app and writes one screenshot + spotlight/
 * redaction geometry per step, for overlay/tts/stitch to consume.
 *
 * ⚠️ **Auth comes from the HOST's own e2e fixture** via config.createAuthContext.
 * There is deliberately no login implementation here: each portal's fixture
 * already handles its auth provider's quirks, and a second copy would drift.
 *
 * ⚠️ **No real credential ever appears in a frame.** Steps marked `preAuth`
 * run in a separate SIGNED-OUT context (the login story, typed with
 * fictional values, never submitted); everything else runs in the fixture's
 * signed-in session, so no password exists on camera at all.
 */

let VIEWPORT = { width: 1600, height: 900 };
/**
 * Frames are shot at 2× (retina) through the RAW CDP screenshot call — both
 * --force-device-scale-factor and a CDP metrics override are ignored by
 * Playwright's own page.screenshot(), which resets the metrics to the
 * context's (1×) before capturing; both were tried and produced soft 1×
 * frames that read as "low image quality" on review. Page.captureScreenshot
 * honours the override. The real scale is still MEASURED from the first
 * shot rather than assumed, so if the override ever stops working the
 * geometry stays correct at whatever scale actually arrives.
 */
let SCALE = 1;

async function retinaSession(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 2,
    mobile: false,
  });
  return cdp;
}

async function shoot(cdp: CDPSession): Promise<Buffer> {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  return Buffer.from(data, "base64");
}

async function detectScale(cdp: CDPSession): Promise<void> {
  const meta = await sharp(await shoot(cdp)).metadata();
  SCALE = (meta.width ?? VIEWPORT.width) / VIEWPORT.width;
  console.log(`[demo] capture scale: ${SCALE}x (${meta.width}x${meta.height})`);
}

/** Settle = network idle + a beat for MUI transitions; never flaky-blind. */
async function settle(page: Page, extraMs = 0): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => {
    // Some screens poll; a stuck "networkidle" must not hang the pipeline.
  });
  await page.waitForTimeout(400 + extraMs);
}

/**
 * Union of all matched elements' boxes, in IMAGE pixels. Scrolls the first
 * target into view so the spotlight is actually on screen when we shoot.
 */
async function spotlightBox(
  locators: Locator[],
  page: Page
): Promise<FrameMeta["spotlight"] | undefined> {
  // Spotlight targets are often behind an API call (stat cards, tables), so
  // "settle" alone isn't enough — wait for the first target to actually be
  // visible before measuring. A timeout falls through to the loud
  // UI-changed error in the caller rather than throwing here.
  await locators[0]
    .first()
    .waitFor({ state: "visible", timeout: 20_000 })
    .catch(() => {});

  const boxes: { x: number; y: number; width: number; height: number }[] = [];
  let scrolled = false;
  for (const locator of locators) {
    for (const el of await locator.all()) {
      if (!scrolled) {
        // Guarded like the measurements: a re-render mid-scroll (tables
        // refreshing) must not fail the run (hit live on Partner Listing).
        await el.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});
        await page.waitForTimeout(250); // let the scroll finish before measuring
        scrolled = true;
      }
      // Short timeout + skip: a target that re-rendered mid-measure (polling
      // tables do) must not hang the run — it simply isn't measured.
      const box = await el.boundingBox({ timeout: 3_000 }).catch(() => null);
      if (box) boxes.push(box);
    }
  }
  if (boxes.length === 0) return undefined;

  const x1 = Math.min(...boxes.map((b) => b.x));
  const y1 = Math.min(...boxes.map((b) => b.y));
  const x2 = Math.max(...boxes.map((b) => b.x + b.width));
  const y2 = Math.max(...boxes.map((b) => b.y + b.height));
  return {
    x: Math.round(x1 * SCALE),
    y: Math.round(y1 * SCALE),
    width: Math.round((x2 - x1) * SCALE),
    height: Math.round((y2 - y1) * SCALE),
  };
}

/**
 * ⚠️ UNIVERSAL redactions — applied to EVERY frame of EVERY journey without
 * any step opting in (review review: "blur all dynamic records… all tables,
 * all fields, all portals — never hand-list per step"). Journey/step redacts
 * ADD patterns (label→value pairs, checkbox-name siblings); they can never
 * be the only line of defence again.
 *
 *   - every FILLED input/textarea (capture skips empty/checkbox/radio/color)
 *   - every table body cell (tbody td) — headers/structure stay readable;
 *     EMPTY cells and the single "No records" empty-state cell are skipped
 *     (an empty table has nothing dynamic — blurring it looks broken)
 *   - list rows and stat values marked with data-testid …-row / …-value
 *   - uploaded/preview images (blob:/data:)
 */
function universalRedactions(page: Page): Locator[] {
  return [
    page.locator("input, textarea"),
    page.locator("tbody td"),
    page.locator('[data-testid$="-row"]'),
    page.locator('[data-testid$="-value"]'),
    page.locator('img[src^="blob:"], img[src^="data:"]'),
  ];
}

/** Runs one step on its page and appends its frame — shared by both phases. */
async function captureStep(
  ctx: StepContext,
  cdp: CDPSession,
  step: Journey["steps"][number],
  framesDir: string,
  frames: FrameMeta[],
  journeyRedact?: Journey["redact"]
): Promise<void> {
  const { page } = ctx;
  console.log(`[demo] step ${step.id}`);
  try {
    if (step.do) await step.do(ctx);
  } catch (err) {
    // An action failed — before rethrowing, say what the SCREEN said.
    // The app reports failures as toasts (react-toastify), so the toast
    // text is usually the entire diagnosis (e.g. a validation error
    // from the backend), and the debug frame shows the rest.
    const debugShot = path.join(framesDir, `${step.id}-FAILED.png`);
    await page.screenshot({ path: debugShot }).catch(() => {});
    const toast = await page
      .locator(".Toastify")
      .innerText({ timeout: 1_000 })
      .catch(() => "");
    throw new Error(
      `[demo] step "${step.id}" action failed: ${err instanceof Error ? err.message : err}\n` +
        (toast.trim() ? `        on-screen toast: ${toast.trim().replace(/\n+/g, " | ")}\n` : "") +
        `        page was at: ${page.url()}\n` +
        `        debug frame: ${debugShot}`
    );
  }
  await settle(page, step.settleMs ?? 0);

  // ⚠️ Never capture a frame with a toast on screen (any journey, any step):
  // success toasts are transient app chrome, not part of the story. Waits for
  // react-toastify to finish auto-dismissing; resolves immediately when none.
  await page
    .locator(".Toastify__toast")
    .last()
    .waitFor({ state: "detached", timeout: 10_000 })
    .catch(() => {});

  const spotlight = step.spotlight ? await spotlightBox(step.spotlight(ctx), page) : undefined;
  if (step.spotlight && !spotlight) {
    // A missing spotlight means the UI changed under us. Fail loudly —
    // a frame lighting up nothing is a stale demo, the thing this
    // pipeline exists to prevent. The debug frame + URL say where the
    // run actually was, which is usually the whole diagnosis.
    const debugShot = path.join(framesDir, `${step.id}-FAILED.png`);
    await page.screenshot({ path: debugShot }).catch(() => {});
    throw new Error(
      `[demo] step "${step.id}": spotlight target not found — the UI ` +
        `has likely changed; update the journey file.\n` +
        `        page was at: ${page.url()}\n` +
        `        debug frame: ${debugShot}`
    );
  }

  // Redactions measure whatever is on screen right now; an element that
  // is offscreen or missing simply contributes nothing (no scroll — the
  // frame is shot as-is, so only visible pixels need blurring).
  const redactions: NonNullable<FrameMeta["redactions"]> = [];
  const redactLocators = [
    ...universalRedactions(page),
    ...(journeyRedact?.(ctx) ?? []),
    ...(step.redact?.(ctx) ?? []),
  ];
  {
    for (const locator of redactLocators) {
      for (const el of await locator.all()) {
        // Same stale-element guard as the spotlight: a row that re-rendered
        // between .all() and measuring would otherwise wait 30s and fail the
        // run (hit live on the Recent Partners table's 6th row).
        const box = await el.boundingBox({ timeout: 3_000 }).catch(() => null);
        if (box && box.width > 0 && box.height > 0) {
          // An INPUT blurs only its typed VALUE, not the whole control — the
          // border and padding stay visible, matching the reference video
          // ("I just blur text section, not full fields"). An EMPTY field or
          // a checkbox/radio is skipped entirely, so a journey may simply
          // redact `page.locator("input")` and only typed values blur
          // ("every filled form information don't show in this video").
          const kind = await el
            .evaluate((e) => {
              const tag = e.tagName;
              if (tag !== "INPUT" && tag !== "TEXTAREA") {
                // An EMPTY element holds nothing dynamic — blurring it paints
                // skeleton bars over blank space and makes an empty table look
                // broken (review: "if table is empty, why you blur the table?").
                const text = (e as HTMLElement).innerText?.trim() ?? "";
                const hasMedia = !!e.querySelector("img,svg,canvas,video,picture");
                if (!text && !hasMedia) return "skip";
                // The classic empty-state cell — ONE cell in ONE tbody row
                // ("No records found", usually colspan over every column) — is
                // app UI text, never data (style rule 13). A real 1×1 data
                // table is vanishingly rare; a journey redact can still cover
                // one deliberately.
                if (tag === "TD") {
                  const row = e.closest("tr");
                  const body = e.closest("tbody");
                  if (
                    row?.children.length === 1 &&
                    body?.querySelectorAll("tr").length === 1
                  )
                    return "skip";
                }
                return "element";
              }
              const input = e as HTMLInputElement;
              if (input.type === "checkbox" || input.type === "radio" || input.type === "color")
                return "skip";
              return input.value.trim() === "" ? "skip" : "field";
            })
            .catch(() => "element");
          if (kind === "skip") continue;
          const { x, width } = box;
          let { y, height } = box;
          if (kind === "field") {
            // Vertical inset only — any horizontal inset plus the feathered
            // mask edge exposed the first character of the value (review,
            // twice). The blur may kiss the field border; the character must
            // never show.
            const padY = Math.max(4, (height - 28) / 2);
            y += padY;
            height -= padY * 2;
          }
          redactions.push({
            x: Math.round(x * SCALE),
            y: Math.round(y * SCALE),
            width: Math.round(width * SCALE),
            height: Math.round(height * SCALE),
          });
        }
      }
    }
  }

  const image = `${step.id}.png`;
  fs.writeFileSync(path.join(framesDir, image), await shoot(cdp));
  frames.push({
    id: step.id,
    narration: step.narration,
    label: step.label,
    spotlight,
    protectOnly: step.protectOnly,
    protect: step.protect,
    redactions: redactions.length ? redactions : undefined,
    image,
  });
}

export async function capture(
  journey: Journey<unknown>,
  config: DemoConfig,
  outDir: string
): Promise<CaptureManifest> {
  const baseUrl = config.baseUrl;
  const data = journey.data;
  if (config.viewport) VIEWPORT = config.viewport;
  const framesDir = path.join(outDir, "frames");
  fs.mkdirSync(framesDir, { recursive: true });

  const frames: FrameMeta[] = [];
  const preAuthSteps = journey.steps.filter((s) => s.preAuth);
  const mainSteps = journey.steps.filter((s) => !s.preAuth);

  const browser = await chromium.launch();
  try {
    // Phase 1 — the signed-OUT login story, in its own throwaway context.
    // These steps navigate themselves and never submit anything.
    if (preAuthSteps.length) {
      const plainContext = await browser.newContext({ viewport: VIEWPORT });
      const plainPage = await plainContext.newPage();
      const plainCtx: StepContext = { page: plainPage, baseUrl, data };
      await plainPage.goto(`${baseUrl}/login`).catch(() => {});
      const plainCdp = await retinaSession(plainPage);
      await detectScale(plainCdp);
      for (const step of preAuthSteps) {
        await captureStep(plainCtx, plainCdp, step, framesDir, frames, journey.redact);
      }
      await plainContext.close();
    }

    // Phase 2 — the signed-in journey.
    // ⚠️ Capture happens in createAuthContext's OWN context, at 1× — both
    // deliberately, both learned on live runs. A CDP metrics override doesn't
    // change screenshot resolution, and copying the storage state into a
    // fresh 2× context looked signed-in but fell to /login mid-run (the
    // app's bootstrap 401-signs-out). The fixture context is the one path
    // that demonstrably stays signed in; crispness is the overlay's job —
    // it upscales from the frame's MEASURED size, never an assumed one.
    const context = await config.createAuthContext(browser);
    const page = await context.newPage();
    await page.setViewportSize(VIEWPORT);

    const ctx: StepContext = { page, baseUrl, data };
    await page.goto(`${baseUrl}${journey.startPath}`);
    // The context re-runs the app's auth bootstrap; give it the same grace
    // the e2e fixture gives, and fail with a plain answer if the session
    // didn't take — every later step would otherwise fail confusingly.
    if (page.url().includes("/login")) {
      await page
        .waitForURL((url) => !url.href.includes("/login"), { timeout: 30_000 })
        .catch(() => {
          throw new Error(
            "[demo] the auth session did not sign in (stuck on /login) — " +
              "check .env.test credentials; `npm run e2e` uses the same ones."
          );
        });
    }
    await settle(page, 800);
    const cdp = await retinaSession(page);
    await detectScale(cdp);

    try {
      for (const step of mainSteps) {
        await captureStep(ctx, cdp, step, framesDir, frames, journey.redact);
      }
    } finally {
      if (journey.cleanup) {
        await journey.cleanup(ctx).catch((err) => {
          console.warn(`[demo] cleanup failed (demo record may remain): ${err}`);
        });
      }
    }

    const manifest: CaptureManifest = {
      journeyId: journey.id,
      title: journey.title,
      width: VIEWPORT.width * SCALE,
      height: VIEWPORT.height * SCALE,
      scale: SCALE,
      frames,
    };
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    return manifest;
  } finally {
    await browser.close();
  }
}
