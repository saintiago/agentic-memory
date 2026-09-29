/**
 * Composition of the inspection host: one service-backed source for note details, search and the
 * paginated stored-vector export. The host opens no database, loads no encoder and holds no
 * provider credentials; it exposes no write route.
 *
 * See docs/dashboard.md#startup-and-composition.
 */
import { openServiceInspectionSource } from "./service-source.js";
import type { InspectionSource } from "./source.js";
import type { InspectionSettings } from "./settings.js";

/** Open the service-backed read surface the session and browser API consume. */
export const openInspectionSource = (
  settings: InspectionSettings,
): InspectionSource =>
  openServiceInspectionSource({
    url: settings.service.url,
    timeoutMs: settings.service.timeoutMs,
  });
