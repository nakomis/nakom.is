#!/usr/bin/env bash
# Writes the hand-picked aliases in the ticket-projects table, used by
# nakom.is/plane/<alias> [<ref>].
#
#   scripts/seed-ticket-projects.sh [prod|sandbox] [--overwrite]
#
# Every Plane project already answers to its own identifier (home, boot, nakis,
# …): the Plane MCP writes that row when it creates a project, and its
# sync_shortener_projects tool upserts every project including archived ones.
# This script only adds the extra names below, which Plane knows nothing about.
#
# Existing rows are left alone so edits survive a re-run; --overwrite replaces
# the rows listed here. There is deliberately no prune: it would delete the rows
# the MCP writes for projects this script doesn't list.
set -euo pipefail

REGION="eu-west-2"
PLANE="https://plane.home.nakomis.com/nakomis"

ENV="prod"
OVERWRITE=false
for arg in "$@"; do
    case "$arg" in
        prod|sandbox) ENV="$arg" ;;
        --overwrite)  OVERWRITE=true ;;
        *) echo "usage: $0 [prod|sandbox] [--overwrite]" >&2; exit 2 ;;
    esac
done

# The profile is deliberately not inherited from AWS_PROFILE, which may point elsewhere.
case "$ENV" in
    prod)    PROFILE="nakom.is-admin";   TABLE="ticket-projects" ;;
    sandbox) PROFILE="nakom.is-sandbox"; TABLE="ticket-projects-sandbox" ;;
esac

# alias  Plane project identifier  project UUID (from its /projects/<uuid>/issues/ URL)
#
# Renamed in the Taiga → Plane migration, plus friendlier names for projects
# whose identifier is hard to guess.
ALIASES=(
    "nako   NAKIS 20885600-4ad2-4f9e-a465-051cea658dc9"
    "recp   RECIP 2976b5f6-6ddb-4eab-a568-43fb1e0da28e"
    "ltng   LIGHT 1a6a2006-9fba-4f64-8406-02561cdd65ad"
    "nest   STAT  ad6116f9-63ab-4589-823c-618b27e5adfe"
    "blog   BCON  71473687-0e71-4957-9c95-5f1817eb6ca2"
    "lapcat LAPC  6f181c4e-a668-4e6c-a7a7-cd77e4322a67"
)

for entry in "${ALIASES[@]}"; do
    read -r alias identifier uuid <<< "$entry"
    item="{\"alias\": {\"S\": \"$alias\"}, \"urlTemplate\": {\"S\": \"$PLANE/browse/$identifier-{ref}/\"}, \"projectUrl\": {\"S\": \"$PLANE/projects/$uuid/issues/\"}}"
    if $OVERWRITE; then
        AWS_PROFILE="$PROFILE" aws dynamodb put-item --region "$REGION" --table-name "$TABLE" --item "$item"
        echo "set      $alias → $identifier"
    elif err=$(AWS_PROFILE="$PROFILE" aws dynamodb put-item --region "$REGION" --table-name "$TABLE" \
            --item "$item" --condition-expression "attribute_not_exists(alias)" 2>&1); then
        echo "added    $alias → $identifier"
    elif [[ "$err" == *ConditionalCheckFailed* ]]; then
        echo "skipped  $alias (already exists)"
    else
        echo "$err" >&2
        exit 1
    fi
done
