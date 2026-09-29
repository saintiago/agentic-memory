/**
 * Test instrumentation for the MCP host process: append the URL of every loaded module to the
 * file named by `AMEM_LOAD_LOG`. Load it after the TypeScript loader
 * (`--import tsx --import <this file>`) so the registered hook wraps that loader and observes the
 * complete module graph of the process under test.
 */
import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";

const logPath = process.env.AMEM_LOAD_LOG;
if (logPath !== undefined) {
  registerHooks({
    load(url, context, nextLoad) {
      appendFileSync(logPath, `${url}\n`);
      return nextLoad(url, context);
    },
  });
}
