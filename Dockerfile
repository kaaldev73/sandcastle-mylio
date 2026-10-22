# Familio runs as a single container (ADR 0002): the web app plus a SQLite
# database in WAL mode, with originals and the database on one mounted volume.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Application source. Familio is run with tsx (TypeScript, no build step).
COPY tsconfig.json ./
COPY src ./src

# Originals and the SQLite database live on one persistent volume. Coolify
# mounts a volume here; DATABASE_PATH and ORIGINALS_DIR point inside it.
ENV DATABASE_PATH=/data/familio.db \
    ORIGINALS_DIR=/data/originals \
    PORT=3000
VOLUME ["/data"]
EXPOSE 3000

# Container health check hits the same endpoint the API tests use.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
