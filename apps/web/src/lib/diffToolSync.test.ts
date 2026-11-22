import { describe, expect, it } from "vite-plus/test";

import { createDiffToolSync } from "./diffToolSync";

function setup(serverContents: string, opened = "opened\n") {
  const server = { contents: serverContents };
  const writes: Array<string> = [];
  const conflicts: Array<() => void> = [];
  const sync = createDiffToolSync(
    new Map([["repo/a.ts", { workspacePath: "a.ts", contents: opened }]]),
    {
      read: async () => ({ ok: true, contents: server.contents }),
      write: async (_path, contents) => {
        writes.push(contents);
        server.contents = contents;
        return { ok: true };
      },
      onConflict: (_path, overwrite) => conflicts.push(overwrite),
      onError: () => {},
    },
  );
  return { server, writes, conflicts, sync };
}

describe("createDiffToolSync", () => {
  it("writes saves while the server still has what was opened", async () => {
    const { writes, conflicts, sync } = setup("\uFEFFopened\n");
    await sync.change("repo/a.ts", "one\n");
    await sync.change("repo/a.ts", "two\n");
    await sync.change("repo/unknown.ts", "ignored\n");
    expect(writes).toEqual(["one\n", "two\n"]);
    expect(conflicts).toEqual([]);
  });

  it("holds a save when the server file changed, and overwrites with the newest save", async () => {
    const { server, writes, conflicts, sync } = setup("agent edit\n");
    await sync.change("repo/a.ts", "mine\n");
    await sync.change("repo/a.ts", "mine again\n");
    expect(writes).toEqual([]);
    expect(conflicts).toHaveLength(2);

    conflicts[0]?.();
    await sync.change("repo/a.ts", "mine again\n");
    expect(writes).toEqual(["mine again\n"]);
    expect(server.contents).toBe("mine again\n");
  });

  it("accepts a save that matches the server without writing", async () => {
    const { writes, conflicts, sync } = setup("merged\n");
    await sync.change("repo/a.ts", "merged\n");
    await sync.change("repo/a.ts", "next\n");
    expect(writes).toEqual(["next\n"]);
    expect(conflicts).toEqual([]);
  });
});
