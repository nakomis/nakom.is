#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# --- Parse flags ---
BUMP="patch"
for arg in "$@"; do
  case "$arg" in
    --major) BUMP="major" ;;
    --minor) BUMP="minor" ;;
  esac
done

# --- Read current version ---
VERSION_FILE="$REPO_DIR/version.json"
CURRENT_VERSION=$(node -e "process.stdout.write(require('$VERSION_FILE').version)")

# Strip -SNAPSHOT suffix
RELEASE_VERSION="${CURRENT_VERSION%-SNAPSHOT}"
if [[ "$RELEASE_VERSION" == "$CURRENT_VERSION" ]]; then
  echo "ERROR: version in version.json is not a SNAPSHOT version: $CURRENT_VERSION"
  exit 1
fi

# Parse semver parts
IFS='.' read -r MAJOR MINOR PATCH <<< "$RELEASE_VERSION"

echo "Preparing release: infra/$RELEASE_VERSION"

# --- Check git status ---
cd "$REPO_DIR"
if ! git diff --quiet || ! git diff --cached --quiet; then
  read -r -p "Uncommitted changes found. Abort? [Y/n] " REPLY
  REPLY="${REPLY:-Y}"
  if [[ "$REPLY" =~ ^[Yy]$ ]]; then
    echo "Aborting."
    exit 1
  fi
fi

# --- Stamp release version ---
echo "{ \"version\": \"$RELEASE_VERSION\" }" > "$VERSION_FILE"

# --- CDK synth (validate before committing) ---
echo "Running cdk synth..."
cd "$REPO_DIR"
AWS_PROFILE=nakom.is-admin cdk synth

# --- Commit and tag ---
git add "$VERSION_FILE"
git commit -m "Release infra/$RELEASE_VERSION"
git tag "infra/$RELEASE_VERSION"

# --- Deploy ---
echo "Deploying all stacks..."
AWS_PROFILE=nakom.is-admin cdk deploy --all --require-approval never

# --- Compute next SNAPSHOT ---
case "$BUMP" in
  major) NEXT_VERSION="$((MAJOR + 1)).0.0-SNAPSHOT" ;;
  minor) NEXT_VERSION="${MAJOR}.$((MINOR + 1)).0-SNAPSHOT" ;;
  *)     NEXT_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))-SNAPSHOT" ;;
esac

# --- Bump to next SNAPSHOT ---
echo "{ \"version\": \"$NEXT_VERSION\" }" > "$VERSION_FILE"
git add "$VERSION_FILE"
git commit -m "Bump infra to $NEXT_VERSION"

# --- Push ---
git push && git push --tags

echo "Deploy complete! Released infra/$RELEASE_VERSION, next: $NEXT_VERSION"
