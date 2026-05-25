FROM node:22-alpine AS base
RUN apk add --no-cache vips-dev python3 make g++

WORKDIR /app

COPY server/package.json ./server/
RUN cd server && npm install --production

COPY packages/ ./packages/
COPY server/   ./server/

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "server/index.js"]
