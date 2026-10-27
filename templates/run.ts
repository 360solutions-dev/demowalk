import { run } from "demogen";

import config from "./demo.config";

run(config, (id) => import(`./journeys/${id}`)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
