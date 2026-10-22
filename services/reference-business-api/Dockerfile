# syntax=docker/dockerfile:1
#
# Reference business API image (WP-23; FO-06-74). Build from the REPOSITORY ROOT (the workspace lockfile pins
# every dependency):
#
#   docker build -f services/reference-business-api/Dockerfile --build-arg VCS_REF="$(git rev-parse HEAD)" \
#     -t vsp-reference-business-api:local .
#
# The build context needs the service directory re-included in the root .dockerignore (allowlist), see the
# service README. The local Layer-2 composition does not use this image (deploy/local/services runs the checkout's
# code on the digest-pinned Node image); this is the deployable image of the reference integration.
#
# Runtime contract: REFBIZ_ENVIRONMENT, the database connection (REFBIZ_DATABASE_*; TLS required outside
# local/ci) and a server certificate (REFBIZ_TLS_CERT_FILE / REFBIZ_TLS_KEY_FILE, required outside local/ci).
# The fault-control listener cannot be enabled in a deployed environment (the service refuses to start).

ARG NODE_IMAGE=public.ecr.aws/docker/library/node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94

# ------------------------------------------------------------------ build
FROM ${NODE_IMAGE} AS build
ENV CI=true \
    PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PATH="${PNPM_HOME}:${PATH}"
WORKDIR /src

# pnpm version comes from package.json "packageManager" via corepack.
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY services/reference-business-api/package.json services/reference-business-api/package.json
RUN pnpm install --frozen-lockfile --filter "@vsp/reference-business-api..."

COPY services/reference-business-api/ services/reference-business-api/
RUN pnpm --filter @vsp/reference-business-api exec tsc -p tsconfig.json \
 && pnpm --filter @vsp/reference-business-api deploy --prod --legacy /out \
 && cp -r services/reference-business-api/dist /out/dist \
 && cp -r services/reference-business-api/openapi /out/openapi \
 && rm -rf /out/src /out/dist/src/*.test.js /out/dist/src/*.test.js.map /out/tsconfig.json /out/Dockerfile

# ------------------------------------------------------------------ runtime
FROM ${NODE_IMAGE} AS runtime

ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="vsp-reference-business-api" \
      org.opencontainers.image.description="Reference business API: documented reference integration for the canonical domain contracts (SYNTHETIC data only)." \
      org.opencontainers.image.source="https://github.com/nikhilgmishra/genAIplayground" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="MIT"

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && groupadd --system --gid 10001 refbiz \
 && useradd --system --uid 10001 --gid refbiz --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin refbiz

ENV NODE_ENV=production \
    REFBIZ_API_BIND=0.0.0.0 \
    REFBIZ_API_PORT=8443 \
    REFBIZ_HEALTH_PORT=8081 \
    REFBIZ_FAULT_CONTROL=disabled \
    TMPDIR=/tmp

WORKDIR /app
COPY --from=build --chown=root:root /out/ /app/

USER 10001:10001
EXPOSE 8443

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.REFBIZ_HEALTH_PORT||8081)+'/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

STOPSIGNAL SIGTERM
CMD ["node", "dist/src/main.js"]
