import type { DeviceScreenSize } from "@t3tools/client-runtime/device/stream";
import type { DeviceDisplayDensity, DevicePlatform } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const DEVICE_SIZING_MODES = ["fit", "point", "pixel", "physical"] as const;
export type DeviceSizingMode = (typeof DEVICE_SIZING_MODES)[number];

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const MIN_ZOOM = ZOOM_STEPS[0]!;
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;

export const DeviceSizing = Schema.Struct({
  mode: Schema.Literals(DEVICE_SIZING_MODES),
  zoom: Schema.Finite.check(Schema.isBetween({ minimum: MIN_ZOOM, maximum: MAX_ZOOM })),
});
export type DeviceSizing = typeof DeviceSizing.Type;

export const DEFAULT_DEVICE_SIZING: DeviceSizing = { mode: "fit", zoom: 1 };

export const deviceSizingStorageKey = (platform: DevicePlatform, deviceName: string) =>
  `t3code:device-sizing:${platform}:${deviceName}`;

/** `scale` is device pixels per point (iOS) or dp (Android); `ppi` is device pixels per inch. */
export interface DeviceDisplayMetrics {
  readonly scale: number;
  readonly ppi: number;
}

export interface HostDisplay {
  readonly devicePixelRatio: number;
  /** Display points per CSS px: the desktop window's zoom, or 1 where it cannot be read. */
  readonly zoomFactor: number;
  /** `unsupported` outside the macOS desktop app; `unreported` when the display gives no size. */
  readonly cssPxPerMm: number | "unsupported" | "loading" | "unreported";
}

interface Size {
  readonly width: number;
  readonly height: number;
}

const androidMetrics = (dpi: number): DeviceDisplayMetrics => ({ scale: dpi / 160, ppi: dpi });

/**
 * A guess from the device name, for hosts that cannot read the density (Expo, Simlock, older servers).
 * Android emulators use their profile's density bucket, which is close to, but not, the real panel PPI.
 * A hinged iOS device is an iPhone Duo whatever its name; the simulator draws both its displays at 3x, 460 ppi.
 */
export function deviceDisplayMetrics(
  platform: DevicePlatform,
  name: string,
  hinged = false,
): DeviceDisplayMetrics | null {
  // Names are matched anywhere so clones and renamed devices ("Clone 1 of iPhone 18") still resolve.
  const words = name.replaceAll("_", " ");
  if (platform === "ios") {
    if (hinged) return { scale: 3, ppi: 460 };
    if (/\bipad mini\b/i.test(words)) return { scale: 2, ppi: 326 };
    if (/\bipad\b/i.test(words)) return { scale: 2, ppi: 264 };
    if (/\biphone (se|xr|11(?! pro))\b/i.test(words)) return { scale: 2, ppi: 326 };
    if (/\biphone\b.*\bmini\b/i.test(words)) return { scale: 3, ppi: 476 };
    if (/\biphone\b/i.test(words)) return { scale: 3, ppi: 460 };
    return null;
  }
  if (/\b(wear|tv|television|automotive)\b/i.test(words)) return null;
  if (/\btablet\b/i.test(words)) return androidMetrics(320);
  return androidMetrics(420);
}

/** The host's reading for the streamed display, else a guess from the device's name. */
export function resolveDeviceDisplayMetrics(input: {
  readonly platform: DevicePlatform;
  readonly name: string;
  readonly screen: DeviceScreenSize | null;
  readonly displays: ReadonlyArray<DeviceDisplayDensity> | undefined;
}): DeviceDisplayMetrics | null {
  // A stream that names no display shows the main one, id 1.
  const screenId = input.screen?.screenId ?? 1;
  const reported = input.displays?.find(
    (display) => display.screenId === undefined || display.screenId === screenId,
  );
  if (reported) return { scale: reported.scale, ppi: reported.ppi };
  return deviceDisplayMetrics(
    input.platform,
    input.name,
    input.screen?.supportsHingeAngle === true,
  );
}

/** The screen's size in device pixels, oriented the way it is displayed. */
export function orientedScreenSize(screen: DeviceScreenSize): Size {
  const long = Math.max(screen.width, screen.height);
  const short = Math.min(screen.width, screen.height);
  const landscape =
    screen.orientation === "landscape_left" || screen.orientation === "landscape_right";
  return landscape ? { width: long, height: short } : { width: short, height: long };
}

export function deviceSizingAvailable(
  mode: DeviceSizingMode,
  metrics: DeviceDisplayMetrics | null,
  host: HostDisplay,
): boolean {
  switch (mode) {
    case "fit":
    case "pixel":
      return true;
    case "point":
      return metrics !== null;
    case "physical":
      return metrics !== null && typeof host.cssPxPerMm === "number";
  }
}

/** Whether the screen is drawn at anything but Fit at 100%; a mode still loading its data counts. */
export function isDeviceSized(
  sizing: DeviceSizing,
  metrics: DeviceDisplayMetrics | null,
  host: HostDisplay,
): boolean {
  if (sizing.zoom !== 1) return true;
  if (sizing.mode === "fit") return false;
  if (sizing.mode === "physical" && metrics !== null && host.cssPxPerMm === "loading") return true;
  return deviceSizingAvailable(sizing.mode, metrics, host);
}

/** The screen's CSS size for a sizing mode; a mode without the data it needs falls back to `fit`. */
export function sizeDeviceScreen(input: {
  readonly sizing: DeviceSizing;
  readonly screen: Size | null;
  readonly metrics: DeviceDisplayMetrics | null;
  readonly host: HostDisplay;
  readonly fit: Size;
}): Size {
  const { sizing, screen, metrics, host } = input;
  const cssPerDevicePixel = (() => {
    if (!screen) return null;
    if (sizing.mode === "pixel") return 1 / host.devicePixelRatio;
    if (sizing.mode === "point" && metrics) return 1 / (metrics.scale * host.zoomFactor);
    if (sizing.mode === "physical" && metrics && typeof host.cssPxPerMm === "number")
      return (25.4 * host.cssPxPerMm) / metrics.ppi;
    return null;
  })();
  const base =
    screen && cssPerDevicePixel !== null
      ? { width: screen.width * cssPerDevicePixel, height: screen.height * cssPerDevicePixel }
      : input.fit;
  return { width: base.width * sizing.zoom, height: base.height * sizing.zoom };
}

export function stepDeviceZoom(zoom: number, direction: "in" | "out"): number {
  const next =
    direction === "in"
      ? ZOOM_STEPS.find((step) => step > zoom + 1e-6)
      : ZOOM_STEPS.findLast((step) => step < zoom - 1e-6);
  return next ?? zoom;
}

export const canStepDeviceZoom = (zoom: number, direction: "in" | "out") =>
  stepDeviceZoom(zoom, direction) !== zoom;

export function deviceScreenReadout(screen: Size, metrics: DeviceDisplayMetrics | null) {
  return {
    pixels: { width: Math.round(screen.width), height: Math.round(screen.height) },
    points: metrics
      ? {
          width: Math.round(screen.width / metrics.scale),
          height: Math.round(screen.height / metrics.scale),
        }
      : null,
    scale: metrics?.scale ?? null,
    diagonalInches: metrics ? Math.hypot(screen.width, screen.height) / metrics.ppi : null,
  };
}
