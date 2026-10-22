# syntax=docker/dockerfile:1
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

FROM base AS build
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter api... --filter @spotibay/shared
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
# Node cannot load the shared package's TypeScript source, so build it and point the package at dist.
RUN pnpm --filter @spotibay/shared build \
 && node -e 'const f="packages/shared/package.json",p=JSON.parse(require("fs").readFileSync(f));p.main="./dist/index.js";p.types="./dist/index.d.ts";require("fs").writeFileSync(f,JSON.stringify(p,null,2))'
RUN pnpm --filter api build
RUN pnpm --filter api deploy --prod /out \
 && cp -r apps/api/dist apps/api/drizzle /out/

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
