#!/usr/bin/env bash
# Updates the test website on the server to the latest main and restarts it.
# Run on the server (GitHub Actions does it over SSH after each merge):
#   bash ~/Smart_Print/code/deploy/deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.."   # -> code/
COMPOSE=(docker compose -f docker-compose.prod.yml --env-file .env.production --profile https)

echo "==> Getting the latest main"
git fetch --quiet origin main
git checkout --quiet main
git merge --ff-only --quiet origin/main
git log -1 --oneline

echo "==> Building images"
"${COMPOSE[@]}" build

echo "==> Database + migrations"
"${COMPOSE[@]}" up -d db
"${COMPOSE[@]}" run --rm migrate

echo "==> Starting the site"
"${COMPOSE[@]}" up -d --remove-orphans

echo "==> Waiting for the backend to be healthy"
for _ in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$("${COMPOSE[@]}" ps -q backend)" 2>/dev/null || true)
  if [ "$status" = "healthy" ]; then
    echo "Backend is healthy."
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 5
done
echo "Backend did not become healthy. Last logs:" >&2
"${COMPOSE[@]}" logs --tail 50 backend >&2
exit 1
