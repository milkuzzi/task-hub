# syntax=docker/dockerfile:1

# ---- deps + build ----
FROM node:22-alpine AS build
WORKDIR /app
# Prisma на alpine требует openssl для query-engine (musl).
RUN apk add --no-cache openssl
# Манифесты workspaces + схема — для кеша и для prisma generate.
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY prisma ./prisma
RUN npm ci
# Исходники backend + сборка.
COPY backend ./backend
RUN npx prisma generate \
 && npm --workspace backend run build      # nest build → backend/dist

# ---- runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache ca-certificates font-carlito font-dejavu font-liberation libreoffice libreoffice-calc openssl postgresql-client restic wget \
 && wget -qO /usr/local/share/ca-certificates/russian_trusted_root_ca.crt \
      https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt \
 && wget -qO /usr/local/share/ca-certificates/russian_trusted_sub_ca.crt \
      https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt \
 && update-ca-certificates
ENV NODE_ENV=production \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
# Артефакты: собранный backend, узлы зависимостей (вкл. prisma CLI + клиент),
# схема и миграции Prisma.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
# Каталог вложений вне веб-корня; владелец — непривилегированный node,
# чтобы свежий named-volume унаследовал правильные права.
RUN mkdir -p /data/attachments && chown -R node:node /data
USER node
WORKDIR /app/backend
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=12 \
  CMD wget -qO- --header='X-Forwarded-Proto: https' http://127.0.0.1:3000/health >/dev/null 2>&1 || exit 1
CMD ["node", "dist/main.js"]
