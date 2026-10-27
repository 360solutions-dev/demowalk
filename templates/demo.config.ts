import type { DemoConfig } from "demowalk";

// ⬇️ Wire YOUR portal's own e2e auth here (every host has one for its tests).
// ⚠️ Import ORDER matters: if your global setup loads env on import and the
// auth fixture reads env at ITS import, the setup import must come FIRST.
// import globalSetup from "../tests/global-setup";
// import { createAuthContext } from "../tests/fixtures/auth.fixture";

/**
 * The ONLY portal-specific piece of the demo-video pipeline.
 *
 * ⚠️ Branding is per project: copy the values from THIS portal's theme
 * tokens (primary → ringColor, secondary → chipColor, skeleton grey →
 * redactionTint). Never leave another project's colours in here.
 */
const config: DemoConfig = {
  baseUrl: process.env.BASE_URL ?? "http://localhost:3000",
  // prepare: () => globalSetup(),
  createAuthContext: async () => {
    throw new Error("demo.config.ts: wire your portal's e2e auth fixture here");
  },
  ringColor: "#2F6FEB", // ← this portal's theme primary
  chipColor: "#1F2937", // ← this portal's theme secondary
  redactionTint: "#E2E5E9", // ← this portal's skeleton grey
  voice: "Tom (Enhanced)",
};

export default config;
