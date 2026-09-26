# The plugin supports PHP 7.4 (the garrison's host) through the latest 8.x, and the suite
# runs on either: PHP_VERSION in .env or the environment picks the image (see
# docker-compose.yml). CI runs both ends.
ARG PHP_VERSION=7.4
FROM php:${PHP_VERSION}-apache

# MyBB's required PHP extensions.
# Bullseye (the 7.4 image) is past its security-team EOL and the debian-security pool no
# longer serves the versions its index advertises, which breaks `apt-get install`
# outright. The main and updates suites still resolve, so drop the security line before
# installing. Newer images keep their sources in sources.list.d/ and have no such file.
# OPcache is compiled into PHP from 8.5 on, and docker-php-ext-install fails on an
# extension that is already there, so it is only built where it is missing.
RUN if [ -f /etc/apt/sources.list ]; then sed -i '/debian-security/d' /etc/apt/sources.list; fi \
    && apt-get update && apt-get install -y --no-install-recommends \
        libpng-dev \
        libjpeg-dev \
        libfreetype-dev \
        libzip-dev \
        libicu-dev \
        libxml2-dev \
        default-mysql-client \
        unzip \
        curl \
    && docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j"$(nproc)" gd mysqli pdo pdo_mysql zip intl \
        $(php -m | grep -qi "zend opcache" || echo opcache) \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# libfaketime, so the e2e suite can move the clock inside the container without touching
# the host. Built from a pinned release rather than taken from Debian, because it has to
# fake file times as well as the clock - MyBB decides a cached stylesheet is stale by
# comparing its filemtime() with time() - and on the newer images PHP reads file times
# through stat64(), which no libfaketime before 0.9.13 intercepts. Debian's is 0.9.10, so
# every file written under a moved clock came back dated in the past there.
ARG LIBFAKETIME_VERSION=0.9.13
ARG LIBFAKETIME_SHA256=8e56deeb805682b025107e095f1d94a6ea677472f05824cd475f5c5e6e1a5ddf
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && curl -fsSL -o /tmp/libfaketime.tar.gz \
        "https://github.com/wolfcw/libfaketime/archive/refs/tags/v${LIBFAKETIME_VERSION}.tar.gz" \
    && echo "${LIBFAKETIME_SHA256}  /tmp/libfaketime.tar.gz" | sha256sum -c - \
    && mkdir /tmp/libfaketime \
    && tar -xzf /tmp/libfaketime.tar.gz -C /tmp/libfaketime --strip-components=1 \
    && make -C /tmp/libfaketime/src libfaketime.so.1 \
    && install -m 0755 /tmp/libfaketime/src/libfaketime.so.1 /usr/local/lib/libfaketime.so.1 \
    && rm -rf /tmp/libfaketime /tmp/libfaketime.tar.gz \
    && apt-get purge -y --auto-remove build-essential \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ENV LD_PRELOAD=/usr/local/lib/libfaketime.so.1 \
    FAKETIME_TIMESTAMP_FILE=/faketime/faketime.rc \
    FAKETIME_NO_CACHE=1 \
    FAKETIME_DONT_FAKE_MONOTONIC=1

RUN a2enmod rewrite \
    && printf '<Directory /var/www/html>\n\tOptions Indexes FollowSymLinks\n\tAllowOverride All\n\tRequire all granted\n</Directory>\n' \
        > /etc/apache2/conf-available/mybb.conf \
    && a2enconf mybb

COPY docker/php.ini /usr/local/etc/php/conf.d/zz-mybb.ini

WORKDIR /var/www/html
EXPOSE 80
CMD ["apache2-foreground"]
