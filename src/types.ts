import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";

/**
 * Everything a journey step may touch. Steps receive this rather than reaching
 * for globals so a journey file stays a pure description — the runner owns the
 * browser, the data and the base URL. `data` is whatever the host journey's
 * demo-data module exports.
 */
export interface StepContext<D = unknown> {
  page: Page;
  baseUrl: string;
  data: D;
}

/**
 * One frame of the demo video.
 *
 * The mental model is: `do()` brings the live app into this step's state →
 * the runner screenshots the page → `spotlight()` names what the ring lights
 * up → `narration` is what the voice says while this frame is on screen. The
 * NEXT step's `do()` performs whatever click moves the flow on, so each step
 * owns its own state, not its exit.
 */
export interface JourneyStep<D = unknown> {
  /** Filename stem for the frame + audio (kebab-case, unique per journey). */
  id: string;
  /** Spoken line — also drives how long the frame stays on screen. */
  narration: string;
  /** Short callout rendered beside the spotlight (optional). */
  label?: string;
  /** Bring the app into this step's state (clicks, fills, navigation). */
  do?: (ctx: StepContext<D>) => Promise<void>;
  /**
   * Runs in a SIGNED-OUT browser context, before authentication — for login
   * screens. The step's `do` must navigate itself (the authenticated
   * startPath doesn't apply). Pre-auth steps never submit credentials; they
   * type fictional values and the video then cuts to the signed-in session.
   */
  preAuth?: boolean;
  /**
   * What the ring lights up. Several locators union into one box
   * (e.g. four stat cards). Omit for a clean frame.
   */
  spotlight?: (ctx: StepContext<D>) => Locator[];
  /**
   * Draw nothing for the spotlight — it still marks the step's subject so
   * redactions can never smear it (the overlay re-pastes that region), but
   * no ring or label chip is rendered. For frames where the PRODUCT draws
   * its own callout (an in-app tour card): adding our chrome on top reads
   * as clutter.
   */
  protectOnly?: boolean;
  /**
   * Draw the ring/chip AND re-paste the spotlight region over redactions.
   * For steps whose subject would otherwise be blurred by the universal or
   * journey-wide rules (e.g. a navigation step highlighting sidebar items
   * that are off-topic for the current URL).
   */
  protect?: boolean;
  /**
   * EXTRA regions to redact on this frame, beyond the engine's universal
   * dynamic-data redactions — generic patterns like label→value pairs or
   * checkbox-name siblings. Offscreen/empty matches are skipped silently.
   */
  redact?: (ctx: StepContext<D>) => Locator[];
  /**
   * Regions to KEEP READABLE although a universal/extra redaction covers
   * them — the explicit "don't blur this" opt-out (e.g. a price being typed,
   * which is the very value the step teaches). Original pixels are re-pasted
   * over the redactions.
   */
  keepVisible?: (ctx: StepContext<D>) => Locator[];
  /**
   * Disable the engine's universal redactions for this one frame — for a
   * screen the author explicitly wants shown clean. Journey/step redactions
   * still apply. Use sparingly; the default posture is "all dynamic data
   * blurs".
   */
  noUniversalRedact?: boolean;
  /** Extra settle time before the screenshot, beyond network-idle (ms). */
  settleMs?: number;
}

export interface Journey<D = unknown> {
  id: string;
  title: string;
  /** Route the journey starts on, e.g. "/dashboard". */
  startPath: string;
  /** The data object handed to every step (demo values, all fictional). */
  data: D;
  /**
   * Redactions applied to EVERY frame, merged with the universal ones and
   * each step's own — for chrome that always shows identity (the signed-in
   * user chip, off-topic sidebar items).
   */
  redact?: (ctx: StepContext<D>) => Locator[];
  steps: JourneyStep<D>[];
  /**
   * Removes whatever the journey created, called in a `finally` even when a
   * step fails. Prefer journeys that create NOTHING (never click the final
   * create/submit button; with all values blurred, a ringed existing record
   * tells the identical story) — then no cleanup is needed at all.
   */
  cleanup?: (ctx: StepContext<D>) => Promise<void>;
}

/** What capture writes for each frame, consumed by overlay/tts/stitch. */
export interface FrameMeta {
  id: string;
  narration: string;
  label?: string;
  /** Spotlight box in image pixels (already multiplied by capture scale). */
  spotlight?: Box;
  /** True: spotlight only protects against redactions; no ring/chip drawn. */
  protectOnly?: boolean;
  /** True: ring/chip drawn AND the spotlight region is protected. */
  protect?: boolean;
  /** Regions to redact, in image pixels. */
  redactions?: Box[];
  /** Regions re-pasted over redactions (the "don't blur this" opt-out). */
  keepVisible?: Box[];
  image: string;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureManifest {
  journeyId: string;
  title: string;
  width: number;
  height: number;
  /** Capture scale actually measured (2 on a working retina capture). */
  scale: number;
  frames: FrameMeta[];
}

/**
 * Host-portal configuration — the ONLY portal-specific code. Each repo keeps
 * one `demo.config.ts` exporting this; everything else lives in this package.
 */
export interface DemoConfig {
  /** e.g. "http://localhost:3002". Non-local hosts are refused unless allowRemote. */
  baseUrl: string;
  /**
   * Sign the pipeline in — reuse the host's e2e auth fixture wholesale
   * (it already handles the auth provider's quirks). Returns a signed-in
   * BrowserContext.
   */
  createAuthContext: (browser: Browser) => Promise<BrowserContext>;
  /**
   * Optional pre-flight run once before the browser launches — e.g. the
   * host's e2e global setup that mints the auth token and pings the backend.
   */
  prepare?: () => Promise<void>;
  /** macOS `say` voice. Default: "Tom (Enhanced)" (env DEMO_VOICE overrides). */
  voice?: string;
  /** Spoken words per minute. Default 165 (env DEMO_VOICE_RATE overrides). */
  voiceRate?: string;
  /**
   * ⚠️ Branding is PER PROJECT — nothing brand-coloured is hardcoded in the
   * engine. Every portal passes its own theme values here.
   */
  /** Spotlight ring colour (e.g. the theme's primary). */
  ringColor?: string;
  /** Label chip + caption bar background (e.g. the theme's secondary/navy). */
  chipColor?: string;
  /** Text colour on chips and the caption bar. Default white. */
  chipTextColor?: string;
  /**
   * Redactions render as SKELETON bars: blur tinted with the host's skeleton
   * grey so hidden values read as loading placeholders, not smudges. Give the
   * host theme's tint (e.g. Strata `tint12` #E2E5E9).
   */
  redactionTint?: string;
  /** 0..1 strength of the skeleton tint over the blur. Default 0.55. */
  redactionTintOpacity?: number;
  /** Viewport (CSS px). Default 1600×900, captured at 2×. */
  viewport?: { width: number; height: number };
  /** Allow running against a non-localhost baseUrl. Default false. */
  allowRemote?: boolean;
  /** Where journeys and output live, relative to the host repo root. Default "demo". */
  demoDir?: string;
}
