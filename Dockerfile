FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public

# 数据目录用于状态文件原子持久化；命名卷首次挂载会继承此属主
RUN mkdir -p /data && chown node:node /data

ENV PORT=8080 HOST=0.0.0.0 DATA_DIR=/data
EXPOSE 8080

USER node
CMD ["node", "src/server.js"]
