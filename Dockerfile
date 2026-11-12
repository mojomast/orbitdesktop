# syntax=docker/dockerfile:1

# Build the Orbit UI from source inside the image. Nothing prebuilt is copied
# from the host; the isolated build script writes into this builder's checkout.
FROM node:22-bookworm-slim AS build
WORKDIR /build
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV ORBIT_BUILD_SCRATCH=/build
RUN npm run build -- --source /build --dest /build/dist --allow-source-dist
RUN npm prune --omit=dev
RUN test -f /build/dist/index.html

# Runtime image: unprivileged node user, no build tools, no host dist.
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=4318 \
    ORBIT_HOST=0.0.0.0 \
    ORBIT_PUBLIC_ORIGIN=http://127.0.0.1:4318 \
    ORBIT_RUNTIME_DIR=/home/node/.orbit-runtime
WORKDIR /app
COPY --from=build --chown=node:node /build/package.json /build/package-lock.json ./
COPY --from=build --chown=node:node /build/node_modules ./node_modules
COPY --from=build --chown=node:node /build/dist ./dist
COPY --chown=node:node server ./server
COPY --chown=node:node src ./src
COPY --chown=node:node contracts ./contracts
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node docs ./docs
COPY --chown=node:node public ./public
COPY --chown=node:node apps ./apps
COPY --chown=node:node hermes-plugin ./hermes-plugin
RUN mkdir -p /home/node/.orbit-runtime \
    && chmod 700 /home/node/.orbit-runtime \
    && chown node:node /home/node/.orbit-runtime
USER node
EXPOSE 4318
CMD ["node", "--experimental-strip-types", "server/index.mjs"]
