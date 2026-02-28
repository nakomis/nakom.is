#!/bin/bash

# Script to populate config.json from CloudFormation outputs and environment variables

set -e

CONFIG_FILE="config.json"
TEMPLATE_FILE="config.template.json"
AWS_PROFILE="${AWS_PROFILE:-nakom.is-admin}"

echo "Setting up configuration..."

# Start with template
if [ ! -f "$TEMPLATE_FILE" ]; then
    echo "Error: $TEMPLATE_FILE not found"
    exit 1
fi

# Copy template to config if it doesn't exist
if [ ! -f "$CONFIG_FILE" ]; then
    echo "Creating $CONFIG_FILE from template..."
    cp "$TEMPLATE_FILE" "$CONFIG_FILE"
fi

# Function to update JSON value
update_json() {
    local key="$1"
    local value="$2"

    if command -v jq >/dev/null 2>&1; then
        # Use jq if available
        tmp=$(mktemp)
        jq "$key = \"$value\"" "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"
    else
        # Fallback to sed (less robust but works for simple cases)
        sed -i.bak "s|\"$key\": \".*\"|\"$key\": \"$value\"|g" "$CONFIG_FILE"
        rm "$CONFIG_FILE.bak" 2>/dev/null || true
    fi
}

# Get database credentials from Secrets Manager
echo "🔑 Retrieving database credentials from Secrets Manager..."
SECRET_NAME="nakom-admin/rds/analytics"
if command -v aws >/dev/null 2>&1; then
    SECRET_JSON=$(aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" --query SecretString --output text 2>/dev/null || echo "")
    if [ -n "$SECRET_JSON" ]; then
        echo "✅ Retrieved credentials from Secrets Manager"

        # Extract values from secret
        DB_HOST=$(echo "$SECRET_JSON" | jq -r '.host // empty')
        DB_PASSWORD=$(echo "$SECRET_JSON" | jq -r '.password // empty')
        DB_INSTANCE_ID=$(echo "$SECRET_JSON" | jq -r '.dbInstanceIdentifier // empty')

        # Update config.json with secret values
        if [ -n "$DB_HOST" ]; then
            update_json ".database.host" "$DB_HOST"
            echo "✅ Updated database host"
        fi
        if [ -n "$DB_PASSWORD" ]; then
            update_json ".database.password" "$DB_PASSWORD"
            echo "✅ Updated database password from secret"
        fi
        if [ -n "$DB_INSTANCE_ID" ]; then
            update_json ".database.dbInstanceId" "$DB_INSTANCE_ID"
            echo "✅ Updated database instance ID"
        fi
    else
        echo "⚠️  Could not retrieve secret $SECRET_NAME - using defaults"
    fi
else
    echo "⚠️  AWS CLI not found - using defaults"
fi

echo ""
echo "✅ Configuration file ready: $CONFIG_FILE"
echo ""
echo "Manual steps:"
echo "1. Update adminAccess.allowedIPs with your current IP if needed"
echo ""
echo "Current config:"
cat "$CONFIG_FILE"