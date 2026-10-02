import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { config } from "./config.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const OPENABLE_EXT = new Set(["md", "markdown", "txt"]);

/** Recursive listing of the content jail, relative paths, sorted. */
function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else {
      out.push(path.relative(config.contentDir, full).split(path.sep).join("/"));
    }
  }
}

/**
 * Read-only HTTP access into ./content — the enforcement point behind `open`.
 * The OSC 7770 hint is only as trusted as the terminal output it came from;
 * every fetch re-validates the same jail the shell-side function checks.
 */
export const fileRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/files", async () => {
    const files: string[] = [];
    walk(config.contentDir, files);
    files.sort();
    return { files: files.filter((f) => OPENABLE_EXT.has(f.split(".").pop() ?? "")) };
  });

  app.get<{ Querystring: { path?: string } }>("/api/file", async (req, reply) => {
    const rel = req.query.path ?? "";
    if (!rel || rel.includes("\0")) {
      return reply.code(400).send({ error: "missing path" });
    }
    // Jail: resolve, then require the content dir prefix. Rejects `..` and
    // absolute escapes identically to the shell-side realpath check.
    const abs = path.resolve(config.contentDir, rel);
    if (abs !== config.contentDir && !abs.startsWith(config.contentDir + path.sep)) {
      return reply.code(403).send({ error: "path escapes content jail" });
    }
    let st;
    try {
      st = statSync(abs);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
    if (!st.isFile()) {
      return reply.code(400).send({ error: "not a regular file" });
    }
    if (st.size > MAX_FILE_BYTES) {
      return reply.code(413).send({ error: "file too large" });
    }
    return reply.send(readFileSync(abs));
  });
};
