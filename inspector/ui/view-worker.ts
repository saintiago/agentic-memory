/**
 * The browser worker that parses, validates and diffs served graph payloads off the main thread.
 * It shares the planning rules with the inline differ, so worker support never changes what the
 * display receives.
 *
 * See docs/dashboard.md#asynchronous-data-updates.
 */
import {
  createInlineViewDiffer,
  type ViewPlanRequest,
  type ViewPlanResponse,
} from "./view-diff.js";

const differ = createInlineViewDiffer();

const post = (message: ViewPlanResponse): void => {
  (
    globalThis as unknown as { postMessage(message: unknown): void }
  ).postMessage(message);
};

addEventListener("message", (event: MessageEvent<ViewPlanRequest>) => {
  const request = event.data;
  differ.plan(request.text).then(
    (diff) => {
      post({ id: request.id, diff });
    },
    (cause: unknown) => {
      post({
        id: request.id,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    },
  );
});
