FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src/
RUN npm run build

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=20s \
  CMD node -e "const http=require('http');http.get('http://localhost:8000/health',r=>{r.statusCode===200?process.exit(0):process.exit(1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]