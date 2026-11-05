# One image, two processes: API (stateless, scale horizontally) and worker (job queue; run 1+).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-core fonts-noto-extra && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_PATH=/usr/bin/chromium NODE_ENV=production
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY backend/package.json backend/
RUN pnpm install --frozen-lockfile --filter @barr/backend...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY backend backend
WORKDIR /app/backend
EXPOSE 4000
# API:    docker run … barr-backend
# Worker: docker run … barr-backend pnpm worker
# Migrate (release step): docker run … barr-backend pnpm migrate
CMD ["pnpm", "start"]
