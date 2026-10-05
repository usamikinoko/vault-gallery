/** One image's worth of clipboard data, ready to be written verbatim. */
export interface ImportRequest {
  /** Source name, possibly empty (screenshots have none). */
  name: string;
  mime: string;
  data: ArrayBuffer;
  /** Where it came from, for messages. */
  source: string;
}
