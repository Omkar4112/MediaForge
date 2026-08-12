# Build context for this Dockerfile is the REPO ROOT (see docker-compose.yml),
# because the image also needs the top-level database/migrations folder.
FROM node:20-slim AS build
WORKDIR /app
COPY backend/package*.json ./
RUN npm install
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY database ./database
COPY backend/public ./public

EXPOSE 3000
CMD ["node", "dist/server.js"]
