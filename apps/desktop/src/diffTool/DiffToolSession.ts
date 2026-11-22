// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- This desktop boundary owns a long-lived git child process, a temp repo, and a file watcher.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { DesktopDiffToolFile } from "@t3tools/contracts";

export interface DiffToolSessionCallbacks {
  readonly onChange: (path: string, contents: string) => void;
  readonly onClose: () => void;
  readonly onFail: (message: string) => void;
}

export interface DiffToolSessionOptions {
  readonly files: ReadonlyArray<DesktopDiffToolFile>;
  readonly callbacks: DiffToolSessionCallbacks;
  readonly env?: NodeJS.ProcessEnv;
  readonly saveDebounceMs?: number;
}

// Keeps the throwaway repo from running the user's hooks or prompting to sign its commit.
const ISOLATED_GIT_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "user.name=T3 Code",
  "-c",
  "user.email=t3code@localhost",
];

const STDERR_TAIL_BYTES = 4_000;

/** Null for a path that would leave the repo or reach into its `.git`; it comes from the remote. */
export function safeRepositoryPath(path: string): string | null {
  if (path.length === 0 || path.includes("\0") || NodePath.isAbsolute(path)) return null;
  const segments = path.split(/[\\/]/);
  if (segments.some((segment) => segment === ".." || segment.toLowerCase() === ".git")) return null;
  const normalized = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
  return normalized.length > 0 ? normalized : null;
}

function runGit(cwd: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    NodeChildProcess.execFile("git", [...args], { cwd, env }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve();
    });
  });
}

async function writeRepositoryFile(root: string, path: string, contents: string) {
  const target = NodePath.join(root, path);
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  await NodeFSP.writeFile(target, contents);
}

/**
 * Commits each file's base side, then leaves its current side in the working tree, so
 * `git difftool -d` shows one folder compare whose right side links to files we can watch.
 */
async function prepareDiffToolRepository(
  root: string,
  files: ReadonlyArray<DesktopDiffToolFile>,
  env: NodeJS.ProcessEnv,
): Promise<ReadonlyMap<string, string>> {
  const entries = files.map((file) => {
    const oldPath = file.oldPath === null ? null : safeRepositoryPath(file.oldPath);
    const newPath = file.newPath === null ? null : safeRepositoryPath(file.newPath);
    if (
      (file.oldPath !== null && oldPath === null) ||
      (file.newPath !== null && newPath === null)
    ) {
      throw new Error(`Refusing to open unsafe path '${file.newPath ?? file.oldPath}'.`);
    }
    return { ...file, oldPath, newPath };
  });

  await runGit(root, ["init", "-q"], env);
  for (const entry of entries) {
    if (entry.oldPath !== null) await writeRepositoryFile(root, entry.oldPath, entry.oldContents);
  }
  // Forced, so files the user's global excludes ignore still show up.
  await runGit(root, ["add", "-A", "-f"], env);
  await runGit(root, [...ISOLATED_GIT_CONFIG, "commit", "-q", "--allow-empty", "-m", "base"], env);

  for (const entry of entries) {
    if (entry.oldPath !== null && entry.oldPath !== entry.newPath) {
      await NodeFSP.rm(NodePath.join(root, entry.oldPath), { force: true });
    }
  }
  const editable = new Map<string, string>();
  const added: Array<string> = [];
  for (const entry of entries) {
    if (entry.newPath === null) continue;
    await writeRepositoryFile(root, entry.newPath, entry.newContents);
    if (entry.oldPath !== entry.newPath) added.push(entry.newPath);
    if (entry.editable) editable.set(entry.newPath, entry.newContents);
    else await NodeFSP.chmod(NodePath.join(root, entry.newPath), 0o444);
  }
  // Intent-to-add, so new files appear in the working-tree diff.
  if (added.length > 0) await runGit(root, ["add", "-N", "-f", "--", ...added], env);
  return editable;
}

/** Resolves once the tool has started; callbacks report saves, the close, or a failure. */
export async function startDiffToolSession(options: DiffToolSessionOptions): Promise<void> {
  const env = options.env ?? process.env;
  const debounceMs = options.saveDebounceMs ?? 250;
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-difftool-")),
  );
  const cleanup = () => NodeFSP.rm(root, { recursive: true, force: true }).catch(() => undefined);

  let synced: Map<string, string>;
  try {
    synced = new Map(await prepareDiffToolRepository(root, options.files, env));
  } catch (error) {
    await cleanup();
    throw error;
  }

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const syncPath = async (path: string) => {
    let contents: string;
    try {
      contents = await NodeFSP.readFile(NodePath.join(root, path), "utf8");
    } catch {
      return;
    }
    if (synced.get(path) === contents) return;
    synced.set(path, contents);
    options.callbacks.onChange(path, contents);
  };

  // A tool that saves by replacing the file only lands here when git copies it back on exit.
  const watcher = NodeFS.watch(root, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const path = filename.split(NodePath.sep).join("/");
    if (!synced.has(path)) return;
    clearTimeout(timers.get(path));
    timers.set(
      path,
      setTimeout(() => {
        timers.delete(path);
        void syncPath(path);
      }, debounceMs),
    );
  });

  const child = NodeChildProcess.spawn("git", [...ISOLATED_GIT_CONFIG, "difftool", "-d", "-y"], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
  });

  let finished = false;
  const finish = async (failure: string | null) => {
    if (finished) return;
    finished = true;
    watcher.close();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const path of synced.keys()) await syncPath(path);
    await cleanup();
    if (failure === null) options.callbacks.onClose();
    else options.callbacks.onFail(failure);
  };

  await new Promise<void>((resolve, reject) => {
    let spawned = false;
    child.once("spawn", () => {
      spawned = true;
      resolve();
    });
    // After a spawn, `close` still follows any error and ends the session.
    child.once("error", (error) => {
      if (spawned) return;
      finished = true;
      watcher.close();
      void cleanup();
      reject(error);
    });
  });
  // Some tools exit non-zero when the sides differ, and tools write to git's stderr, so only
  // both together count as a failure.
  child.once("close", (code) => {
    void finish(code !== 0 && stderr.trim() ? stderr.trim() : null);
  });
}
