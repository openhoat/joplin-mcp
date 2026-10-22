FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src/
RUN npm run build

FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=20s \
  CMD node -e "const http=require('http');http.get('http://localhost:8000/health',r=>{r.statusCode===200?process.exit(0):process.exit(1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
