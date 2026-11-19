import type { DesktopDisplayPhysicalSize } from "@t3tools/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";

import type { HostDisplay } from "./deviceSizing.logic";

const readDevicePixelRatio = () => window.devicePixelRatio || 1;

// A resolution query matches one ratio, so each change re-arms a query for the new one.
function subscribeDevicePixelRatio(onChange: () => void) {
  let query: MediaQueryList | null = null;
  const listen = () => {
    query = window.matchMedia(`(resolution: ${readDevicePixelRatio()}dppx)`);
    query.addEventListener("change", handleChange, { once: true });
  };
  const handleChange = () => {
    onChange();
    listen();
  };
  listen();
  return () => query?.removeEventListener("change", handleChange);
}

/** The host display's density; its physical size is read only while `active`. */
export function useHostDisplay(active: boolean): HostDisplay {
  const devicePixelRatio = useSyncExternalStore(
    subscribeDevicePixelRatio,
    readDevicePixelRatio,
    readDevicePixelRatio,
  );
  const [physical, setPhysical] = useState<{
    readonly size: DesktopDisplayPhysicalSize | null;
  } | null>(null);
  const bridge = window.desktopBridge;
  const read = bridge?.getClientPlatform() === "darwin" ? bridge.getDisplayPhysicalSize : undefined;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the display's size from the desktop main process and follows display changes
  useEffect(() => {
    if (!active || !read) return;
    // Only the latest read may land: a slow lookup for a display the window already left must not win.
    const reads = { latest: 0 };
    const refresh = () => {
      reads.latest += 1;
      const request = reads.latest;
      void read().then(
        (size) => {
          if (request === reads.latest) setPhysical({ size });
        },
        () => {
          if (request === reads.latest) setPhysical({ size: null });
        },
      );
    };
    refresh();
    const unsubscribe = bridge?.onDisplayChange?.(refresh);
    return () => {
      reads.latest = -1;
      unsubscribe?.();
    };
  }, [active, bridge, read]);

  // Chromium zoom changes devicePixelRatio too, which re-renders this with the new factor.
  const zoomFactor = bridge?.getWindowZoomFactor() ?? 1;
  const size = physical?.size;
  return {
    devicePixelRatio,
    zoomFactor,
    cssPxPerMm: !read
      ? "unsupported"
      : physical === null
        ? "loading"
        : size
          ? // The diagonal holds for rotated displays, whichever way the millimetres are reported.
            Math.hypot(size.widthPoints, size.heightPoints) /
            Math.hypot(size.widthMm, size.heightMm) /
            zoomFactor
          : "unreported",
  };
}
