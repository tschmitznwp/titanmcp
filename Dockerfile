FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Mount point for the persisted order index (TITAN_ORDER_INDEX_PATH). Docker
# initializes an empty named volume from the image directory, ownership included,
# so this has to exist and be owned by `node` — otherwise the volume lands
# root-owned, the non-root process cannot write the snapshot, and every restart
# silently re-reads all 57k orders.
RUN mkdir -p /data && chown node:node /data
EXPOSE 8585
USER node
CMD ["node", "dist/index.js"]
