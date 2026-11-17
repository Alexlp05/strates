FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Dépendances d'abord (mise en cache des couches Docker)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

RUN mkdir -p /app/data && chown node:node /app/data
ENV DATA_DIR=/app/data

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/api/health > /dev/null || exit 1

CMD ["node", "server/index.js"]
