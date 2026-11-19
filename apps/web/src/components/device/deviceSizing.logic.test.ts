import { describe, expect, it } from "vite-plus/test";

import {
  deviceDisplayMetrics,
  deviceScreenReadout,
  isDeviceSized,
  orientedScreenSize,
  resolveDeviceDisplayMetrics,
  sizeDeviceScreen,
  stepDeviceZoom,
  type DeviceSizingMode,
} from "./deviceSizing.logic";

describe("device sizing", () => {
  const iphone = { width: 1206, height: 2622 };
  const fit = { width: 300, height: 652 };
  const retina = { devicePixelRatio: 2, zoomFactor: 1, cssPxPerMm: 1920 / 369.45 };
  const noPhysical = { devicePixelRatio: 2, zoomFactor: 1, cssPxPerMm: "unreported" } as const;

  it.each<[DeviceSizingMode, number, { width: number; height: number }]>([
    ["fit", 1, fit],
    ["point", 1, { width: 402, height: 874 }],
    ["pixel", 1, { width: 603, height: 1311 }],
    // 1206 px / 460 ppi = 2.62 in = 66.6 mm, at 5.197 CSS px per mm.
    ["physical", 1, { width: 346.1, height: 752.4 }],
    ["point", 1.5, { width: 603, height: 1311 }],
    ["fit", 0.5, { width: 150, height: 326 }],
  ])("sizes an iPhone screen in %s mode at %sx", (mode, zoom, expected) => {
    const size = sizeDeviceScreen({
      sizing: { mode, zoom },
      screen: iphone,
      metrics: deviceDisplayMetrics("ios", "iPhone 18 Pro"),
      host: retina,
      fit,
    });
    expect(size.width).toBeCloseTo(expected.width, 0);
    expect(size.height).toBeCloseTo(expected.height, 0);
  });

  it("falls back to fit when a mode lacks its data", () => {
    const base = { screen: iphone, fit, host: noPhysical };
    expect(
      sizeDeviceScreen({ ...base, sizing: { mode: "physical", zoom: 1 }, metrics: null }),
    ).toEqual(fit);
    expect(
      sizeDeviceScreen({
        ...base,
        sizing: { mode: "physical", zoom: 1 },
        metrics: deviceDisplayMetrics("ios", "iPhone 18 Pro"),
      }),
    ).toEqual(fit);
    expect(
      sizeDeviceScreen({ ...base, sizing: { mode: "point", zoom: 1 }, metrics: null }),
    ).toEqual(fit);
    expect(
      sizeDeviceScreen({
        ...base,
        screen: null,
        sizing: { mode: "pixel", zoom: 1 },
        metrics: null,
      }),
    ).toEqual(fit);
  });

  it.each([
    ["ios", "iPhone 18 Pro", { scale: 3, ppi: 460 }],
    ["ios", "iPhone 13 mini", { scale: 3, ppi: 476 }],
    ["ios", "iPhone SE (3rd generation)", { scale: 2, ppi: 326 }],
    ["ios", "iPad Pro 13-inch (M5)", { scale: 2, ppi: 264 }],
    ["ios", "iPad mini (A17 Pro)", { scale: 2, ppi: 326 }],
    ["ios", "Apple Watch Series 11 (46mm)", null],
    ["ios", "iPhone 11", { scale: 2, ppi: 326 }],
    ["ios", "iPhone 11 Pro", { scale: 3, ppi: 460 }],
    ["ios", "Clone 1 of iPhone 18 Pro", { scale: 3, ppi: 460 }],
    ["android", "Pixel_9", { scale: 2.625, ppi: 420 }],
    ["android", "Pixel_Tablet", { scale: 2, ppi: 320 }],
    ["android", "Wear_OS_Large_Round", null],
  ] as const)("reads %s %s display metrics", (platform, name, expected) => {
    expect(deviceDisplayMetrics(platform, name)).toEqual(expected);
  });

  it("prefers the host's reading for the streamed display over the device name", () => {
    const portrait = { width: 2007, height: 2853, orientation: "portrait" } as const;
    const displays = [
      { screenId: 1, scale: 3, ppi: 460 },
      { screenId: 3, scale: 2, ppi: 300 },
    ];
    const resolve = (screen: Parameters<typeof resolveDeviceDisplayMetrics>[0]["screen"]) =>
      resolveDeviceDisplayMetrics({ platform: "ios", name: "Reflex Duo", screen, displays });
    expect(resolve({ ...portrait, screenId: 3 })).toEqual({ scale: 2, ppi: 300 });
    expect(resolve(portrait)).toEqual({ scale: 3, ppi: 460 });
    expect(
      resolveDeviceDisplayMetrics({
        platform: "android",
        name: "My phone",
        screen: null,
        displays: [{ scale: 3, ppi: 410 }],
      }),
    ).toEqual({ scale: 3, ppi: 410 });
  });

  it("falls back to the name, or the hinge for a renamed iPhone Duo, without a host reading", () => {
    const screen = { width: 1398, height: 2034, orientation: "portrait" } as const;
    const resolve = (supportsHingeAngle: boolean) =>
      resolveDeviceDisplayMetrics({
        platform: "ios",
        name: "Reflex Duo",
        screen: { ...screen, supportsHingeAngle },
        displays: undefined,
      });
    expect(resolve(false)).toBeNull();
    expect(resolve(true)).toEqual({ scale: 3, ppi: 460 });
  });

  it("keeps point size in display points when the desktop window is zoomed", () => {
    const size = sizeDeviceScreen({
      sizing: { mode: "point", zoom: 1 },
      screen: iphone,
      metrics: deviceDisplayMetrics("ios", "iPhone 18 Pro"),
      // At 125% zoom a CSS px covers 1.25 points and devicePixelRatio rises with it.
      host: { devicePixelRatio: 2.5, zoomFactor: 1.25, cssPxPerMm: "unsupported" },
      fit,
    });
    expect(size.width).toBeCloseTo(402 / 1.25, 3);
  });

  it("counts as sized only when the screen is not drawn at Fit at 100%", () => {
    const metrics = deviceDisplayMetrics("ios", "iPhone 18 Pro");
    expect(isDeviceSized({ mode: "fit", zoom: 1 }, metrics, retina)).toBe(false);
    expect(isDeviceSized({ mode: "fit", zoom: 1.5 }, metrics, retina)).toBe(true);
    expect(isDeviceSized({ mode: "physical", zoom: 1 }, metrics, retina)).toBe(true);
    // A mode that fell back to Fit must not block the 3D view.
    expect(isDeviceSized({ mode: "physical", zoom: 1 }, metrics, noPhysical)).toBe(false);
    expect(isDeviceSized({ mode: "point", zoom: 1 }, null, retina)).toBe(false);
    // While the display's size is still being read, 3D must not flash in.
    expect(
      isDeviceSized({ mode: "physical", zoom: 1 }, metrics, { ...retina, cssPxPerMm: "loading" }),
    ).toBe(true);
  });

  it("orients the framebuffer the way the device shows it", () => {
    expect(orientedScreenSize({ ...iphone, orientation: "landscape_left" })).toEqual({
      width: 2622,
      height: 1206,
    });
    expect(
      orientedScreenSize({ width: 2622, height: 1206, orientation: "portrait_upside_down" }),
    ).toEqual(iphone);
  });

  it("steps zoom through fixed stops and stops at the ends", () => {
    expect(stepDeviceZoom(1, "in")).toBe(1.1);
    expect(stepDeviceZoom(1, "out")).toBe(0.9);
    expect(stepDeviceZoom(1.2, "in")).toBe(1.25);
    expect(stepDeviceZoom(4, "in")).toBe(4);
    expect(stepDeviceZoom(0.25, "out")).toBe(0.25);
  });

  it("reads points and diagonal from pixels", () => {
    const readout = deviceScreenReadout(iphone, deviceDisplayMetrics("ios", "iPhone 18 Pro"));
    expect(readout.points).toEqual({ width: 402, height: 874 });
    expect(readout.diagonalInches).toBeCloseTo(6.27, 2);
  });
});
