/**
 * Exporting things out of the plugin: an image archive, and a JSON dump of the
 * plugin's own state. Both share one shape — decide what to write, ask the OS
 * where, write it while showing progress, then say where it went.
 */

export {
  libraryStats,
  imagesUnder,
  collectExportEntries,
  sanitizeFileStem,
  exportLabelFor,
  type LibraryStats,
} from "./stats";
export {
  buildInfoPayload,
  infoFileName,
  exportInfoJson,
  type InfoPayload,
  type InfoExportRequest,
} from "./info";
export { ExportZipModal } from "./zipModal";
