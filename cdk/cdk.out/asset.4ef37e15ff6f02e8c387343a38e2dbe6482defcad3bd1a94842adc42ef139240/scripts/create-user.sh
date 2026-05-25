#!/usr/bin/env bash
# Create a confirmed user in the SpeechLab Cognito pool with a permanent password.
# Usage:
#   ./scripts/create-user.sh <email> <password> [<given_name>]
#
# Example:
#   ./scripts/create-user.sh alice@example.com 'Pa$$w0rd!' Alice
#
# Notes:
# - Uses AdminCreateUser with --message-action SUPPRESS (no welcome email).
# - Uses AdminSetUserPassword --permanent (no FORCE_CHANGE_PASSWORD on first login).
# - Requires you to be authenticated to AWS account 376210053828 (SSO Admin role works).
# - Override the pool/region/profile via env vars if you ever need to.

set -euo pipefail

EMAIL="${1:-}"
PASSWORD="${2:-}"
GIVEN_NAME="${3:-}"

if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
  echo "Usage: $0 <email> <password> [<given_name>]" >&2
  exit 2
fi

USER_POOL_ID="${USER_POOL_ID:-us-east-1_dqBKmK639}"
AWS_REGION="${AWS_REGION:-us-east-1}"

# Build the user attributes list. email is the username attribute; email_verified=true
# avoids the verification step. given_name is optional.
ATTR_ARGS=(
  "Name=email,Value=$EMAIL"
  "Name=email_verified,Value=true"
)
if [[ -n "$GIVEN_NAME" ]]; then
  ATTR_ARGS+=("Name=given_name,Value=$GIVEN_NAME")
fi

echo "→ Creating user $EMAIL in pool $USER_POOL_ID..."
aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" \
  --user-attributes "${ATTR_ARGS[@]}" \
  --message-action SUPPRESS \
  --region "$AWS_REGION" \
  --output text \
  --query 'User.UserStatus' \
  >/dev/null

echo "→ Setting a permanent password (no forced reset on login)..."
aws cognito-idp admin-set-user-password \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" \
  --password "$PASSWORD" \
  --permanent \
  --region "$AWS_REGION"

echo
echo "✅ User ready. Sign in at https://speechlab.daily-deutsch.com"
echo "   Email:    $EMAIL"
echo "   Password: (the one you provided)"
