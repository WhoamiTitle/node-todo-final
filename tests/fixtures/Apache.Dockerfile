FROM php:8.2-apache@sha256:1bc4115a5528326425f1f59846fc7879d7d3843da9905b42931755ac4d4b29bc
RUN a2enmod rewrite
COPY apache.conf /etc/apache2/conf-enabled/todo-test.conf
COPY backend.php /tmp/backend.php
COPY apache-entrypoint.sh /tmp/apache-entrypoint.sh
CMD ["sh", "/tmp/apache-entrypoint.sh"]
