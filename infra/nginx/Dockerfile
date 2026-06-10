# Nginx with the brotli module compiled in (alpine base has no ngx_brotli).
# Multi-stage: build the dynamic modules against the matching nginx version,
# then copy them into the runtime image and load them.
ARG NGINX_VERSION=1.27.0
FROM nginx:${NGINX_VERSION}-alpine AS build
ARG NGINX_VERSION
RUN apk add --no-cache git build-base pcre-dev zlib-dev openssl-dev linux-headers cmake \\
 && git clone --recurse-submodules -j8 https://github.com/google/ngx_brotli.git /ngx_brotli \\
 && wget -q https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz \\
 && tar xzf nginx-${NGINX_VERSION}.tar.gz \\
 && cd nginx-${NGINX_VERSION} \\
 && ./configure --with-compat --add-dynamic-module=/ngx_brotli \\
 && make modules \\
 && mkdir -p /modules \\
 && cp objs/ngx_http_brotli_filter_module.so objs/ngx_http_brotli_static_module.so /modules/

FROM nginx:${NGINX_VERSION}-alpine
COPY --from=build /modules/ngx_http_brotli_filter_module.so /etc/nginx/modules/
COPY --from=build /modules/ngx_http_brotli_static_module.so /etc/nginx/modules/
