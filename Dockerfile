# LingoDesk — 单容器部署(long polling,无需暴露端口)
FROM node:22-slim

# Prisma 在 slim 镜像上需要 openssl
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 默认落到 /app/data 和 /app/storage(compose 会挂载同路径;裸 docker run 也能跑)
ENV DATABASE_URL=file:/app/data/lingodesk.db \
    STORAGE_DIR=/app/storage

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci && npx prisma generate

COPY . .

# 启动时先同步表结构(SQLite 落在挂载卷 /app/data),再起 bot
CMD ["sh", "-c", "npx prisma db push --skip-generate && npm run start"]
