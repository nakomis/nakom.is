#!/usr/bin/env bash
# Seeds the ticket-projects table used by nakom.is/taiga/<alias> <ref>.
# Existing rows are left alone, so edits made in the console survive a re-run.
set -euo pipefail

PROFILE="${AWS_PROFILE:-nakom.is-admin}"
REGION="eu-west-2"
TABLE="ticket-projects"
TAIGA="https://taiga.home.nakomis.com/project"

# alias  project slug
PROJECTS=(
    "home   home-infrastructure"
    "nest   nest"
    "boot   bootboots"
    "blog   blog-posts"
    "proj   projects"
    "shep   claude-shepherd"
    "jobs   jobs"
    "misc   misc"
    "garden garden"
    "btb    boot-the-boots"
    "mush   mushroom-humidor"
    "taiga  taiga"
    "sint   sinter"
)

for entry in "${PROJECTS[@]}"; do
    read -r alias slug <<< "$entry"
    if err=$(AWS_PROFILE="$PROFILE" aws dynamodb put-item \
        --region "$REGION" \
        --table-name "$TABLE" \
        --item "{\"alias\": {\"S\": \"$alias\"}, \"urlTemplate\": {\"S\": \"$TAIGA/$slug/us/{ref}\"}}" \
        --condition-expression "attribute_not_exists(alias)" 2>&1); then
        echo "added    $alias → $slug"
    elif [[ "$err" == *ConditionalCheckFailed* ]]; then
        echo "skipped  $alias (already exists)"
    else
        echo "$err" >&2
        exit 1
    fi
done
