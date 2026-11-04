# AI RSS —— 多阶段构建
#
# 构建阶段用官方 node 镜像（不依赖本机 Node），运行阶段只放二进制。
# 见 PLAN §4.4 / §16.3。
#
# 为什么 runtime 用 debian 而不是 alpine：
#   Node SEA 不支持 musl（PLAN §3.2），Alpine 上二进制跑不起来。

# syntax=docker/dockerfile:1

# ── 构建 ────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS build

WORKDIR /app

# 依赖层单独缓存：package*.json 没变就不重装
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=cache,target=/app/.cache/npm \
    npm ci --cache /app/.cache/npm --no-audit --no-fund

COPY . .

# 构建期临时文件也关在容器内
ENV TMPDIR=/app/.tmp TMP=/app/.tmp TEMP=/app/.tmp
RUN mkdir -p /app/.tmp

# 前端 → 服务端 bundle → zip → SEA
# 前端 → 服务端 bundle → zip → SEA
# 显式指定 --target linux-x64：镜像里必须是 linux 产物，
# 不依赖构建机架构（buildx 可用 --platform linux/amd64 固定）。
RUN node scripts/build-client.mjs \
 && node scripts/build-server.mjs --sea \
 && node scripts/pack-client-zip.mjs \
 && node scripts/build-sea.mjs --target linux-x64

# ── 运行 ────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

# 非 root 运行
RUN useradd -r -u 10001 -m -d /app -s /usr/sbin/nologin cheng-rss

WORKDIR /app
COPY --from=build /app/dist/cheng-rss-linux-x64 /app/cheng-rss
RUN chmod +x /app/cheng-rss && chown -R cheng-rss:cheng-rss /app

USER cheng-rss

ENV DATA_DIR=/app/data \
    PORT=3000 \
    HOST=0.0.0.0 \
    NODE_OPTIONS=--max-old-space-size=384

VOLUME ["/app/data"]
EXPOSE 3000

# doctor 作为健康检查：它会读库、验 schema、查完整性
HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD ["/app/cheng-rss", "doctor", "--quiet"]

ENTRYPOINT ["/app/cheng-rss"]
CMD ["serve"]
