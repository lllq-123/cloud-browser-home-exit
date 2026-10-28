function FindProxyForURL(url, host) {
  // 家里出口（家里手机连上来的隧道，服务 home-exit-tunnel.service）。只有下面两个小红书域名走它，其余一律直连：
  // - www.xiaohongshu.com：主站网页。从海外云服务器打开主站网页（首页 / 帖子 / 通知 / 个人主页 / 登录）会被 302 到
  //   海外版 rednote，登录态用不上；所以只把主站网页本身切到家里出口（一张几十 KB），数据接口 edith、
  //   图片脚本 xhscdn、创作中心 creator 仍直连。
  // - sns-creator-preview.xhscdn.com：创作者图片预览，直连曾返回 HTTP 400。
  // 故意不接 "; DIRECT" 兜底：隧道断开时保留固定出口，不静默切回云 IP（主站兜底直连也只会落到 rednote）。
  var viaHome = [
    "sns-creator-preview.xhscdn.com",  // 创作者图片预览域
    "www.xiaohongshu.com"  // 主站网页；edith / xhscdn / creator 等其他小红书域名仍直连
  ];
  for (var j = 0; j < viaHome.length; j++) {
    if (host === viaHome[j] || dnsDomainIs(host, "." + viaHome[j])) {
      return "SOCKS5 127.0.0.1:1080";
    }
  }
  // 备用：想让某些域名走服务器上另一个代理（比如你自己的梯子）就填在这里，端口改成你的。我们家这个列表是空的。
  var viaProxy = [
  ];
  for (var i = 0; i < viaProxy.length; i++) {
    if (host === viaProxy[i] || dnsDomainIs(host, "." + viaProxy[i])) {
      return "PROXY 127.0.0.1:8080";
    }
  }
  return "DIRECT";
}
