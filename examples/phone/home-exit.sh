#!/system/bin/sh
# home-exit：手机 → 服务器 的反向 SOCKS 隧道（chisel），开机自启 + 掉线重连。
# 放到 /data/adb/service.d/home-exit.sh 并 chmod 755，Magisk 开机会自动跑它。
# 出口 = 这台手机当时的网络（WiFi / 流量）。手机上开着代理 App 的话，root 进程走不走它看它的分应用设置，改过设置要重新验出口。
# 连服务器用的是 IP，所以连接本身不依赖手机的 DNS。
# 密码在同目录的 auth.env（只有一行：AUTH=user:pass），和服务器上那份一样。日志写 client.log，超过 1MB 自动清空。
#
# 下面三处换成你自己的：
#   SERVER_IP  —— 云服务器的公网 IP
#   DOMAIN     —— 服务器上 nginx 用的域名（有 HTTPS 证书的那个）
#   /home-exit/ —— 和服务器 nginx 里 location 的路径一致
D=/data/adb/home-exit
SERVER_IP=1.2.3.4
DOMAIN=your.domain.example
(
  sleep 20
  while true; do
    [ "$(wc -c < "$D/client.log" 2>/dev/null || echo 0)" -gt 1000000 ] && : > "$D/client.log"
    echo "$(date '+%F %T') home-exit: start" >> "$D/client.log"
    . "$D/auth.env"; export AUTH
    SSL_CERT_DIR=/system/etc/security/cacerts "$D/chisel" client --keepalive 25s --max-retry-interval 60s \
      --hostname "$DOMAIN" --sni "$DOMAIN" "https://$SERVER_IP/home-exit/" R:127.0.0.1:1080:socks >> "$D/client.log" 2>&1
    echo "$(date '+%F %T') home-exit: exited ($?)" >> "$D/client.log"
    sleep 10
  done
) &
