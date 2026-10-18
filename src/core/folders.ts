/** A directory is one of the folders, or inside one: written with either separator, with or without a trailing one. */
export function within(dir: string, folders: readonly string[]): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const d = norm(dir);
  return folders.some((folder) => {
    const f = norm(folder);
    return d === f || d.startsWith(`${f}/`);
  });
}
