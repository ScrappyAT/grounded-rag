
# ==============================================================================
# Grounded RAG — Production Multi-Stage Dockerfile
# Optimized for Render, Railway, or standalone container deployment
# Base: Debian Bookworm Slim for native ONNX Runtime compatibility
# ==============================================================================

# Stage 1: Base Dependencies
FROM node:20-slim AS deps
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Stage 2: Builder & Model Pre-Caching
FROM node:20-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

# Copy source tree
COPY . .

# Set cache directory for ONNX model pre-caching during build
ENV HF_CACHE_DIR=/app/.cache
ENV NODE_ENV=production

# Pre-cache the MiniLM ONNX model weights into .cache during build
# Guarantees runtime startup does NOT depend on downloading weights from Hugging Face
RUN npx tsx scripts/precache-model.ts

# Build optimized Next.js production bundle
RUN npm run build

# Stage 3: Minimal Production Runner
FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV HF_CACHE_DIR=/app/.cache

# Security: Create non-root system user and group
RUN groupadd -g 1001 nodejs && \
    useradd -u 1001 -g nodejs nextjs

# Copy pre-cached ONNX model weights (ensuring non-root ownership)
COPY --from=builder --chown=nextjs:nodejs /app/.cache /app/.cache

# Copy built Next.js application & runtime dependencies
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=deps --chown=nextjs:nodejs /app/node_modules ./node_modules

# Copy database schema and seed data for migration operations
COPY --from=builder --chown=nextjs:nodejs /app/src/lib/db/schema.sql ./src/lib/db/schema.sql
COPY --from=builder --chown=nextjs:nodejs /app/src/lib/db/seed-data.sql ./src/lib/db/seed-data.sql
COPY --from=builder --chown=nextjs:nodejs /app/src/lib/db/seed-manifest.json ./src/lib/db/seed-manifest.json

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const http=require('http');const req=http.get('http://127.0.0.1:3000/',{timeout:3000},(res)=>{res.resume();process.exit(res.statusCode===200?0:1);});req.on('error',()=>process.exit(1));req.on('timeout',()=>{req.destroy();process.exit(1);});"

CMD ["npm", "start"]
