#!/bin/sh
set -eu
php -S 127.0.0.1:30356 /tmp/backend.php &
exec apache2-foreground
