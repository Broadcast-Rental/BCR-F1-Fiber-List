FROM node:22-alpine

RUN apk add --no-cache su-exec wget

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js merge.js ./
COPY f1_fiber_cable_management_app.html ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data
ENV NODE_OPTIONS=--max-old-space-size=192

# Written to a file as well: Portainer copies the old container's environment
# when it recreates one, so the env value alone can lag behind the image.
ARG BUILD_NUMBER=dev
ENV BUILD_NUMBER=${BUILD_NUMBER}
RUN echo "${BUILD_NUMBER}" > /app/BUILD_NUMBER

RUN mkdir -p /data/uploads && chown -R node:node /data

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/api/health || exit 1

CMD ["sh", "-c", "mkdir -p \"$DATA_DIR/uploads\" && chown node:node \"$DATA_DIR\" \"$DATA_DIR/uploads\" && exec su-exec node node server.js"]
