#!/usr/bin/env bash
#
# Deploy PeraByte Studio to Vercel.
#
# Requires a Vercel access token in the environment. Create one at
# https://vercel.com/account/tokens and make it available WITHOUT pasting it
# into chat, e.g.:
#
#   echo 'VERCEL_TOKEN=xxxxxxxx' >> ~/.env      # or export VERCEL_TOKEN=...
#   bash scripts/deploy-vercel.sh
#
# The token is read from the environment and never echoed.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -z "${VERCEL_TOKEN:-}" ]]; then
  # Fall back to a dotenv-style file so the token never has to be exported
  # in an interactive shell.
  for candidate in "$HOME/.env" "$HOME/../.env" "$(cd .. && pwd)/.env"; do
    if [[ -f "$candidate" ]] && grep -q '^VERCEL_TOKEN=' "$candidate" 2>/dev/null; then
      VERCEL_TOKEN="$(grep '^VERCEL_TOKEN=' "$candidate" | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')"
      break
    fi
  done
fi

if [[ -z "${VERCEL_TOKEN:-}" ]]; then
  echo "No VERCEL_TOKEN found." >&2
  echo "Add one with:  echo 'VERCEL_TOKEN=your-token' >> ~/.env" >&2
  echo "Get a token:   https://vercel.com/account/tokens" >&2
  exit 1
fi

export VERCEL_TOKEN

echo "==> Verifying credentials"
npx --yes vercel@latest whoami

echo "==> Building locally first (fail fast, no broken deploys)"
npm run build

echo "==> Linking project"
npx --yes vercel@latest link --yes --project perabyte-studio

echo "==> Deploying to production"
npx --yes vercel@latest deploy --prod --yes

echo "==> Done"
