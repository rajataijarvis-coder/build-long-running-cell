# syntax=docker/dockerfile:1
#
# Dockerfile for the long-running cell.
#
# This image builds the entire monorepo (cell + frontend) and then runs the
# cell HTTP server. The dashboard is usually deployed separately, but keeping
# the build in one image proves the whole stack compiles before the cell is
# shipped.

FROM node:20-alpine AS builder
WORKDIR /app

# Install workspace dependencies first so Docker can cache the layer.
COPY package*.json ./
COPY cell/package*.json ./cell/
COPY frontend/package*.json ./frontend/
COPY scripts/package*.json ./scripts/
RUN npm ci --workspaces

# Copy source and run the verification pipeline.
COPY . .
RUN npm run verify

# ---------------------------------------------------------------------------

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3456

# Only copy what the cell needs at runtime.
COPY --from=builder /app/cell/dist ./cell/dist
COPY --from=builder /app/cell/package.json ./cell/package.json
COPY --from=builder /app/package*.json ./

EXPOSE 3456
CMD ["node", "cell/dist/main.js"]
