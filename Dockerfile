# syntax=docker/dockerfile:1
#
# Container image for deploying Ephemeral Drops as a Hugging Face Docker Space
# (or any Docker host). Builds the Vite client, then runs the Express server
# which serves both the built client and the /api/drops API from one port.
#
# Hugging Face routes traffic to the port declared as `app_port` in README.md
# (7860 here). The server reads PORT from the environment (set below).

# ── Stage 1: build the client bundle ────────────────────────
FROM node:22-slim AS client-build
WORKDIR /build/client

# Install client deps against the lockfile for reproducible builds.
COPY client/package.json client/package-lock.json ./
RUN npm ci

# Build the production client → /build/client/dist
COPY client/ ./
RUN npm run build

# ── Stage 2: runtime ────────────────────────────────────────
FROM node:22-slim

# The node:* images already ship a non-root "node" user at UID 1000 — which is
# exactly the UID Hugging Face Spaces expect the app to run as. Reuse it rather
# than creating another (creating a second UID-1000 user fails with
# "UID 1000 is not unique").
WORKDIR /home/node/app

# Install server production dependencies only.
COPY server/package.json server/package-lock.json ./server/
RUN npm --prefix server ci --omit=dev

# Server source + the built client. The server serves ../client/dist relative
# to its own directory, so the client bundle must sit at app/client/dist.
COPY server/ ./server/
COPY --from=client-build /build/client/dist ./client/dist

# Hand ownership to the built-in non-root "node" user (UID 1000).
RUN chown -R node:node /home/node/app
USER node

ENV NODE_ENV=production
# Hugging Face expects the app on the port declared as app_port in README.md.
ENV PORT=7860
EXPOSE 7860

# EPH_SECRET (and any R2_* vars) are supplied at runtime via Space Secrets.
CMD ["npm", "--prefix", "server", "start"]
