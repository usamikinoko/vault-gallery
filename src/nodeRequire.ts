/*
 * One way to reach Node from the renderer.
 *
 * Kept in its own module with no `obsidian` import on purpose: the ZIP writer
 * depends on it and is bundled standalone by its round-trip test, so pulling in
 * the Obsidian package (whose npm entry point is empty) would break that test
 * for no reason.
 *
 * Electron exposes Node as `window.require`; a plain Node process has the bare
 * global instead. Both paths are needed, and both are desktop-only.
 */

export function nodeRequire<T = unknown>(name: string): T {
  const w =
    typeof window !== "undefined"
      ? (window as unknown as { require?: (m: string) => unknown })
      : null;
  const req = w?.require ?? (typeof require === "function" ? require : null);
  if (!req) throw new Error(`需要桌面版 Obsidian：无法加载 Node 模块 "${name}"。`);
  return req(name) as T;
}

/** Join path segments with the platform's separator, without importing `path`. */
export function joinFsPath(...parts: string[]): string {
  try {
    const path = nodeRequire<{ join(...p: string[]): string }>("path");
    return path.join(...parts.filter(Boolean));
  } catch {
    return parts.filter(Boolean).join("/");
  }
}
