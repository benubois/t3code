import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { useGT, useMessages } from "gt-react";

import { useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { resolveServerSelfUpdateCapability, supportsDesktopAppUpdate } from "../../versionSkew";
import { ServerUpdateAction, serverUpdateStageLabel } from "../ServerUpdateAction";

const HOST_UPDATE_HREF = /^t3-update:(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u;

/** The version a `t3-update:X.Y.Z` link offers, or null for any other link. */
export function parseHostUpdateHref(href: string): string | null {
  return HOST_UPDATE_HREF.exec(href)?.[1] ?? null;
}

/** Updates the T3 Code desktop app that hosts the thread, wherever this client runs. */
export function MarkdownHostUpdate({
  environmentId,
  version,
}: {
  readonly environmentId: EnvironmentId;
  readonly version: string;
}) {
  const gt = useGT();
  const messages = useMessages();
  const config = useServerConfigs().get(environmentId);
  const updateState = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const serverVersion = config?.environment.serverVersion;

  if (serverVersion !== undefined && compareSemverVersions(serverVersion, version) >= 0) {
    return (
      <span className="text-muted-foreground">
        {gt("T3 Code {version} is installed", { version: serverVersion })}
      </span>
    );
  }
  if (resolveServerSelfUpdateCapability(config) !== "desktop-managed") {
    return (
      <span className="text-muted-foreground">
        {gt("Update T3 Code to {version} on its Mac", { version })}
      </span>
    );
  }
  if (updateState.status === "running") {
    return (
      <span className="text-muted-foreground">
        {serverUpdateStageLabel(updateState.stage, messages)}
      </span>
    );
  }
  return (
    <ServerUpdateAction
      environmentId={environmentId}
      serverLabel={gt("{label} server", {
        label: config?.environment.label ?? environmentId,
        $context: "names a T3 server inside sentences such as {serverLabel} updated",
      })}
      selfUpdate="desktop-managed"
      desktopAppUpdate={supportsDesktopAppUpdate(config)}
      targetVersion={version}
      label={
        updateState.status === "failed"
          ? gt("Retry update")
          : gt("Update T3 Code to {version}", { version })
      }
      variant="default"
      size="sm"
    />
  );
}
