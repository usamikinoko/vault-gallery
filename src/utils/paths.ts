/*
 * Vault-path helpers. Vault paths always use "/" and never a leading slash;
 * the empty string is the vault root.
 */

export function parentPath(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "" : p.slice(0, i);
}

export function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

export function joinPath(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a.replace(/\/+$/, "")}/${b.replace(/^\/+/, "")}`;
}

/** Lowercase extension without the dot; "" when the name has none. */
export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i + 1).toLowerCase();
}

/**
 * Extension exactly as written, case included.
 *
 * Needed by the importer, which must not re-case "草图.PNG" on the way in —
 * silently renaming a file is the kind of unrequested edit that costs trust.
 */
export function rawExtOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i + 1);
}

export function stripExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? name : name.slice(0, i);
}

export function isImageName(name: string, exts: string[]): boolean {
  return exts.includes(extOf(name));
}

/**
 * First free name of the form `base.ext`, `base<sep>2.ext`, … The caller supplies
 * the collision test, so one helper serves both "what is on disk" and "what
 * this batch has already reserved". The separator is a parameter because the
 * paste pipeline names files `目录名-yymmddhhmmss` and must not introduce a
 * space anywhere in the result.
 */
export function uniqueName(
  base: string,
  ext: string,
  taken: (name: string) => boolean,
  sep = " "
): string {
  const join = (b: string) => (ext ? `${b}.${ext}` : b);
  const stem = base || "image";
  if (!taken(join(stem))) return join(stem);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}${sep}${i}`;
    if (!taken(join(candidate))) return join(candidate);
  }
  return join(`${stem}${sep}${Date.now()}`);
}
