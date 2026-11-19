#!/bin/bash
# Keeps this fork on the newest upstream stable release and publishes its Mac
# app to Ad Hoc (~/Sites/release-tools). See fork/README.md.
#
#   fork/release.sh            # move to the newest stable release if there is one, then
#                              # build and publish, unless this commit is already published
#   fork/release.sh --check    # say what would happen; change nothing but fetched tags
#   fork/release.sh --force    # build and publish even if this commit is already published
#
# Exit status: 0 published, or nothing to do; 3 the rebase stopped on conflicts
# (resolve them, `git rebase --continue`, run this again); 4 the checks failed
# on the rebased fork; anything else is a failed step.

set -euo pipefail

# Braced so bash reads the whole script before running it: the rebase below
# may replace this file with another version of itself mid-run.
{

mode=${1:-}
case $mode in ""|--check|--force) ;; *) sed -n '2,13p' "$0"; exit 64 ;; esac

# The profile puts vp, node, cargo and adhoc on PATH; it isn't written for -eu.
set +eu
[[ -f ~/.bash_profile ]] && source ~/.bash_profile
[[ -f ~/.config/vite-plus/env ]] && . ~/.config/vite-plus/env
set -eu

repo=$(cd -P "$(dirname "$0")/.." && pwd)
cd "$repo"
branch=fork/stable
state=${FORK_STATE:-"$HOME/Library/Application Support/t3code-fork"}
stable='^v[0-9]+\.[0-9]+\.[0-9]+$'

[[ $(git branch --show-current) == "$branch" ]] || { echo "Check out $branch first (on $(git branch --show-current))." >&2; exit 65; }
[[ -z $(git status --porcelain --untracked-files=no) ]] || { echo "Uncommitted changes in $repo; commit or stash them first." >&2; exit 65; }
git remote get-url upstream > /dev/null 2>&1 || { echo "No 'upstream' remote; add https://github.com/pingdotgg/t3code." >&2; exit 65; }

git fetch --quiet --tags upstream
latest=$(git tag --list | grep -E "$stable" | sort -V | tail -1)
# The stable release this fork sits on. Not `git describe`: a stable tag shares
# its commit with the nightly it was promoted from.
base=$(git tag --merged HEAD | grep -E "$stable" | sort -V | tail -1)
[[ -n $latest && -n $base ]] || { echo "No stable release tags found." >&2; exit 66; }
patches=$(git rev-list --count "$base..HEAD")
published=$(cat "$state/published" 2> /dev/null || true)

echo "Fork is $patches commits on $base; newest stable release is $latest."
if [[ $mode == --check ]]; then
  if [[ $latest != "$base" ]]; then echo "Would rebase onto $latest, then build and publish."
  elif [[ $published != "$(git rev-parse HEAD)" ]]; then echo "Would build and publish $(git rev-parse --short HEAD)."
  else echo "Nothing to do."; fi
  exit
fi

if [[ $latest != "$base" ]]; then
  echo "→ Rebasing onto $latest"
  if ! git rebase --onto "$latest" "$base" "$branch"; then
    echo "The rebase stopped. Resolve the conflicts, run 'git rebase --continue', then run this again." >&2
    exit 3
  fi
fi

sha=$(git rev-parse HEAD)
if [[ $published == "$sha" && $mode != --force ]]; then
  echo "Nothing to do: $(git rev-parse --short HEAD) is already published."
  exit
fi

version=${latest#v}
stamp=$(date +%Y-%m-%d_%H%M%S)
work=~/Library/Caches/t3code-fork/$stamp
mkdir -p "$work" "$state"

run() {
  local log=$1; shift
  if ! "$@" > "$log" 2>&1; then
    grep -E "ERROR|error:|FAIL" "$log" | grep -v TS377141 | head -30 >&2 || true
    echo "Failed; full log: $log" >&2
    return 1
  fi
}

echo "→ Installing dependencies"
run "$work/install.log" vp i

echo "→ Checking the fork's changes against $latest"
run "$work/check.log" vp run check:changed "$latest" || exit 4

case $(uname -m) in arm64) arch=arm64 ;; *) arch=x64 ;; esac
echo "→ Building T3 Code $version ($arch)"
rm -rf "$repo/release"
# No update repository in the environment: the build then carries no
# upstream update feed. The fork's own feed is added below, before signing.
run "$work/build.log" env -u GITHUB_REPOSITORY -u T3CODE_DESKTOP_UPDATE_REPOSITORY \
  node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch "$arch" --build-version "$version"

# The build is unsigned. With a Developer ID certificate it is signed for
# the hardened runtime and notarized, so it opens on any Mac. Without one it is
# signed with this Mac's development certificate, which still gives every
# build the same identity: macOS permissions and keychain access granted to
# one build carry over to the next.
identities=$(security find-identity -v -p codesigning)
identity=$(sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' <<< "$identities" | sed -n 1p)
[[ -n $identity ]] || identity=$(sed -n 's/.*"\(Apple Development: [^"]*\)".*/\1/p' <<< "$identities" | sed -n 1p)
[[ -n $identity ]] || { echo "No Developer ID or Apple Development signing certificate in the keychain." >&2; exit 67; }
echo "→ Signing as $identity"
zip=$(ls "$repo"/release/*-"$arch".zip)
mkdir "$work/image"
ditto -x -k "$zip" "$work/image"
app=$(ls -d "$work"/image/*.app)
feed_file="$app/Contents/Resources/app-update.yml"
if [[ -f $feed_file ]]; then
  echo "The build carries an upstream update feed; refusing to publish it." >&2
  exit 68
fi
# The app updates itself only from the fork's own feed on the Ad Hoc server,
# which serves the zips published below, never from upstream's releases.
bundle_id=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$app/Contents/Info.plist")
feed=$(adhoc mac-feed "$bundle_id")
[[ $feed == https://* ]] || { echo "No Ad Hoc update feed for $bundle_id: $feed" >&2; exit 69; }
printf "provider: generic\nurl: %s\nupdaterCacheDirName: t3code-updater\n" "$feed" > "$feed_file"
run "$work/sign.log" node fork/sign.mjs "$app" "$identity"
run "$work/verify.log" codesign --verify --deep --strict "$app"
# What the updater installs: the signed app, zipped the way Squirrel.Mac reads it.
update_zip="$work/T3-Code-$version-$arch.zip"
run "$work/zip.log" ditto -c -k --sequesterRsrc --keepParent "$app" "$update_zip"

ln -s /Applications "$work/image/Applications"
dmg="$work/T3-Code-$version-$arch.dmg"
run "$work/dmg.log" hdiutil create -volname "T3 Code $version" -srcfolder "$work/image" -ov -format UDZO "$dmg"
rm -rf "$work/image"
if [[ $identity == "Developer ID Application: "* ]]; then
  run "$work/sign-dmg.log" codesign --sign "$identity" --timestamp "$dmg"
  notarize "$dmg"
else
  echo "Not notarized: this Mac has no Developer ID Application certificate."
fi

echo "→ Publishing to Ad Hoc"
adhoc publish-mac "$dmg" "$update_zip"
echo "$sha" > "$state/published"
echo "Published T3 Code $version, fork commit $(git rev-parse --short HEAD) ($patches commits on $latest). Logs in $work"
exit
}
