FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3000
ENV HOST=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /data
COPY --from=build /app/dist ./dist
COPY src/server ./src/server
COPY src/shared ./src/shared
EXPOSE 3000
VOLUME /data
CMD ["npx", "tsx", "src/server/index.ts"]
