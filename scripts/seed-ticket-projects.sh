#!/usr/bin/env bash
# Seeds the ticket-projects table used by nakom.is/plane/<alias> [<ref>].
#
#   scripts/seed-ticket-projects.sh [prod|sandbox] [--overwrite] [--prune]
#
# By default existing rows are left alone, so edits made in the console survive
# a re-run. --overwrite replaces rows listed below; --prune deletes rows whose
# alias isn't listed.
set -euo pipefail

REGION="eu-west-2"
PLANE="https://plane.home.nakomis.com/nakomis"

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

# alias  Plane project identifier  project UUID (from its /projects/<uuid>/issues/ URL).
# Every project answers to its own identifier; the extra aliases keep other names working.
PROJECTS=(
    "admin  ADMIN ee46ebde-00bc-40a9-ab82-99c39848babc"
    "bapp   BAPP  49425628-12f4-4a9b-a5a6-233a5abf4591"
    "bcon   BCON  71473687-0e71-4957-9c95-5f1817eb6ca2"
    "boot   BOOT  7fe39297-f4ef-4fab-9e3f-6f0bd4fce526"
    "cloud  CLOUD a0823015-6611-4d78-9903-cde1e3f0576c"
    "crypt  CRYPT 76bb9560-f39e-4ed7-8d2b-da8e96775b23"
    "cssc   CSSC  ed6512f8-1dfe-4493-93d7-bdf2a8a0cf2d"
    "fleet  FLEET 5190b421-6e30-4bb8-88c3-6e14cad20941"
    "harm   HARM  a4dd1c6d-d448-4106-8d20-0342ca9f79cb"
    "home   HOME  b709434e-ddb5-41b1-a35a-063c9247c52a"
    "jobs   JOBS  1bc05a35-7766-459b-bf28-0d13e057ce44"
    "kappa  KAPPA 8536efc0-5739-4cf0-b82a-f1a399459cdf"
    "kbrd   KBRD  814e95de-7020-4167-9fd7-55594a34c0bd"
    "lapc   LAPC  6f181c4e-a668-4e6c-a7a7-cd77e4322a67"
    "light  LIGHT 1a6a2006-9fba-4f64-8406-02561cdd65ad"
    "money  MONEY 4a7732bd-d55f-426e-b32d-2b3e19686307"
    "multi  MULTI 19c95c13-2c3b-4c33-a5f9-614cd90fcc87"
    "mush   MUSH  a16cbb50-0489-4e77-9a0e-30e056f82c01"
    "nakis  NAKIS 20885600-4ad2-4f9e-a465-051cea658dc9"
    "pipe   PIPE  e05ec71a-db6f-4d14-aa0f-cd9edba963bf"
    "pish   PISH  47324f04-751f-4cd0-9216-699d97239129"
    "proj   PROJ  368b7ee9-5e0e-49e4-bf0e-044eb54fd8d9"
    "recip  RECIP 2976b5f6-6ddb-4eab-a568-43fb1e0da28e"
    "schim  SCHIM 983ef362-4969-4ba1-b20f-8e17e87cce30"
    "scope  SCOPE 6b195858-c2e2-4f56-b260-ca070426e2d8"
    "scrum  SCRUM cc9bfebb-8466-4f0b-968a-168a27fc2a20"
    "shep   SHEP  8f105339-3e39-4750-9fd9-f3c3d34f3f96"
    "sint   SINT  f42da44b-b17a-4a94-a044-7721ae59eaa8"
    "stat   STAT  ad6116f9-63ab-4589-823c-618b27e5adfe"
    "tvrm   TVRM  f9193a4a-89dc-44dc-bec9-8dd8e1998617"
    # Renamed in the Taiga → Plane migration, and friendlier names
    "nako   NAKIS 20885600-4ad2-4f9e-a465-051cea658dc9"
    "recp   RECIP 2976b5f6-6ddb-4eab-a568-43fb1e0da28e"
    "ltng   LIGHT 1a6a2006-9fba-4f64-8406-02561cdd65ad"
    "nest   STAT  ad6116f9-63ab-4589-823c-618b27e5adfe"
    "blog   BCON  71473687-0e71-4957-9c95-5f1817eb6ca2"
    "lapcat LAPC  6f181c4e-a668-4e6c-a7a7-cd77e4322a67"
)

aws_ddb() {
    AWS_PROFILE="$PROFILE" aws dynamodb "$@" --region "$REGION" --table-name "$TABLE"
}

wanted=()
for entry in "${PROJECTS[@]}"; do
    read -r alias identifier uuid <<< "$entry"
    wanted+=("$alias")
    item="{\"alias\": {\"S\": \"$alias\"}, \"urlTemplate\": {\"S\": \"$PLANE/browse/$identifier-{ref}/\"}, \"projectUrl\": {\"S\": \"$PLANE/projects/$uuid/issues/\"}}"
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
