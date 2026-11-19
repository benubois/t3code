# This fork

A personal fork of [T3 Code](https://github.com/pingdotgg/t3code) that follows
upstream's stable releases. The branch `fork/stable` is the newest stable
release tag (`vX.Y.Z`) plus a short stack of commits: one per feature, and one
for this folder. Nothing else differs from upstream, so the app keeps
upstream's name, bundle ID and data (`~/.t3`): it replaces the official app
rather than sitting beside it.

## A new stable release

`fork/release.sh` does the whole job, and does nothing when there is nothing
to do, so it can run every day:

1. Fetches upstream's tags and finds the newest stable release.
2. If the fork sits on an older one, rebases the stack onto the new tag.
3. Runs `vp run check:changed <tag>` on the fork's changes.
4. Builds the Mac app as that version, with no upstream update feed, so the
   app never updates itself back to an upstream build.
5. Signs every binary in it for the hardened runtime (`fork/sign.mjs`, with
   `fork/entitlements.mac.plist`) using this Mac's Developer ID Application
   certificate, and notarizes the disk image (`notarize`, in
   `~/Sites/release-tools`), so it opens on any Mac. Without that certificate
   it signs with the Apple Development one and skips notarizing. Either way
   every build has the same identity, so macOS permissions and keychain access
   carry over from one build to the next.
6. Publishes the disk image with `adhoc publish-mac` (`~/Sites/release-tools`);
   Ad Hoc on the Mac lists it. The app zipped goes with it, for the app's own
   updater: the build's `app-update.yml` points at the fork's feed on the Ad
   Hoc server (`adhoc mac-feed`), so the installed app updates itself to the
   next fork build, and never to an upstream one. It offers only a newer
   version, so a fork-only rebuild on the same release is installed from Ad
   Hoc by hand.

`fork/release.sh --check` only reports. The script exits 3 when the rebase
stops on conflicts, and 4 when the checks fail after it.

## When the rebase stops

Upstream moves fast, and a stable release is hundreds of commits behind
`main`, so conflicts are expected. Each commit in the stack is a whole
feature; resolve toward what the feature does, not toward the old lines:

- Take upstream's version of the surrounding code and put the feature back on
  top of it. Prefer that to keeping the fork's copy of a file upstream rewrote.
- Translation catalogs (`apps/*/src/i18n/translations`) are generated. Take
  upstream's, run `vp run --filter @t3tools/web i18n:generate`, and translate
  the keys the feature adds. Where upstream's stable code has no translation
  calls yet, the feature uses plain strings.
- After `git rebase --continue`, run `fork/release.sh` again. It reruns the
  checks; fix what they find in the commit that owns it (`git commit --fixup`,
  `git rebase --autosquash`).

## Adding a feature

Branch from `fork/stable`, not from `main`: code written against `main` has to
be ported back to the stable release (the first feature was). Keep the feature
in new files where it can live there, with tests beside it, and squash it to
one commit on `fork/stable`. To offer it upstream, cherry-pick that commit onto
a branch from `upstream/main`.

## What the build needs on this Mac

Vite+ (`vp`), Rust (`brew install rust`), a Developer ID Application
certificate in the login keychain (only the team's Account Holder can make
one: Xcode, Settings, Accounts, Manage Certificates), the App Store Connect
API key from `testflight-setup`, and `adhoc` set up (`adhoc-setup`).

## What this build leaves out

- T3 Connect, on purpose: the build has no `.env`, so it carries no T3 account
  sign-in or relay URL. Direct connections (local network, Tailscale) don't
  need them. Don't add a `.env` to turn it on without asking.
- Passkeys and the browser passkey bridge: their entitlements need a
  provisioning profile for upstream's bundle ID, which only upstream's team
  can have.
- Upstream's update feed, on purpose (see above), and upstream's telemetry.
- Intel Macs: the build is for this Mac's architecture only.
