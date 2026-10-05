import cron from "node-cron";
import { createDatabasePool, ingestLiveAir } from "./camsAirIngestor.js";
import { ingestLiveWater } from "./sentinelWaterIngestor.js";

let running = false;
export async function runIngestionCycle(pool, logger = console) {
  if (running) return { skipped: true };
  running = true;
  try {
    const [air, water] = await Promise.all([ingestLiveAir({ pool, logger }), ingestLiveWater({ pool, logger })]);
    return { skipped: false, air, water };
  } finally {
    running = false;
  }
}
export function startScheduler({ pool = createDatabasePool(), logger = console } = {}) {
  const execute = () => runIngestionCycle(pool, logger).then((result) => logger.info("Ciclo SMAM: " + JSON.stringify(result))).catch((error) => logger.error(error.stack ?? error.message));
  const task = cron.schedule("*/15 * * * *", execute, { timezone: "America/Guatemala" });
  void execute();
  const shutdown = async () => { task.stop(); await pool.end(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return task;
}
if (import.meta.url === "file://" + process.argv[1]) startScheduler();
