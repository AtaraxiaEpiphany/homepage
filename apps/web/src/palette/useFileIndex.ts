import { useEffect, useState } from "react";
import { fetchFileList } from "../lib/api.js";

const CACHE_TTL_MS = 30_000;
let cache: { files: string[]; at: number } | null = null;

/**
 * Content file list for the palette, refreshed at most every 30s (module-level
 * cache — reopening the palette does not refetch). Empty on backend failure:
 * the palette still works for commands.
 */
export function useFileIndex(): string[] {
  const [files, setFiles] = useState<string[]>(cache?.files ?? []);

  useEffect(() => {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return;
    let alive = true;
    fetchFileList()
      .then((files) => {
        cache = { files, at: Date.now() };
        if (alive) setFiles(files);
      })
      .catch(() => {
        /* backend down — commands still available */
      });
    return () => {
      alive = false;
    };
  }, []);

  return files;
}
