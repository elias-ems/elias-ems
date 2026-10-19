# Built from the repository root (`docker build -f addon/Dockerfile .`), not
# from addon/: the HiGHS planning engine is a separate project in engine/, and
# the add-on loads it at runtime from ../engine. The image keeps that layout,
# /app/addon beside /app/engine, so the same relative path works in both.
FROM node:24-alpine AS build
WORKDIR /app/addon
COPY addon/package*.json ./
RUN npm ci
WORKDIR /app/engine
COPY engine/package*.json ./
RUN npm ci --omit=dev
COPY engine/node.mjs engine/node-worker.mjs ./
COPY engine/src ./src
WORKDIR /app/addon
COPY addon/ ./
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
WORKDIR /app/addon
COPY addon/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/addon/server.js ./server.js
COPY --from=build /app/addon/build/server ./build/server
COPY --from=build /app/addon/build/client ./build/client
# The engine's TypeScript runs directly under Node 24's type stripping, on a
# worker thread per solve; its only dependency is the HiGHS WASM build, which
# is architecture-independent, so amd64 and aarch64 get the same files.
COPY --from=build /app/engine /app/engine
EXPOSE 3000
CMD ["npm", "run", "start"]
