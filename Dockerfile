FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY views ./views
COPY public ./public
RUN useradd --system --uid 10001 manualpay && mkdir -p /app/data && chown -R manualpay:manualpay /app
USER manualpay
EXPOSE 3000
CMD ["node", "dist/server.js"]
