# syntax=docker/dockerfile:1.7
# One Dockerfile for every service: `docker build --build-arg APP=booking-api .`
ARG NODE_IMAGE=node:24.19.0-trixie-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

# Dependencies are fetched from the lockfile alone, so this layer stays cached
# until pnpm-lock.yaml changes, not on every source edit.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    --mount=type=cache,id=pnpm-meta,target=/root/.cache/pnpm \
    pnpm fetch

FROM deps AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    --mount=type=cache,id=pnpm-meta,target=/root/.cache/pnpm \
    pnpm install --offline --frozen-lockfile
RUN pnpm build

# One-shot job image that applies database migrations.
FROM build AS migrator
CMD ["pnpm", "migrate", "up"]

FROM build AS bundle
ARG APP
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    --mount=type=cache,id=pnpm-meta,target=/root/.cache/pnpm \
    pnpm deploy --filter=@surge/${APP} --prod --prefer-offline /out

# Runtime: production dependencies and compiled output only, running as a
# non-root user. No package manager, sources or dev tooling.
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=bundle --chown=node:node /out ./
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "--enable-source-maps", "--import", "./dist/instrument.js", "dist/main.js"]
