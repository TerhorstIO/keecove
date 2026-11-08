FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund
COPY index.html vite.config.js ./
COPY src/ src/
COPY public/ public/
COPY extension/ extension/
COPY scripts/ scripts/
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production LISTEN_HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server/ server/
USER node
EXPOSE 8080
CMD ["node", "server/index.mjs"]
