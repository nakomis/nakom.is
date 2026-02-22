#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
BUCKET="nakom.is-static"
DISTRIBUTION_ID=$(aws cloudfront list-distributions --query "DistributionList.Items[?Aliases.Items[?contains(@, 'nakom.is')]].Id" --output text)

echo "Building social-app..."
cd "$APP_DIR"
npm run build

echo "Uploading index.html as social.html..."
aws s3 cp dist/index.html "s3://${BUCKET}/social.html" --content-type "text/html"

echo "Syncing assets to s3://${BUCKET}/social-app/..."
aws s3 sync dist/assets/ "s3://${BUCKET}/social-app/assets/" --delete

echo "Invalidating CloudFront cache..."
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/social" "/static/social-app/*"

echo "Deploy complete!"
