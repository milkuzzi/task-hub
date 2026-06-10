FROM nginx:1.27-alpine AS build
RUN apk add --no-cache git build-base pcre-dev zlib-dev openssl-dev linux-headers \
 && NGINX_VERSION=$(nginx -v 2>&1 | sed 's@.*/@@') \
 && git clone --depth=1 --recurse-submodules https://github.com/google/ngx_brotli.git /ngx_brotli \
 && wget -q https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz \
 && tar xf nginx-${NGINX_VERSION}.tar.gz \
 && cd nginx-${NGINX_VERSION} \
 && ./configure --with-compat --add-dynamic-module=/ngx_brotli \
 && make modules \
 && mkdir -p /modules \
 && cp objs/ngx_http_brotli_filter_module.so objs/ngx_http_brotli_static_module.so /modules/

FROM nginx:1.27-alpine
# Brotli dynamic modules built to match this exact nginx version.
COPY --from=build /modules/ngx_http_brotli_filter_module.so /etc/nginx/modules/
COPY --from=build /modules/ngx_http_brotli_static_module.so /etc/nginx/modules/
