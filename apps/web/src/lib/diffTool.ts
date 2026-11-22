import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  DesktopDiffToolEvent,
  DesktopDiffToolFile,
  EnvironmentId,
  ReviewDiffFileStat,
  ReviewDiffPreviewSourceKind,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { toastManager } from "../components/ui/toast";
import { resolveDiffPathForWorkspace } from "../diffFileActions";
import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { projectEnvironment } from "../state/projects";
import { reviewEnvironment } from "../state/review";
import { createDiffToolSync, type DiffToolSyncTarget } from "./diffToolSync";
import { randomUUID } from "./utils";

export interface OpenDiffInDiffToolInput {
  readonly environmentId: EnvironmentId;
  /** The workspace the diff was read from; saves are written under it. */
  readonly cwd: string;
  readonly repositoryRoot: string | undefined;
  readonly source: {
    readonly kind: ReviewDiffPreviewSourceKind;
    readonly baseRef: string | null;
    readonly headRef: string | null;
  };
  readonly files: ReadonlyArray<ReviewDiffFileStat>;
  readonly editable: boolean;
}

const CONTENTS_CONCURRENCY = 4;

type DiffToolSession = ReturnType<typeof createDiffToolSync>;
const sessions = new Map<string, DiffToolSession>();
let unsubscribe: (() => void) | null = null;

export function canOpenDiffTool(): boolean {
  return typeof window.desktopBridge?.openDiffTool === "function";
}

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  return thrownErrorMessage(squashAtomCommandFailure(result), m) ?? m(msg("An error occurred."));
}

function handleEvent(event: DesktopDiffToolEvent) {
  const session = sessions.get(event.sessionId);
  if (!session) return;
  if (event.type === "changed") {
    void session.change(event.path, event.contents);
    return;
  }
  sessions.delete(event.sessionId);
  if (event.type === "failed") {
    toastManager.add({
      type: "error",
      title: m(msg("The diff tool reported an error")),
      description: event.message,
    });
  }
}

function listen() {
  if (unsubscribe !== null) return;
  unsubscribe = window.desktopBridge?.onDiffToolEvent?.(handleEvent) ?? null;
}

async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<Array<R>> {
  const results: Array<R> = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Opens the diff as one folder compare in the user's local `git difftool`. */
export async function openDiffInDiffTool(input: OpenDiffInDiffToolInput): Promise<void> {
  const bridge = window.desktopBridge;
  if (!bridge?.openDiffTool) return;
  listen();

  const skipped: Array<string> = [];
  const targets = new Map<string, DiffToolSyncTarget>();
  const loaded = await mapWithConcurrency(input.files, CONTENTS_CONCURRENCY, async (file) => {
    const changeType = file.changeType ?? "change";
    const oldPath = file.previousPath ?? file.path;
    const result = await runAtomCommand(
      appAtomRegistry,
      reviewEnvironment.diffFileContents,
      {
        environmentId: input.environmentId,
        input: {
          cwd: input.cwd,
          sourceKind: input.source.kind,
          changeType,
          baseRef: input.source.baseRef,
          headRef: input.source.headRef,
          oldPath,
          newPath: file.path,
        },
      },
      { label: "Read diff file for diff tool", reportFailure: false },
    );
    if (result._tag !== "Success") {
      skipped.push(file.path);
      return null;
    }
    const workspacePath =
      changeType === "deleted"
        ? null
        : resolveDiffPathForWorkspace({
            filePath: file.path,
            workspaceRoot: input.cwd,
            repositoryRoot: input.repositoryRoot,
          });
    const editable = input.editable && workspacePath !== null;
    if (editable) {
      targets.set(file.path, { workspacePath, contents: result.value.newContents });
    }
    return {
      oldPath: changeType === "new" ? null : oldPath,
      newPath: changeType === "deleted" ? null : file.path,
      oldContents: result.value.oldContents,
      newContents: result.value.newContents,
      editable,
    } satisfies DesktopDiffToolFile;
  });
  const files = loaded.filter((file) => file !== null);

  if (files.length === 0) {
    toastManager.add({
      type: "error",
      title: m(msg("Couldn't open the diff tool")),
      description: m(msg("None of these files could be read.")),
    });
    return;
  }

  const sessionId = randomUUID();
  sessions.set(
    sessionId,
    createDiffToolSync(targets, {
      read: async (relativePath) => {
        const result = await executeAtomQuery(
          appAtomRegistry,
          projectEnvironment.readFile({
            environmentId: input.environmentId,
            input: { cwd: input.cwd, relativePath },
          }),
          { label: "Read file before diff tool save", reportFailure: false, refresh: true },
        );
        return result._tag === "Success"
          ? { ok: true, contents: result.value.contents }
          : { ok: false, message: failureMessage(result) };
      },
      write: async (relativePath, contents) => {
        const result = await runAtomCommand(
          appAtomRegistry,
          projectEnvironment.writeFile,
          {
            environmentId: input.environmentId,
            input: { cwd: input.cwd, relativePath, contents },
          },
          { label: "Save from diff tool", reportFailure: false },
        );
        return result._tag === "Success"
          ? { ok: true }
          : { ok: false, message: failureMessage(result) };
      },
      onConflict: (relativePath, overwrite) => {
        const id = toastManager.add({
          type: "warning",
          title: m(msg("{path} changed on the server", { path: relativePath })),
          description: m(msg("Your save from the diff tool wasn't written.")),
          timeout: 0,
          actionProps: {
            children: m(msg("Overwrite", { $context: "verb, replaces the file on the server" })),
            onClick: () => {
              toastManager.close(id);
              overwrite();
            },
          },
        });
      },
      onError: (relativePath, message) => {
        toastManager.add({
          type: "error",
          title: m(msg("Couldn't save {path}", { path: relativePath })),
          description: message,
        });
      },
    }),
  );

  const opened = await bridge.openDiffTool({ sessionId, files });
  if (!opened.ok) {
    sessions.delete(sessionId);
    toastManager.add({
      type: "error",
      title: m(msg("Couldn't open the diff tool")),
      description: opened.message,
    });
    return;
  }
  if (skipped.length > 0) {
    toastManager.add({
      type: "warning",
      title: m(
        msg("{count, plural, one {Left out {count} file} other {Left out {count} files}}", {
          count: skipped.length,
        }),
      ),
      description: m(msg("Binary files and files over 1 MB can't be opened.")),
    });
  }
}
