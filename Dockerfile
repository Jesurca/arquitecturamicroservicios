# Imagen única parametrizada: cada microservicio se construye con --build-arg SERVICE=<ruta>
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY common ./common
COPY services ./services
COPY gateway ./gateway
ENV NODE_ENV=production DOCKER=1 DATA_DIR=/data
VOLUME /data
ARG SERVICE
ENV SERVICE_ENTRY=${SERVICE}
CMD ["sh", "-c", "node --no-warnings ${SERVICE_ENTRY}"]
