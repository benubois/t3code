// @effect-diagnostics nodeBuiltinImport:off -- This macOS platform boundary asks CoreGraphics for a display's physical size with Node.

import * as NodeChildProcess from "node:child_process";

export interface DisplayMillimeters {
  readonly widthMm: number;
  readonly heightMm: number;
}

const LOOKUP_TIMEOUT_MS = 5_000;

// CoreGraphics registers osascript as a foreground app; go background-only first to avoid a Dock tile.
const LOOKUP_SCRIPT = `
ObjC.import("AppKit");
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
ObjC.import("CoreGraphics");
function run(argv) {
  const size = $.CGDisplayScreenSize(Number(argv[0]));
  return JSON.stringify({ widthMm: size.width, heightMm: size.height });
}`;

/** `displayId` is Electron's display id, which on macOS is the CGDirectDisplayID. */
export function macDisplayMillimeters(displayId: number): Promise<DisplayMillimeters | null> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", LOOKUP_SCRIPT, String(displayId)],
      { timeout: LOOKUP_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout);
          const { widthMm, heightMm } = (parsed ?? {}) as Partial<DisplayMillimeters>;
          // CoreGraphics answers 0×0 for displays without EDID size data, such as some projectors.
          resolve(
            typeof widthMm === "number" &&
              typeof heightMm === "number" &&
              widthMm > 0 &&
              heightMm > 0
              ? { widthMm, heightMm }
              : null,
          );
        } catch {
          resolve(null);
        }
      },
    );
  });
}
