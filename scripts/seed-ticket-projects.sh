#!/usr/bin/env bash
# Seeds the ticket-projects table used by nakom.is/plane/<alias> <ref>.
#
#   scripts/seed-ticket-projects.sh [prod|sandbox] [--overwrite] [--prune]
#
# By default existing rows are left alone, so edits made in the console survive
# a re-run. --overwrite replaces rows listed below; --prune deletes rows whose
# alias isn't listed.
set -euo pipefail

REGION="eu-west-2"
PLANE="https://plane.home.nakomis.com/nakomis/browse"

ENV="prod"
OVERWRITE=false
PRUNE=false
for arg in "$@"; do
    case "$arg" in
        prod|sandbox) ENV="$arg" ;;
        --overwrite)  OVERWRITE=true ;;
        --prune)      PRUNE=true ;;
        *) echo "usage: $0 [prod|sandbox] [--overwrite] [--prune]" >&2; exit 2 ;;
    esac
done

# The profile is deliberately not inherited from AWS_PROFILE, which may point elsewhere.
case "$ENV" in
    prod)    PROFILE="nakom.is-admin";   TABLE="ticket-projects" ;;
    sandbox) PROFILE="nakom.is-sandbox"; TABLE="ticket-projects-sandbox" ;;
esac

# alias  Plane project identifier. Every project answers to its own identifier;
# the extra aliases keep pre-Plane names working.
PROJECTS=(
    "admin ADMIN"   "bapp BAPP"     "bcon BCON"     "boot BOOT"
    "cloud CLOUD"   "crypt CRYPT"   "cssc CSSC"     "fleet FLEET"
    "harm HARM"     "home HOME"     "jobs JOBS"     "kappa KAPPA"
    "kbrd KBRD"     "light LIGHT"   "money MONEY"   "multi MULTI"
    "mush MUSH"     "nakis NAKIS"   "pipe PIPE"     "pish PISH"
    "proj PROJ"     "recip RECIP"   "schim SCHIM"   "scope SCOPE"
    "scrum SCRUM"   "shep SHEP"     "sint SINT"     "stat STAT"
    "tvrm TVRM"
    # Renamed in the Taiga → Plane migration, and friendlier names
    "nako NAKIS"    "recp RECIP"    "ltng LIGHT"    "nest STAT"
    "blog BCON"
)

aws_ddb() {
    AWS_PROFILE="$PROFILE" aws dynamodb "$@" --region "$REGION" --table-name "$TABLE"
}

wanted=()
for entry in "${PROJECTS[@]}"; do
    read -r alias identifier <<< "$entry"
    wanted+=("$alias")
    item="{\"alias\": {\"S\": \"$alias\"}, \"urlTemplate\": {\"S\": \"$PLANE/$identifier-{ref}/\"}}"
    if $OVERWRITE; then
        aws_ddb put-item --item "$item"
        echo "set      $alias → $identifier"
    elif err=$(aws_ddb put-item --item "$item" --condition-expression "attribute_not_exists(alias)" 2>&1); then
        echo "added    $alias → $identifier"
    elif [[ "$err" == *ConditionalCheckFailed* ]]; then
        echo "skipped  $alias (already exists)"
    else
        echo "$err" >&2
        exit 1
    fi
done

if $PRUNE; then
    for existing in $(aws_ddb scan --projection-expression alias --query 'Items[].alias.S' --output text); do
        if [[ " ${wanted[*]} " != *" $existing "* ]]; then
            aws_ddb delete-item --key "{\"alias\": {\"S\": \"$existing\"}}"
            echo "deleted  $existing"
        fi
    done
fi
