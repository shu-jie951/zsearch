# 单端口 Node 服务，只有一个运行时依赖（express）
FROM node:20-alpine

WORKDIR /app

# 先只拷依赖清单：依赖没变时这一层走缓存，改代码不用重装
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 再拷源码（.dockerignore 已排除 node_modules / 截图 / 质检产物）
COPY --chown=node:node . .

# 非 root 用户运行
USER node

ENV NODE_ENV=production \
    PORT=5178

EXPOSE 5178

# 健康检查：首页能出来就说明服务活着（上游是否可用不影响这里）
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5178)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
