FROM mcr.microsoft.com/playwright:v1.49.1-jammy AS base
WORKDIR /app

COPY package.json ./
RUN npm install

COPY src ./src
RUN npm run bundle

FROM mcr.microsoft.com/playwright:v1.49.1-jammy
WORKDIR /app
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/dist ./dist
CMD ["node", "dist/index.cjs"]
