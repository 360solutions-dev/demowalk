// Silence dotenv v17's "injected env (N) … // tip: …" banner before the host
// config (and its env-loading setup import) is evaluated. Imports are hoisted
// in ESM, so this only works via dynamic import — keep it this way.
process.env.DOTENV_CONFIG_QUIET ??= "true";

const { run } = await import("demowalk");
const { default: config } = await import("./demo.config");

run(config, (id) => import(`./journeys/${id}`)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

export {};
