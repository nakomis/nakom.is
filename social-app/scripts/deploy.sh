#!/usr/bin/env bash
set -euo pipefail

# Deploys social-app to S3 + CloudFront.
#
# Environments:
#   prod    (default) -> bucket nakom.is-static,         CloudFront alias nakom.is
#   sandbox           -> bucket nakom.is-static-sandbox, CloudFront alias sandbox.nakom.is
#
# Select with --sandbox / --prod, or NPM_ENVIRONMENT=sandbox (matching the
# convention used by the cdk npm scripts).
#
# prod cuts a release: it stamps version.json, commits, tags, pushes, then bumps
# to the next SNAPSHOT. sandbox deliberately does none of that: it is a throwaway
# deploy of the current working tree, so you can test before cutting a release.
#
# The AWS account is taken from your profile, so set it to match:
#   AWS_PROFILE=nakom.is-admin    -> prod
#   AWS_PROFILE=nakom.is-sandbox  -> sandbox

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
REPO_DIR="$(dirname "$APP_DIR")"

# --- Parse flags ---
BUMP="patch"
DEPLOY_ENV="${NPM_ENVIRONMENT:-prod}"
for arg in "$@"; do
  case "$arg" in
    --major)   BUMP="major" ;;
    --minor)   BUMP="minor" ;;
    --sandbox) DEPLOY_ENV="sandbox" ;;
    --prod)    DEPLOY_ENV="prod" ;;
  esac
done

case "$DEPLOY_ENV" in
  prod)    SUFFIX="";         CF_ALIAS="nakom.is" ;;
  sandbox) SUFFIX="-sandbox"; CF_ALIAS="sandbox.nakom.is" ;;
  *) echo "ERROR: unknown environment '$DEPLOY_ENV' (expected 'prod' or 'sandbox')" >&2; exit 1 ;;
esac
BUCKET="nakom.is-static${SUFFIX}"

# --- Show what we are about to touch, since there are two accounts ---
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
echo "Environment : $DEPLOY_ENV"
echo "AWS account : $ACCOUNT (profile: ${AWS_PROFILE:-default})"
echo "Bucket      : s3://${BUCKET}"
echo "CloudFront  : alias ${CF_ALIAS}"
echo

VERSION_FILE="$APP_DIR/version.json"

if [[ "$DEPLOY_ENV" == "prod" ]]; then
  # --- Read current version ---
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
else
  echo "Sandbox deploy: skipping version stamp, commit, tag and push."
fi

# --- Build ---
echo "Building social-app..."
cd "$APP_DIR"
npm run build

if [[ "$DEPLOY_ENV" == "prod" ]]; then
  # --- Commit and tag ---
  cd "$REPO_DIR"
  git add "$VERSION_FILE"
  git commit -m "Release social/$RELEASE_VERSION"
  git tag "social/$RELEASE_VERSION"
fi

# --- Deploy to S3 / CloudFront ---
DISTRIBUTION_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Aliases.Items[?@ == '${CF_ALIAS}']].Id" --output text)

if [[ -z "$DISTRIBUTION_ID" || "$DISTRIBUTION_ID" == "None" ]]; then
  echo "ERROR: no CloudFront distribution found with alias '${CF_ALIAS}' in account ${ACCOUNT}." >&2
  echo "       Check AWS_PROFILE matches the target environment." >&2
  exit 1
fi

echo "Uploading index.html as social.html..."
aws s3 cp "$APP_DIR/dist/index.html" "s3://${BUCKET}/social.html" --content-type "text/html" \
  --cache-control "no-cache, no-store, must-revalidate"

echo "Syncing assets to s3://${BUCKET}/social-app/..."
aws s3 sync "$APP_DIR/dist/assets/" "s3://${BUCKET}/social-app/assets/" --delete \
  --cache-control "public, max-age=31536000, immutable"

echo "Invalidating CloudFront cache..."
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/social" "/static/social-app/*"

if [[ "$DEPLOY_ENV" != "prod" ]]; then
  echo
  echo "Sandbox deploy complete: https://${CF_ALIAS}/"
  exit 0
fi

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
