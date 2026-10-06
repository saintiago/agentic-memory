/**
 * Entry point of `npm run memory:maintain`: read the explicit host settings and run the offline
 * reviewed context-correction command. Every outcome leaves the process with a nonzero exit code
 * only when the correction was not acknowledged or unchanged.
 *
 * See docs/service.md#operator-context-correction and service/README.md.
 */
import { runMaintenanceCommand } from "./maintenance.js";
import { readServiceSettings } from "./settings.js";

const run = async (): Promise<number> => {
  let settings;
  try {
    settings = readServiceSettings(process.env);
  } catch (cause) {
    const message =
      cause instanceof Error
        ? cause.message
        : "The maintenance host settings could not be read.";
    process.stderr.write(
      `${JSON.stringify({ error: { code: "invalid-configuration", message } })}\n`,
    );
    return 1;
  }
  return await runMaintenanceCommand(process.argv.slice(2), { settings });
};

process.exitCode = await run();
