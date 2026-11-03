FROM node:26.13.0-alpine3.24 AS base
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

FROM node:26.13.0-alpine3.24 AS production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production=true
COPY --from=base /app/dist ./dist

EXPOSE 3101
ENTRYPOINT ["node", "dist/index.js"]
