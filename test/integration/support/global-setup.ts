/**
 * Start one isolated Qdrant for the integration run and expose its URL to the test files. A
 * missing Qdrant fails the run with preparation instructions instead of reporting a pass.
 */
import { startQdrantFixture } from "./qdrant-fixture.js";

interface GlobalSetupContext {
  provide: (key: "qdrantUrl", value: string) => void;
}

export default async function setup(
  context: GlobalSetupContext,
): Promise<() => Promise<void>> {
  const fixture = await startQdrantFixture();
  context.provide("qdrantUrl", fixture.url);
  return async () => {
    await fixture.dispose();
  };
}
