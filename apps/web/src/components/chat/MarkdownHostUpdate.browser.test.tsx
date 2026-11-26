import { EnvironmentId } from "@t3tools/contracts";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { MarkdownHostUpdate, parseHostUpdateHref } from "./MarkdownHostUpdate";

const HOST = EnvironmentId.make("host");

const state = vi.hoisted(() => ({
  config: undefined as unknown,
  update: null as unknown,
  requested: [] as Array<Record<string, unknown>>,
}));
vi.mock(import("../../state/entities"), () => ({
  useServerConfigs: (() => new Map([[HOST, state.config]])) as never,
}));
vi.mock(import("../../state/server"), () => ({
  serverEnvironment: { updateStateAtom: () => state.update } as never,
}));
vi.mock(import("../ServerUpdateAction"), () => ({
  serverUpdateStageLabel: (stage: string) => `Stage: ${stage}`,
  ServerUpdateAction: ((props: Record<string, unknown>) => {
    state.requested.push(props);
    return <button type="button">{props.label as string}</button>;
  }) as never,
}));

function host(serverVersion: string, serverSelfUpdate: string | undefined = "desktop-managed") {
  state.config = {
    environment: {
      label: "Studio",
      serverVersion,
      capabilities: { serverSelfUpdate, desktopAppUpdate: true },
    },
  };
}

function updating(update: ServerUpdateState) {
  state.update = Atom.make(update);
}

function setup() {
  state.requested = [];
  updating({ status: "idle" });
}

describe("parseHostUpdateHref", () => {
  it("reads the version from an update link and ignores every other link", () => {
    expect(parseHostUpdateHref("t3-update:0.1.13")).toBe("0.1.13");
    expect(parseHostUpdateHref("t3-update:0.2.0-nightly.1")).toBe("0.2.0-nightly.1");
    expect(parseHostUpdateHref("t3-update:")).toBeNull();
    expect(parseHostUpdateHref("t3-update:latest")).toBeNull();
    expect(parseHostUpdateHref("https://example.com/t3-update:0.1.13")).toBeNull();
  });
});

it("offers an older host's desktop app the update to the linked version", async () => {
  setup();
  host("0.1.12");
  await using screen = await render(<MarkdownHostUpdate environmentId={HOST} version="0.1.13" />);
  await expect
    .element(screen.getByRole("button", { name: "Update T3 Code to 0.1.13" }))
    .toBeVisible();
  expect(state.requested.at(-1)).toMatchObject({
    environmentId: HOST,
    serverLabel: "Studio server",
    selfUpdate: "desktop-managed",
    desktopAppUpdate: true,
    targetVersion: "0.1.13",
  });
});

it("says the version is installed once the host runs it", async () => {
  setup();
  host("0.1.13");
  await using screen = await render(<MarkdownHostUpdate environmentId={HOST} version="0.1.13" />);
  await expect.element(screen.getByText("T3 Code 0.1.13 is installed")).toBeVisible();
  expect(state.requested).toHaveLength(0);
});

const VERSIONS = { fromVersion: "0.1.12", targetVersion: "0.1.13" };

it("shows the update's stage while the host updates", async () => {
  setup();
  host("0.1.12");
  updating({ status: "running", stage: "downloading", ...VERSIONS });
  await using screen = await render(<MarkdownHostUpdate environmentId={HOST} version="0.1.13" />);
  await expect.element(screen.getByText("Stage: downloading")).toBeVisible();
  expect(state.requested).toHaveLength(0);
});

it("offers a retry after the update fails", async () => {
  setup();
  host("0.1.12");
  updating({ status: "failed", stage: "downloading", ...VERSIONS, message: "Offline" });
  await using screen = await render(<MarkdownHostUpdate environmentId={HOST} version="0.1.13" />);
  await expect.element(screen.getByRole("button", { name: "Retry update" })).toBeVisible();
});

it("names the update without a button when the host is no desktop app", async () => {
  setup();
  host("0.1.12", "boot-service");
  await using screen = await render(<MarkdownHostUpdate environmentId={HOST} version="0.1.13" />);
  await expect.element(screen.getByText("Update T3 Code to 0.1.13 on its Mac")).toBeVisible();
  expect(state.requested).toHaveLength(0);
});
