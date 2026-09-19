FROM node:22-bookworm-slim
WORKDIR /opt/orbitdesktop
COPY --chown=node:node package.json package-lock.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && npm ci --omit=dev && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node server ./server
COPY --chown=node:node dist ./dist
USER node
CMD ["node", "server/index.mjs"]
