#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
REPO_DIR="$(dirname "$APP_DIR")"
BUCKET="nakom.is-static"

# --- Parse flags ---
BUMP="patch"
for arg in "$@"; do
  case "$arg" in
    --major) BUMP="major" ;;
    --minor) BUMP="minor" ;;
  esac
done

# --- Read current version ---
VERSION_FILE="$APP_DIR/version.json"
CURRENT_VERSION=$(node -e "process.stdout.write(require('$VERSION_FILE').version)")

# Strip -SNAPSHOT suffix
RELEASE_VERSION="${CURRENT_VERSION%-SNAPSHOT}"
if [[ "$RELEASE_VERSION" == "$CURRENT_VERSION" ]]; then
  echo "ERROR: version in version.json is not a SNAPSHOT version: $CURRENT_VERSION"
  exit 1
fi

# Parse semver parts
IFS='.' read -r MAJOR MINOR PATCH <<< "$RELEASE_VERSION"

echo "Preparing release: social/$RELEASE_VERSION"

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

# --- Build ---
echo "Building social-app..."
cd "$APP_DIR"
npm run build

# --- Commit and tag ---
cd "$REPO_DIR"
git add "$VERSION_FILE"
git commit -m "Release social/$RELEASE_VERSION"
git tag "social/$RELEASE_VERSION"

# --- Deploy to S3 / CloudFront ---
DISTRIBUTION_ID=$(aws cloudfront list-distributions --query "DistributionList.Items[?Aliases.Items[?@ == 'nakom.is']].Id" --output text)

echo "Uploading index.html as social.html..."
aws s3 cp "$APP_DIR/dist/index.html" "s3://${BUCKET}/social.html" --content-type "text/html" \
  --cache-control "no-cache, no-store, must-revalidate"

echo "Syncing assets to s3://${BUCKET}/social-app/..."
aws s3 sync "$APP_DIR/dist/assets/" "s3://${BUCKET}/social-app/assets/" --delete \
  --cache-control "public, max-age=31536000, immutable"

echo "Invalidating CloudFront cache..."
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/social" "/static/social-app/*"

# --- Compute next SNAPSHOT ---
case "$BUMP" in
  major) NEXT_VERSION="$((MAJOR + 1)).0.0-SNAPSHOT" ;;
  minor) NEXT_VERSION="${MAJOR}.$((MINOR + 1)).0-SNAPSHOT" ;;
  *)     NEXT_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))-SNAPSHOT" ;;
esac

# --- Bump to next SNAPSHOT ---
echo "{ \"version\": \"$NEXT_VERSION\" }" > "$VERSION_FILE"
git add "$VERSION_FILE"
git commit -m "Bump social to $NEXT_VERSION"

# --- Push ---
git push && git push --tags

echo "Deploy complete! Released social/$RELEASE_VERSION, next: $NEXT_VERSION"
