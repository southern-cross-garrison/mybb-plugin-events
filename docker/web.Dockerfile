FROM php:7.4-apache

# MyBB's required PHP extensions, plus libfaketime so the e2e suite can move the
# clock inside the container without touching the host.
# Bullseye is past its security-team EOL and the debian-security pool no longer serves
# the versions its index advertises, which breaks `apt-get install` outright. The main
# and updates suites still resolve, so drop the security line before installing.
RUN sed -i '/debian-security/d' /etc/apt/sources.list \
    && apt-get update && apt-get install -y --no-install-recommends \
        libpng-dev \
        libjpeg-dev \
        libfreetype6-dev \
        libzip-dev \
        libicu-dev \
        libxml2-dev \
        faketime \
        default-mysql-client \
        unzip \
        curl \
    && docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j"$(nproc)" gd mysqli pdo pdo_mysql zip intl opcache \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# The faketime library lives under an arch-specific path; normalise it so LD_PRELOAD
# can be a fixed value on both amd64 (CI) and arm64 (Apple Silicon).
RUN ln -s "$(find /usr/lib -name 'libfaketime.so.1' | head -n 1)" /usr/local/lib/libfaketime.so.1

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
