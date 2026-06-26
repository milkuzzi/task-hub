# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY prisma ./prisma
RUN npm ci
COPY frontend ./frontend
RUN npm --workspace frontend run build    # vite build → frontend/dist

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=12 \
  CMD wget -qO- http://127.0.0.1:80/healthz >/dev/null 2>&1 || exit 1
