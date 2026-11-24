#!/usr/bin/env bash
# One-shot setup on an Ubuntu/Debian VPS.  Usage:  sudo bash setup.sh chocolatique.yourdomain.com you@email.com
# Needs: the DNS A record of the domain already pointing at this server.
set -euo pipefail
DOMAIN="${1:?usage: setup.sh <domain> <email>}"; EMAIL="${2:?usage: setup.sh <domain> <email>}"
APP=/opt/chocolatique; DATA=/var/chocolatique

command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
apt-get install -y nginx certbot python3-certbot-nginx git >/dev/null

[ -d "$APP/.git" ] && git -C "$APP" pull --ff-only || git clone https://github.com/Abbass-karbala/chocolatique "$APP"
mkdir -p "$DATA"; cd "$APP"
# keep data outside the code folder so updates never touch it
sed -i "s#./data:/data#$DATA:/data#" docker-compose.yml
docker compose up -d --build

cat > /etc/nginx/sites-available/chocolatique <<NGX
server {
  listen 80;
  server_name $DOMAIN;
  client_max_body_size 4m;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }
}
NGX
ln -sf /etc/nginx/sites-available/chocolatique /etc/nginx/sites-enabled/chocolatique
nginx -t && systemctl reload nginx
certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --non-interactive --redirect
echo "Done: https://$DOMAIN/  (app: /admin/, login admin / admin: change it now). Backups: $DATA"
