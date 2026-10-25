# PIA — 单进程镜像（API + 内置页面 + 调度钩子）
#
# 目标体积与攻击面都尽量小：alpine + 零运行时依赖，镜像约 60MB。
# 数据不在镜像里：/data 由 compose 挂载。

FROM node:22-alpine

ENV NODE_ENV=production \
    PA_WORKSPACE=/data/ws \
    PA_HOME=/data/home

WORKDIR /app

# 只复制运行所需（test/ 与 .tmp 不进镜像）
COPY packages/personal/package.json ./packages/personal/package.json
COPY packages/personal/src ./packages/personal/src
COPY packages/personal/bin ./packages/personal/bin
COPY packages/personal/schemas ./packages/personal/schemas
COPY packages/personal/web ./packages/personal/web
COPY deploy/docker-entrypoint.sh /usr/local/bin/pa-entrypoint

RUN chmod +x /usr/local/bin/pa-entrypoint \
    && mkdir -p /data/ws /data/home \
    && chown -R node:node /app /data

USER node

EXPOSE 8787

# 容器内只绑 0.0.0.0（由 compose 的端口映射限制到宿主机回环）
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/pa-entrypoint"]
