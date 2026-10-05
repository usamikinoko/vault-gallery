/** The vault projection: cached tree, reference index and derived statistics. */

export { ImageStore } from "./imageStore";
export { BacklinkIndex, type ReferenceCounts } from "./backlinks";
export { createComparer, type Comparer } from "./comparer";
export { countExtensions, totalBytes } from "./stats";
export { sortImages } from "./sort";
export { buildTreeIndex, type TreeIndex, type TreeOptions } from "./tree";
