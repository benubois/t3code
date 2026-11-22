import {
  type DesktopDiffToolEvent,
  DesktopDiffToolOpenInputSchema,
  DesktopDiffToolOpenResultSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { startDiffToolSession } from "../../diffTool/DiffToolSession.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopShellEnvironment from "../../shell/DesktopShellEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const openDiffTool = makeIpcMethod({
  channel: IpcChannels.OPEN_DIFF_TOOL_CHANNEL,
  payload: DesktopDiffToolOpenInputSchema,
  result: DesktopDiffToolOpenResultSchema,
  handler: Effect.fn("desktop.ipc.diffTool.open")(function* (input, event) {
    const window = yield* (yield* ElectronWindow.ElectronWindow).main;
    if (Option.isNone(window) || event?.sender.id !== window.value.webContents.id) {
      return { ok: false as const, message: "Only the app window can open the diff tool." };
    }
    // git resolves the user's tool through PATH, which the login shell supplies.
    yield* (yield* DesktopShellEnvironment.DesktopShellEnvironment).awaitDiscovery;
    const webContents = window.value.webContents;
    const send = (diffToolEvent: DesktopDiffToolEvent) => {
      if (!webContents.isDestroyed()) {
        webContents.send(IpcChannels.DIFF_TOOL_EVENT_CHANNEL, diffToolEvent);
      }
    };
    const { sessionId } = input;
    return yield* Effect.promise(async () => {
      try {
        await startDiffToolSession({
          files: input.files,
          callbacks: {
            onChange: (path, contents) => send({ sessionId, type: "changed", path, contents }),
            onClose: () => send({ sessionId, type: "closed" }),
            onFail: (message) => send({ sessionId, type: "failed", message }),
          },
        });
        return { ok: true as const };
      } catch (error) {
        return {
          ok: false as const,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }),
});
