# syntax=docker/dockerfile:1
#
# Voice support platform image (gateway and worker share one image; the ECS task
# definition selects the command). Build from the REPOSITORY ROOT:
#
#   bash scripts/fetch-tools.sh && bash scripts/policy.sh build     # OPA bundle -> policy/build
#   docker build -f platform/Dockerfile \
#     --build-arg VCS_REF="$(git rev-parse HEAD)" -t vsp-platform:local .
#
# NOT BUILT in the authoring environment (no Docker daemon). CI builds, scans (Trivy),
# signs (cosign keyless) and attests the image in .github/workflows/release.yml.
#
# PREREQUISITE (supply chain, OPS-06): the base image is pinned by exact version tag.
# Before production it must also be pinned by digest
# (node:22.22.0-bookworm-slim@sha256:<digest>); the digest could not be resolved
# offline. Dependabot (docker ecosystem) proposes base-image updates for review.

ARG NODE_IMAGE=node:22.22.0-bookworm-slim

# ------------------------------------------------------------------ build
FROM ${NODE_IMAGE} AS build
ENV CI=true \
    PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PATH="${PNPM_HOME}:${PATH}"
WORKDIR /src

# pnpm version comes from package.json "packageManager" (pnpm@10.28.0) via corepack.
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY platform/package.json platform/package.json
COPY console/package.json console/package.json
RUN pnpm install --frozen-lockfile --filter "@vsp/platform..."

COPY platform/ platform/
RUN pnpm --filter @vsp/platform build \
 && pnpm --filter @vsp/platform deploy --prod --legacy /out \
 && rm -rf /out/src /out/test /out/vitest.config.ts /out/eslint.config.js /out/tsconfig.json /out/tsconfig.build.json /out/Dockerfile

# ------------------------------------------------------------------ runtime
FROM ${NODE_IMAGE} AS runtime

ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="vsp-platform" \
      org.opencontainers.image.description="Voice support control plane (gateway + worker). IMPLEMENTED_OFFLINE; not verified for production." \
      org.opencontainers.image.source="https://github.com/nikhilgmishra/genAIplayground" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="MIT"

# Remove package managers from the runtime image (nothing installs at runtime) and
# create a dedicated non-root user with a fixed numeric id (matches the ECS task's
# "user": "10001:10001").
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && groupadd --system --gid 10001 vsp \
 && useradd --system --uid 10001 --gid vsp --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin vsp

ENV NODE_ENV=production \
    PORT=8080 \
    TMPDIR=/tmp

WORKDIR /app
# Application files are owned by root and not writable by the runtime user, so the
# container runs with a read-only root filesystem; only /tmp (an ECS task volume) is
# writable.
COPY --from=build --chown=root:root /out/ /app/
COPY --chown=root:root policy/ /app/policy/
COPY --chown=root:root schemas/ /app/schemas/

USER 10001:10001
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

STOPSIGNAL SIGTERM
# Default command: gateway. The worker task overrides it (see modules/stack).
# The production entry points are an interface request to the platform engineers.
CMD ["node", "dist/main/server.js"]
