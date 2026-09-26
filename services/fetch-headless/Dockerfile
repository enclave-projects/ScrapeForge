FROM mcr.microsoft.com/playwright:v1.49.1-jammy AS base
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm install typescript --no-save && npx tsc

FROM mcr.microsoft.com/playwright:v1.49.1-jammy
WORKDIR /app
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/dist ./dist
COPY package.json ./
CMD ["node", "dist/index.js"]
