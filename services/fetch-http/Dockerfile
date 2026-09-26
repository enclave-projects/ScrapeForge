FROM node:20-slim AS base
WORKDIR /app

COPY package.json ./
RUN npm install

COPY src ./src
RUN npm run bundle

FROM node:20-slim
WORKDIR /app
COPY --from=base /app/dist ./dist
CMD ["node", "dist/index.js"]
