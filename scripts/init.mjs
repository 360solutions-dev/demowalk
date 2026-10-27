#!/usr/bin/env node
/**
 * One-command host setup: `npx demogen-init` (run from the host repo root
 * after installing the kit). Idempotent — safe to run again any time.
 *
 *   1. adds the demo:video / demo:update scripts to the host package.json
 *   2. copies the starter templates to demo/ (only if demo/ doesn't exist)
 *   3. adds demo/out/ to .gitignore
 *   4. prints exactly what is left to do by hand (wire auth + branding)
 *
 * Exists because a manual install kept missing step 3 ("Missing script:
 * demo:video") — the kit now does every mechanical step itself.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostRoot = process.cwd();

const pkgPath = path.join(hostRoot, "package.json");
if (!fs.existsSync(pkgPath)) {
  console.error("[demogen-init] run this from the host repo root (no package.json here).");
  process.exit(1);
}

// 1. scripts
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
pkg.scripts = pkg.scripts ?? {};
pkg.scripts["demo:video"] = "tsx demo/run.ts";
// demo:update matches HOW this host installed demogen: a local folder install
// keeps the forced --install-links copy; a registry/GitHub install just
// reinstalls the spec. (The rm -rf is what defeats npm's "up to date" cache.)
const spec =
  pkg.devDependencies?.demogen ?? pkg.dependencies?.demogen ?? "file:../demogen";
pkg.scripts["demo:update"] = spec.startsWith("file:")
  ? `rm -rf node_modules/demogen && npm install --save-dev --install-links ${spec}`
  : "rm -rf node_modules/demogen && npm install";
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log("✓ scripts: demo:video, demo:update");

if (!pkg.devDependencies?.tsx && !pkg.dependencies?.tsx) {
  console.log("⚠ tsx is not installed — run: npm install --save-dev tsx");
}

// 1.5 AUTO-WIRE demo.config.ts when the host follows the common e2e
// convention (tests/global-setup.ts default export + tests/fixtures/
// auth.fixture.ts exporting createAuthContext). Detection also reads the
// dev port from the dev script and the theme's primary/secondary colours —
// so on a conventional repo, init produces a config that RUNS, with zero
// manual wiring. Anything undetectable keeps a safe default + a TODO.
function detectConfig() {
  const read = (rel) => {
    try {
      return fs.readFileSync(path.join(hostRoot, rel), "utf-8");
    } catch {
      return null;
    }
  };
  const setup = read("tests/global-setup.ts");
  const fixture = read("tests/fixtures/auth.fixture.ts");
  if (!setup || !/export default/.test(setup)) return null;
  if (!fixture || !/export (async )?function createAuthContext/.test(fixture)) return null;

  const port = /-p\s+(\d+)/.exec(pkg.scripts?.dev ?? "")?.[1] ?? "3000";
  const theme = read("src/theme/index.ts") ?? "";
  const primary = /primary:\s*['"](#[0-9a-fA-F]{6})/.exec(theme)?.[1];
  const secondary = /secondary:\s*['"](#[0-9a-fA-F]{6})/.exec(theme)?.[1];

  return `import type { DemoConfig } from "demogen";

// ⚠️ Import ORDER matters: the global setup loads the e2e env on import,
// and the auth fixture reads that env at ITS import — setup must come first.
import globalSetup from "../tests/global-setup";
import { createAuthContext } from "../tests/fixtures/auth.fixture";

/**
 * AUTO-WIRED by demogen-init from this repo's own conventions
 * (e2e fixture, dev port, theme colours). Review the values once; adjust
 * anything the detection got wrong.
 */
const config: DemoConfig = {
  baseUrl: process.env.BASE_URL ?? "http://localhost:${port}",
  prepare: () => globalSetup(),
  createAuthContext,
  ringColor: "${primary ?? "#2F6FEB"}",${primary ? " // from src/theme primary" : " // TODO: your theme primary"}
  chipColor: "${secondary ?? "#1F2937"}",${secondary ? " // from src/theme secondary" : " // TODO: your theme secondary"}
  redactionTint: "#E2E5E9", // skeleton grey — adjust to your theme's tint
  voice: "Tom (Enhanced)",
};

export default config;
`;
}

let autoWired = false;
const configPath = path.join(hostRoot, "demo", "demo.config.ts");
const existingConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : null;
const isUnwiredPlaceholder = existingConfig?.includes("wire your portal's e2e auth fixture here");
if (!existingConfig || isUnwiredPlaceholder) {
  const wired = detectConfig();
  if (wired) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, wired);
    autoWired = true;
    console.log("✓ demo/demo.config.ts AUTO-WIRED from this repo's e2e fixture, dev port and theme");
  } else if (isUnwiredPlaceholder) {
    console.log("⚠ demo/demo.config.ts is still the placeholder and no e2e convention was detected — wire it by hand");
  }
}
// (a config the team already edited is never touched)

// 2. templates → demo/, FILE-level idempotent: each missing file is copied,
// each existing file is left untouched (a discarded install can leave empty
// folders behind — "the folder exists" proves nothing about its contents).
const demoDir = path.join(hostRoot, "demo");
const templatesDir = path.join(kitRoot, "templates");
let copied = 0;
for (const rel of fs.readdirSync(templatesDir, { recursive: true })) {
  const src = path.join(templatesDir, String(rel));
  if (fs.statSync(src).isDirectory()) continue;
  const dest = path.join(demoDir, String(rel));
  if (fs.existsSync(dest)) continue;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  copied++;
  console.log(`✓ demo/${rel} created from template`);
}
if (copied === 0) console.log("✓ demo/ complete — nothing to copy");

// 3. gitignore
const giPath = path.join(hostRoot, ".gitignore");
const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, "utf-8") : "";
if (!gi.split("\n").some((l) => l.trim() === "demo/out/")) {
  fs.writeFileSync(giPath, gi.replace(/\n?$/, "\n") + "demo/out/\n");
  console.log("✓ .gitignore: demo/out/");
} else {
  console.log("✓ .gitignore already covers demo/out/");
}

// 4. what's left (the genuinely portal-specific part)
const configStep = autoWired
  ? `  1. Review demo/demo.config.ts (auto-wired — adjust anything detection
     got wrong) and make sure the e2e env file it relies on exists with the
     test user's credentials.`
  : `  1. Wire demo/demo.config.ts — your auth fixture (env-loading setup
     import FIRST), your baseUrl, YOUR theme colours.`;
console.log(`
Left to do by hand (the portal-specific part):
${configStep}
  2. Check ffmpeg:            ffmpeg -version
  3. Run the smoke test:      npm run demo:video        (runs the example)
`);
