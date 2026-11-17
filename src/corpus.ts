// The NodeBox 4 test corpus: the documents and files people attached to public
// forum topics, unpacked under <inputs>/d<discussion id>/. This picks what may
// leave the Mac and packs it. No post text, no names, no email addresses: only
// the attached files and the id of the topic they hang on.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sha256File } from "./s3.ts";

export interface Selection {
  /** Paths relative to the inputs folder, with `/`, sorted. */
  files: string[];
  skipped: { privateTopics: number; unknownFolders: number; junk: number; nodeLibrary: number; notFiles: number };
}

// macOS leftovers. "Icon\r" holds a folder's custom Finder icon; its name ends in a carriage return.
const isJunk = (parts: string[]) =>
  parts.some((p) => p === "__MACOSX" || p === ".DS_Store" || p === "Icon\r" || p.startsWith("._"));

/**
 * Walk `inputs` and keep the files of topics `isPublic` accepts. A top-level
 * folder that is not `d<id>` is skipped, so nothing gets in by accident.
 * Node Library releases are left out unless asked for: they are large and are
 * kept out of every repository.
 */
export function select(inputs: string, isPublic: (discussion: number) => boolean, nodeLibrary = false): Selection {
  const out: Selection = {
    files: [],
    skipped: { privateTopics: 0, unknownFolders: 0, junk: 0, nodeLibrary: 0, notFiles: 0 },
  };
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(inputs, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      const parts = child.split("/");
      if (isJunk(parts)) out.skipped.junk++;
      else if (!nodeLibrary && /node[ _]library/i.test(child)) out.skipped.nodeLibrary++;
      else if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out.files.push(child);
      else out.skipped.notFiles++; // symlinks and the like
    }
  };
  for (const entry of fs.readdirSync(inputs, { withFileTypes: true })) {
    const id = /^d(\d+)$/.exec(entry.name);
    if (!entry.isDirectory() || !id) out.skipped.unknownFolders++;
    else if (!isPublic(Number(id[1]))) out.skipped.privateTopics++;
    else walk(entry.name);
  }
  out.files.sort();
  return out;
}

export interface Manifest {
  snapshot: string;
  created: string;
  archive: { key: string; size: number; sha256: string };
  documents: number;
  files: { path: string; size: number; sha256: string }[];
}

export const archiveKey = (snapshot: string) => `snapshots/${snapshot}/corpus.tar.gz`;
export const manifestKey = (snapshot: string) => `snapshots/${snapshot}/manifest.json`;

/** Pack the selected files into `archive` (gzipped tar, paths relative to `inputs`) and describe it. */
export async function pack(inputs: string, files: string[], archive: string, snapshot: string): Promise<Manifest> {
  const list = archive + ".files";
  // NUL-separated, so a name with a carriage return or a newline reaches tar intact.
  fs.writeFileSync(list, files.map((f) => f + "\0").join(""));
  try {
    // COPYFILE_DISABLE keeps macOS tar from adding ._ files for extended attributes.
    execFileSync("tar", ["-czf", archive, "-C", inputs, "--null", "-T", list], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stdio: ["ignore", "inherit", "inherit"],
    });
  } finally {
    fs.rmSync(list, { force: true });
  }
  const entries: Manifest["files"] = [];
  for (const file of files) {
    const full = path.join(inputs, file);
    entries.push({ path: file, size: fs.statSync(full).size, sha256: await sha256File(full) });
  }
  return {
    snapshot,
    created: new Date().toISOString(),
    archive: { key: archiveKey(snapshot), size: fs.statSync(archive).size, sha256: await sha256File(archive) },
    documents: files.filter((f) => f.toLowerCase().endsWith(".ndbx")).length,
    files: entries,
  };
}
