// Send the main-site host through the domestic exit; other hosts go direct.
function FindProxyForURL(url, host) {
    if (host === "www.xiaohongshu.com") {
        return "SOCKS5 127.0.0.1:1080";
    }
    return "DIRECT";
}
