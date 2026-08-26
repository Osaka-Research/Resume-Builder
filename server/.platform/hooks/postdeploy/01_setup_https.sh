#!/bin/bash
# Idempotent: safe to run on every deploy. Issues/renews a Let's Encrypt cert
# for the instance's sslip.io hostname (resolves to the EB Elastic IP with no
# DNS setup needed) and terminates TLS in a second nginx server block on 443,
# proxying to the same gunicorn upstream as the platform's own port-80 block.
set -e

DOMAIN="13-126-187-97.sslip.io"
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
NGINX_HTTPS_CONF="/etc/nginx/conf.d/https.conf"

if ! command -v certbot >/dev/null 2>&1; then
  dnf install -y certbot || pip3 install certbot
fi

if [ ! -f "$CERT_DIR/fullchain.pem" ]; then
  systemctl stop nginx || true
  certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos \
    -m admin@example.com --no-eff-email || true
  systemctl start nginx || true
else
  certbot renew --standalone \
    --pre-hook "systemctl stop nginx" --post-hook "systemctl start nginx" \
    --non-interactive || true
fi

if [ -f "$CERT_DIR/fullchain.pem" ]; then
  cat > "$NGINX_HTTPS_CONF" <<NGINXEOF
server {
    listen 443 ssl;
    server_name $DOMAIN;

    ssl_certificate     $CERT_DIR/fullchain.pem;
    ssl_certificate_key $CERT_DIR/privkey.pem;

    location / {
        proxy_pass          http://127.0.0.1:8000;
        proxy_http_version  1.1;
        proxy_set_header    Connection "";
        proxy_set_header    Host \$host;
        proxy_set_header    X-Real-IP \$remote_addr;
        proxy_set_header    X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}
NGINXEOF
  nginx -t && systemctl reload nginx
fi

cat > /etc/cron.d/certbot-renew <<'CRONEOF'
17 3,15 * * * root certbot renew --standalone --pre-hook "systemctl stop nginx" --post-hook "systemctl start nginx" --quiet
CRONEOF
