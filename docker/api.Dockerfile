FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@10.11.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @chatagent/api... build \
    && pnpm --filter @chatagent/api deploy --prod --legacy /out

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node /renderer /data
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0
COPY --from=build /out/ ./
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
