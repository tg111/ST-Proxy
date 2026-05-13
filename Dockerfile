FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY config.json ./
COPY src ./src
COPY public ./public
COPY README.md README_zh.md ./

ENV NODE_ENV=production
ENV PORT=3000
VOLUME ["/app/data"]
EXPOSE 3000

CMD ["node", "src/server.js"]
