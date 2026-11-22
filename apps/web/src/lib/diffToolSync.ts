export interface DiffToolSyncTarget {
  /** Relative to the workspace `projects.writeFile` writes under. */
  readonly workspacePath: string;
  /** The server's contents as of the last open or write. */
  readonly contents: string;
}

export type DiffToolSyncResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export interface DiffToolSyncDeps {
  readonly read: (
    workspacePath: string,
  ) => Promise<
    | { readonly ok: true; readonly contents: string }
    | { readonly ok: false; readonly message: string }
  >;
  readonly write: (workspacePath: string, contents: string) => Promise<DiffToolSyncResult>;
  /** The server's file changed since it was opened; `overwrite` writes the save anyway. */
  readonly onConflict: (workspacePath: string, overwrite: () => void) => void;
  readonly onError: (workspacePath: string, message: string) => void;
}

// projects.readFile drops a BOM that review.getDiffFileContents keeps, and writeFile restores it.
const withoutBom = (contents: string) =>
  contents.startsWith("\uFEFF") ? contents.slice(1) : contents;

/**
 * Writes diff tool saves back to the server, one at a time per session, and refuses to
 * overwrite a file that changed on the server since it was opened or last written.
 */
export function createDiffToolSync(
  targets: ReadonlyMap<string, DiffToolSyncTarget>,
  deps: DiffToolSyncDeps,
) {
  const synced = new Map([...targets].map(([path, target]) => [path, target.contents]));
  const latest = new Map<string, string>();
  let queue = Promise.resolve();

  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task, task);
    return queue;
  };

  const write = async (path: string, workspacePath: string, contents: string) => {
    const written = await deps.write(workspacePath, contents);
    if (written.ok) synced.set(path, contents);
    else deps.onError(workspacePath, written.message);
  };

  const change = (path: string, contents: string): Promise<void> => {
    latest.set(path, contents);
    return enqueue(async () => {
      const target = targets.get(path);
      const expected = synced.get(path);
      if (target === undefined || expected === undefined) return;
      const remote = await deps.read(target.workspacePath);
      if (!remote.ok) {
        deps.onError(target.workspacePath, remote.message);
        return;
      }
      if (withoutBom(remote.contents) === withoutBom(contents)) {
        synced.set(path, contents);
        return;
      }
      if (withoutBom(remote.contents) !== withoutBom(expected)) {
        // Overwriting writes the newest save, even from an older conflict's prompt.
        deps.onConflict(target.workspacePath, () => {
          void enqueue(() => write(path, target.workspacePath, latest.get(path) ?? contents));
        });
        return;
      }
      await write(path, target.workspacePath, contents);
    });
  };

  return { change };
}
