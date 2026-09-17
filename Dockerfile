FROM node:22-alpine

WORKDIR /app

# 零依赖，只需要拷代码进来（不需要 npm install）
COPY server.js ./
COPY public ./public

# 账本目录：交给非 root 用户，挂卷时权限才不会出错
RUN mkdir -p /data && chown -R node:node /data

ENV PORT=3867 \
    DATA_DIR=/data

EXPOSE 3867

USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
