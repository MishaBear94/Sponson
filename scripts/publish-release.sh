#!/usr/bin/env bash
# Publish every package whose version is not on npm yet, with npm provenance, then tag and push each release.
#
# `changeset publish` runs `pnpm publish`, which never attached provenance (0.4.0–0.6.0 shipped without it), and the
# tags it and `changeset git-tag` reported never reached origin. This script does each step itself and checks it:
#   1. `pnpm pack` per package (rewrites workspace:* and applies publishConfig), dependencies first;
#   2. `npm publish <tarball> --provenance` (needs `id-token: write` in GitHub Actions and NODE_AUTH_TOKEN);
#   3. an annotated tag `<name>@<version>` per package, pushed by its full ref and confirmed with ls-remote.
# DRY_RUN=1 packs and prints what it would publish and tag, and changes nothing.
set -euo pipefail

cd "$(dirname "$0")/.."
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
order=(core sim adapters cli)

published=()
for pkg in "${order[@]}"; do
  dir="packages/$pkg"
  name="$(node -p "require('./$dir/package.json').name")"
  version="$(node -p "require('./$dir/package.json').version")"
  if npm view "$name@$version" version > /dev/null 2>&1; then
    echo "skip   $name@$version (already on npm)"
  else
    tarball="$(cd "$dir" && pnpm pack --pack-destination "$out" | tail -n 1)"
    if [ "${DRY_RUN:-}" = 1 ]; then
      echo "would publish $name@$version from $(basename "$tarball")"
    else
      npm publish "$tarball" --provenance --access public
      echo "published $name@$version"
    fi
  fi
  published+=("$name@$version")
done

for tag in "${published[@]}"; do
  if git ls-remote --exit-code --tags origin "refs/tags/$tag" > /dev/null 2>&1; then
    echo "tag    $tag already on origin"
    continue
  fi
  if [ "${DRY_RUN:-}" = 1 ]; then
    echo "would tag $tag at $(git rev-parse --short HEAD)"
    continue
  fi
  git rev-parse -q --verify "refs/tags/$tag" > /dev/null || git -c user.name="sponson-release" -c user.email="sponson-release@users.noreply.github.com" tag -a "$tag" -m "$tag"
  git push --porcelain origin "refs/tags/$tag:refs/tags/$tag"
  git ls-remote --exit-code --tags origin "refs/tags/$tag" > /dev/null || { echo "::error::pushed $tag but origin does not have it"; exit 1; }
  echo "tagged $tag"
done
