FROM node:22-alpine
WORKDIR /app
COPY ops/log-dashboard/server.js ./server.js
COPY logs.html ./logs.html
ENV PORT=8090
EXPOSE 8090
CMD ["node", "server.js"]
