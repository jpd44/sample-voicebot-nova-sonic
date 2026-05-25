# ─── Build stage ─────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:20-alpine AS build
WORKDIR /app

# Install build dependencies (need full dev deps for tsc)
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Build TypeScript → dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── Runtime stage ───────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

# Install production deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# App code: compiled JS + static assets
COPY --from=build /app/dist ./dist
COPY public ./public

EXPOSE 3000

# Lightweight healthcheck — the ALB also probes /health
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Don't run as root
RUN addgroup -S app && adduser -S -G app app
USER app

CMD ["node", "dist/server.js"]
