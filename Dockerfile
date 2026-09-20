FROM node:22-bookworm-slim
WORKDIR /opt/orbitdesktop
COPY --chown=node:node package.json package-lock.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && npm ci --omit=dev && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node server ./server
COPY --chown=node:node src/model.ts src/workspace-ops.ts ./src/
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node docs ./docs
COPY --chown=node:node dist ./dist
RUN mkdir -p /opt/orbitdesktop/.runtime && chown node:node /opt/orbitdesktop/.runtime
USER node
CMD ["node", "server/index.mjs"]
