#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

if docker compose version >/dev/null 2>&1; then
    compose() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
    compose() { docker-compose "$@"; }
else
    echo 'Docker Compose V2 is required.' >&2
    exit 1
fi

if [ ! -f .env ]; then
    cp .env.example .env
    chmod 600 .env
    echo 'Created .env. Set BIAI_LOGIN_PASSWORD (at least 16 characters), then run this script again.'
    exit 1
fi

chmod 600 .env
image='smart-biai-agent:0.3.5-docker.1'
if ! docker image inspect "$image" >/dev/null 2>&1; then
    if [ ! -f images.tar ]; then
        echo 'Missing images.tar. Load the offline image or build the Dockerfile first.' >&2
        exit 1
    fi
    docker load -i images.tar
fi

docker run --rm --env-file .env -e BIAI_REQUIRE_AUTH=true --entrypoint node "$image" \
  --input-type=module -e "import {webAccess} from './web-access.mjs'; webAccess(process.env); console.log('Login and URL settings checked.');"

if [ ! -d data ]; then
    mkdir data
    docker run --rm --user 0:0 --entrypoint sh \
      --mount "type=bind,src=$(pwd)/data,dst=/data" "$image" \
      -c 'chown 1000:1000 /data && chmod 700 /data'
fi
compose -f compose.yml config --quiet
compose -f compose.yml up -d
compose -f compose.yml ps
