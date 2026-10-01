FROM node:22-alpine

RUN apk add --no-cache su-exec

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js merge.js ./
COPY f1_fiber_cable_management_app.html ./

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data

RUN mkdir -p /data/uploads && chown -R node:node /data

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "mkdir -p \"$DATA_DIR/uploads\" && chown -R node:node \"$DATA_DIR\" && exec su-exec node node server.js"]
