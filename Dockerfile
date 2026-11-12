# Imagen única parametrizada: cada microservicio se construye con --build-arg SERVICE=<ruta>
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY common ./common
COPY services ./services
COPY gateway ./gateway
# [Data] directorio de la base de datos propia, perteneciente al usuario sin privilegios
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production DOCKER=1 DATA_DIR=/data
VOLUME /data
# [ISO] el proceso no corre como root
USER node
ARG SERVICE
ENV SERVICE_ENTRY=${SERVICE}
CMD ["sh", "-c", "exec node --no-warnings ${SERVICE_ENTRY}"]
