# CubScore, as one image containing all three build outputs.
#
# One image rather than three because the build is a single pnpm workspace and the
# outputs are small: splitting it would mean running the same install and the same
# typecheck three times to save a few megabytes. The compose file runs this image
# twice with different commands, and the web bundle is copied out of it by the
# proxy container.
#
# NOT VERIFIED BY ANY GATE IN THIS REPO. `pnpm deploycheck` runs the compiled
# services directly under node, which is what proves they are deployable at all;
# no CI runner here has a Docker daemon, so this file has never been built. Treat a
# first build as something to watch. What deploycheck does cover is the part most
# likely to be wrong — that the services build to plain JS and need no
# devDependency at runtime.

FROM node:22-slim AS build
WORKDIR /src

# corepack pins pnpm from package.json's packageManager field, so the version here
# cannot drift from the one the lockfile was written with.
RUN corepack enable

# Manifests first, so a source-only change does not re-run the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/design/package.json packages/design/
COPY packages/formats/package.json packages/formats/
COPY apps/web/package.json apps/web/
COPY services/api/package.json services/api/
COPY services/sync/package.json services/sync/
RUN pnpm install --frozen-lockfile

COPY . .
# Typechecks and emits: apps/web/dist, services/api/dist, services/sync/dist.
RUN pnpm build

# ---------------------------------------------------------------------------

FROM node:22-slim AS runtime
WORKDIR /app
RUN corepack enable

# Production dependencies only. This is the step `pnpm deploycheck` exists to
# protect: a service that imports a devDependency compiles fine and then dies here
# with ERR_MODULE_NOT_FOUND, in the runtime image, on the deployment.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/api/package.json services/api/
COPY services/sync/package.json services/sync/
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /src/services/api/dist services/api/dist
COPY --from=build /src/services/sync/dist services/sync/dist
# Carried so the proxy container can copy the static bundle out of this image.
COPY --from=build /src/apps/web/dist apps/web/dist

# Not root. The API writes user data, and a container process that can write its
# own application files can rewrite the code it is running.
USER node

# Overridden per service by compose. HOST=0.0.0.0 is set there, not here: inside a
# container 127.0.0.1 is unreachable from anywhere else in the deployment, and a
# default that assumed a container would be the wrong default on a bare host.
CMD ["node", "services/api/dist/server.js"]
