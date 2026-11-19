// Signs the built app for the hardened runtime: every binary inside it, with
// the fork's entitlements. Uses the signer upstream's own release build uses.
//
//   node fork/sign.mjs <T3 Code.app> <signing identity>

import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const [app, identity] = process.argv.slice(2);
if (!app || !identity) {
  console.error("usage: node fork/sign.mjs <app> <signing identity>");
  process.exit(64);
}

const fork = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
// The signer is a dependency of the scripts package, not of the repo root.
const require = NodeModule.createRequire(NodePath.join(fork, "..", "scripts", "package.json"));
const { sign } = await import(NodeURL.pathToFileURL(require.resolve("@electron/osx-sign")).href);

await sign({
  app,
  identity,
  batchCodesignCalls: true,
  // Its automatic entitlements name the app and team, which macOS only
  // honors with a provisioning profile; the fork has none.
  preAutoEntitlements: false,
  optionsForFile: () => ({
    hardenedRuntime: true,
    entitlements: NodePath.join(fork, "entitlements.mac.plist"),
  }),
});
