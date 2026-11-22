// @effect-diagnostics nodeBuiltinImport:off -- The test drives real git and a shell-script stand-in tool.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { safeRepositoryPath, startDiffToolSession } from "./DiffToolSession.ts";

// Records what the tool was handed, saves one file through git's right-side link, and saves
// another by replacing the link, as atomic-save editors do.
const FAKE_TOOL = `#!/bin/sh
{
  echo "cwd=$(pwd -P)"
  (cd "$1" && find . -type f | sort | sed 's/^/left /')
  (cd "$2" && find . \\( -type f -o -type l \\) | sort | sed 's/^/right /')
  echo "left-changed=$(cat "$1/src/changed.txt")"
} > "$T3_RECORD"
printf 'edited\\n' > "$2/src/changed.txt"
printf 'replaced\\n' > "$2/.swap" && mv "$2/.swap" "$2/to.txt"
printf 'nope\\n' > "$2/locked.txt" 2>/dev/null || echo "locked-write-refused" >> "$T3_RECORD"
`;

describe("startDiffToolSession", () => {
  it("opens base and current sides as one folder compare and reports saves", async () => {
    const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "difftool-test-"));
    const toolPath = NodePath.join(scratch, "tool.sh");
    const recordPath = NodePath.join(scratch, "record.txt");
    await NodeFSP.writeFile(toolPath, FAKE_TOOL, { mode: 0o755 });

    const changes: Array<[string, string]> = [];
    const closed = Promise.withResolvers<void>();
    await startDiffToolSession({
      files: [
        {
          oldPath: "src/changed.txt",
          newPath: "src/changed.txt",
          oldContents: "before\n",
          newContents: "after\n",
          editable: true,
        },
        {
          oldPath: null,
          newPath: "added.txt",
          oldContents: "",
          newContents: "new\n",
          editable: true,
        },
        {
          oldPath: "gone.txt",
          newPath: null,
          oldContents: "old\n",
          newContents: "",
          editable: false,
        },
        {
          oldPath: "from.txt",
          newPath: "to.txt",
          oldContents: "same\n",
          newContents: "same\n",
          editable: true,
        },
        {
          oldPath: "locked.txt",
          newPath: "locked.txt",
          oldContents: "a\n",
          newContents: "b\n",
          editable: false,
        },
      ],
      saveDebounceMs: 0,
      env: {
        ...process.env,
        T3_RECORD: recordPath,
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "diff.tool",
        GIT_CONFIG_VALUE_0: "fake",
        GIT_CONFIG_KEY_1: "difftool.fake.cmd",
        GIT_CONFIG_VALUE_1: `"${toolPath}" "$LOCAL" "$REMOTE"`,
      },
      callbacks: {
        onChange: (path, contents) => changes.push([path, contents]),
        onClose: () => closed.resolve(),
        onFail: (message) => closed.reject(new Error(message)),
      },
    });
    await closed.promise;

    const record = await NodeFSP.readFile(recordPath, "utf8");
    const root = /^cwd=(.*)$/m.exec(record)?.[1] ?? "";
    expect(record.split("\n").filter((line) => /^(left|right) /.test(line))).toEqual([
      "left ./from.txt",
      "left ./gone.txt",
      "left ./locked.txt",
      "left ./src/changed.txt",
      "right ./added.txt",
      "right ./locked.txt",
      "right ./src/changed.txt",
      "right ./to.txt",
    ]);
    expect(record).toContain("left-changed=before");
    expect(record).toContain("locked-write-refused");
    expect(changes.toSorted()).toEqual([
      ["src/changed.txt", "edited\n"],
      ["to.txt", "replaced\n"],
    ]);
    expect(root).toContain("t3code-difftool-");
    expect(NodeFS.existsSync(root)).toBe(false);
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  });

  it("refuses paths that leave the temp repo or reach into its .git", async () => {
    expect(safeRepositoryPath("src/./a.ts")).toBe("src/a.ts");
    for (const path of [
      "../outside",
      "/etc/passwd",
      ".git/hooks/post-commit",
      "a/.GIT/config",
      "",
    ]) {
      expect(safeRepositoryPath(path)).toBeNull();
    }
    await expect(
      startDiffToolSession({
        files: [
          {
            oldPath: null,
            newPath: "../escape",
            oldContents: "",
            newContents: "x",
            editable: true,
          },
        ],
        callbacks: { onChange: () => {}, onClose: () => {}, onFail: () => {} },
      }),
    ).rejects.toThrow("unsafe path");
  });
});
