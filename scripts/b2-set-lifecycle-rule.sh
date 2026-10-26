#!/usr/bin/env bash
# One-shot: set the "cancel unfinished large files after N days"
# lifecycle rule on the file-manager bucket.
#
# Reads credentials + bucket name from env OR prompts. Resolves the
# bucket by NAME via B2 API, applies a single lifecycle rule, prints
# the result.
#
# Usage:
#   # Explicit args (preferred):
#   B2_KEY_ID=... B2_APP_KEY=... BUCKET_NAME=sargas-file-manager-prod \
#     ./scripts/b2-set-lifecycle-rule.sh
#
#   # Or just run it, it will prompt interactively:
#   ./scripts/b2-set-lifecycle-rule.sh
#
# Days before B2 auto-cancels incomplete large files. Override with
# DAYS=14 ./scripts/b2-set-lifecycle-rule.sh if 7 is too tight.

set -euo pipefail

: "${DAYS:=7}"

for cmd in curl jq; do
	if ! command -v "$cmd" >/dev/null 2>&1; then
		echo "Missing required tool: $cmd (install via brew/apt)" >&2
		exit 1
	fi
done

if [[ -z "${B2_KEY_ID:-}" ]]; then
	read -r -p "B2_KEY_ID: " B2_KEY_ID
fi
if [[ -z "${B2_APP_KEY:-}" ]]; then
	read -r -s -p "B2_APP_KEY: " B2_APP_KEY
	echo
fi
if [[ -z "${BUCKET_NAME:-}" ]]; then
	read -r -p "BUCKET_NAME [sargas-file-manager-prod]: " BUCKET_NAME
	BUCKET_NAME="${BUCKET_NAME:-sargas-file-manager-prod}"
fi

echo "==> Authorizing with Backblaze…"
AUTH=$(curl -s -u "${B2_KEY_ID}:${B2_APP_KEY}" \
	https://api.backblazeb2.com/b2api/v3/b2_authorize_account)

API=$(echo "$AUTH" | jq -r '.apiInfo.storageApi.apiUrl // empty')
TOKEN=$(echo "$AUTH" | jq -r '.authorizationToken // empty')
ACCT=$(echo "$AUTH" | jq -r '.accountId // empty')

if [[ -z "$API" || -z "$TOKEN" || -z "$ACCT" ]]; then
	echo "Auth failed. Response:" >&2
	echo "$AUTH" | jq . >&2 || echo "$AUTH" >&2
	exit 1
fi

echo "==> Resolving bucket ID for '$BUCKET_NAME'…"
BUCKETS=$(curl -s -H "Authorization: $TOKEN" \
	"$API/b2api/v3/b2_list_buckets?accountId=$ACCT&bucketName=$BUCKET_NAME")

BUCKET_ID=$(echo "$BUCKETS" | jq -r '.buckets[0].bucketId // empty')
if [[ -z "$BUCKET_ID" ]]; then
	echo "Bucket '$BUCKET_NAME' not found. Response:" >&2
	echo "$BUCKETS" | jq . >&2
	exit 1
fi
echo "    bucketId: $BUCKET_ID"

echo "==> Applying lifecycle rule (cancel unfinished > ${DAYS} days)…"
RESULT=$(curl -s -X POST "$API/b2api/v3/b2_update_bucket" \
	-H "Authorization: $TOKEN" \
	-H "Content-Type: application/json" \
	-d "{
		\"accountId\": \"$ACCT\",
		\"bucketId\": \"$BUCKET_ID\",
		\"lifecycleRules\": [
			{
				\"fileNamePrefix\": \"\",
				\"daysFromStartingToCancelingUnfinishedLargeFiles\": ${DAYS}
			}
		]
	}")

APPLIED=$(echo "$RESULT" | jq -r '.lifecycleRules // empty')
if [[ -z "$APPLIED" ]]; then
	echo "Update failed. Response:" >&2
	echo "$RESULT" | jq . >&2
	exit 1
fi

echo "==> Done. Active lifecycle rules on bucket:"
echo "$APPLIED" | jq .
