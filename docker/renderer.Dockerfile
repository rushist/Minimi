FROM node:22-bookworm-slim
WORKDIR /repo
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN npm install --global pnpm@10.11.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm --filter @chatagent/api exec playwright install --with-deps chromium \
    && install -d -o node -g node /renderer
COPY . .
RUN pnpm --filter @chatagent/api... build
ENV HOME=/tmp
USER node
CMD ["node", "apps/api/dist/fetch/browser-service.js"]
