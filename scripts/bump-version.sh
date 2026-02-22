#!/bin/bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 0.2.0"
  exit 1
fi

VERSION="$1"

# Validate semver format
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: Version must be in semver format (e.g., 0.2.0)"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

CARGO_TOML="$ROOT_DIR/src-tauri/Cargo.toml"
TAURI_CONF="$ROOT_DIR/src-tauri/tauri.conf.json"

# Update Cargo.toml version
sed -i '' "s/^version = \".*\"/version = \"$VERSION\"/" "$CARGO_TOML"
echo "Updated $CARGO_TOML -> $VERSION"

# Update tauri.conf.json version
sed -i '' "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" "$TAURI_CONF"
echo "Updated $TAURI_CONF -> $VERSION"

echo ""
echo "Version bumped to $VERSION"
echo "Next steps:"
echo "  git add -A && git commit -m \"Bump version to $VERSION\""
echo "  git tag v$VERSION"
echo "  git push && git push --tags"
