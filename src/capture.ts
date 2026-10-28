import * as fs from "fs";
import * as path from "path";

import { chromium, type CDPSession, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";

import type { Box, CaptureManifest, DemoConfig, FrameMeta, Journey, StepContext } from "./types";

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
        // CENTER the subject, don't just make it visible —
        // scrollIntoViewIfNeeded stops at "minimally visible", which parks a
        // below-the-fold target half-cut at the bottom edge, under the
        // caption bar, with the PREVIOUS section filling the frame (review:
        // the Documents step showed Billing). block:"center" presents the
        // section the narration is actually about. Guarded like the
        // measurements: a re-render mid-scroll must not fail the run.
        await el
          .evaluate((e) => e.scrollIntoView({ block: "center", behavior: "instant" }))
          .catch(() => {});
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

/**
 * ⚠️ UNIVERSAL app-chrome redactions, measured in the page (also on every
 * frame; review 28 Oct):
 *
 *   - NAV items that are not the CURRENT screen blur (icon+label), URL-driven
 *     (style rule 7) — the current screen's own nav item stays readable. A
 *     navigation step `protect`s its subject, which re-pastes it sharp.
 *   - IDENTITY chrome blurs: avatar bubbles (initials/photo) and the user
 *     name/email text beside them — in the header dropdown, a sidebar user
 *     card, anywhere ("in header if you see any dynamic data, blur it").
 *
 * Kept generic: anchors inside nav/aside/[role=navigation]; `avatar`-classed
 * elements plus the text nodes of their click target. Text-only anchors with
 * no label (e.g. a logo link) are left alone — a logo is branding, not data.
 */
export async function chromeRedactionBoxes(page: Page): Promise<Box[]> {
  const boxes = await page.evaluate(() => {
    // tsx/esbuild decorates inner functions with a __name helper that exists
    // only in the Node module scope — define it here or the serialized
    // function dies on its first line INSIDE THE BROWSER ("__name is not
    // defined"), taking every chrome redaction with it.
    (globalThis as { __name?: (fn: unknown) => unknown }).__name ??= (fn) => fn;
    const out: { x: number; y: number; width: number; height: number }[] = [];
    const push = (r: DOMRect) => {
      if (r.width > 0 && r.height > 0)
        out.push({ x: r.x, y: r.y, width: r.width, height: r.height });
    };
    // 1. Non-current nav links (rule 7) — URL decides what stays readable.
    const path = location.pathname;
    document
      .querySelectorAll('nav a[href], aside a[href], [role="navigation"] a[href]')
      .forEach((a) => {
        const href = a.getAttribute("href") ?? "";
        if (!href.startsWith("/")) return;
        if (!(a as HTMLElement).innerText?.trim()) return; // logo/icon-only link
        const target = href.split(/[?#]/)[0];
        const current =
          target === "/" ? path === "/" : path === target || path.startsWith(target + "/");
        if (!current) push(a.getBoundingClientRect());
      });
    // 2. Identity chrome: the avatar bubble + the name/email text beside it.
    document.querySelectorAll('[class*="avatar" i]').forEach((av) => {
      push(av.getBoundingClientRect());
      const holder = av.closest('button,a,[role="button"],li') ?? av.parentElement;
      if (!holder) return;
      const walker = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent?.trim();
        if (!text) continue;
        if (av.contains(n.parentElement)) continue; // initials — bubble covers them
        const range = document.createRange();
        range.selectNodeContents(n);
        push(range.getBoundingClientRect());
      }
    });
    // 3. Personal/dynamic TEXT, generically (review: "blur every dynamic
    //    data… don't add static conditions"): any text node containing a
    //    digit in the CONTENT area is the user's data — counts, dates,
    //    amounts, record numbers. Digits inside structural chrome are UI
    //    (pagination's "Rows per page: 10", stepper numerals, button labels)
    //    and stay readable. A big standalone numeral (a stat-card value)
    //    additionally pulls in its card's trailing caption, which summarises
    //    the same data without containing a digit ("All verified").
    const CHROME =
      'thead, nav, aside, button, a, label, select, [role="navigation"], ' +
      '[role="tablist"], [class*="pagination" i], [class*="stepper" i]';
    const seen = new Set<Node>();
    const blurTextNode = (n: Node) => {
      if (seen.has(n)) return;
      seen.add(n);
      const range = document.createRange();
      range.selectNodeContents(n);
      push(range.getBoundingClientRect());
    };
    const textWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const statValues: Element[] = [];
    for (let n = textWalker.nextNode(); n; n = textWalker.nextNode()) {
      const text = n.textContent?.trim();
      if (!text || !/\d/.test(text)) continue;
      const el = n.parentElement;
      if (!el || el.closest(CHROME)) continue;
      blurTextNode(n);
      const fontSize = parseFloat(getComputedStyle(el).fontSize) || 0;
      if (fontSize >= 20 && !/[a-zA-Z]/.test(text)) statValues.push(el);
    }
    for (const value of statValues) {
      const card = value.parentElement;
      if (!card) continue;
      const w = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      let lastText: Node | null = null;
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (n.textContent?.trim()) lastText = n;
      }
      if (
        lastText &&
        lastText.parentElement !== value &&
        !lastText.parentElement?.closest(CHROME)
      )
        blurTextNode(lastText);
    }
    return out;
  });
  return boxes.map((b) => ({
    x: Math.round(b.x * SCALE),
    y: Math.round(b.y * SCALE),
    width: Math.round(b.width * SCALE),
    height: Math.round(b.height * SCALE),
  }));
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
    // noUniversalRedact (rare, deliberate) keeps only the step's own patterns.
    ...(step.noUniversalRedact ? [] : universalRedactions(page)),
    ...(journeyRedact?.(ctx) ?? []),
    ...(step.redact?.(ctx) ?? []),
  ];
  if (!step.noUniversalRedact) {
    // No silent catch — a failed measure means missing redactions, and a
    // video with unredacted personal data must never render quietly.
    redactions.push(...(await chromeRedactionBoxes(page)));
  }
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
              // Invisible helper inputs (MUI selects keep a 0-opacity native
              // input holding the value — e.g. pagination's "rows per page")
              // paint a stray skeleton bar over UI if blurred. Not data.
              if (input.type === "hidden") return "skip";
              const cs = getComputedStyle(input);
              if (cs.opacity === "0" || cs.visibility === "hidden") return "skip";
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
    let context;
    try {
      context = await config.createAuthContext(browser);
    } catch (err) {
      // The host fixture's raw error (usually a Playwright waitForURL
      // timeout stuck on /login) explains nothing — say what it MEANS.
      const raw = err instanceof Error ? err.message.split("\n")[0] : String(err);
      throw new Error(
        `[demo] SIGN-IN FAILED — the auth fixture never reached the app.\n` +
          `        Almost always one of these, in order of likelihood:\n` +
          `          1. The test user's credentials in your e2e env file are\n` +
          `             empty or wrong — try them by hand at ${baseUrl}/login\n` +
          `          2. The backend API isn't running (the login page loads\n` +
          `             without it, but signing in can't succeed)\n` +
          `          3. The account isn't valid for THIS portal (e.g. a staff\n` +
          `             login on a patient portal)\n` +
          `        Underlying error: ${raw}`
      );
    }
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
