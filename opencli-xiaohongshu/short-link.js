// 我们家自己写的，按 Apache-2.0 公开（见 LICENSE）
/**
 * 小红书 App 分享短链（xhslink.com / xhslink.cn）：不开网页，只问短链跳去哪。
 *
 * 为什么：短链地址里没有帖子编号，以前 download 碰到短链只能整页打开它、让它跳到主站整页（2026-10-27 起主站整页要经家里
 * 手机出口，慢、会断）。实测：服务器直连
 * 对 https://xhslink.cn/o/<码> 发 GET、不跟随跳转 → HTTP 302，Location 是主站帖子网址
 * /discovery/item/<帖子id>?…&xsec_source=app_share&type=normal&xsec_token=<通行码>&…，拿它在常驻页里页内打开就成；
 * 默认 UA 和桌面 Chrome UA 结果一样。Location 里还带 shareRedId / share_id 等分享人标识，所以 stderr 那一行绝不带地址。
 *
 * 不 import 任何东西：fetch 和「网址 → 帖子目标」的解析（resident-helpers.js 的 noteTargetFromUrl）都由调用方传进来，
 * 测试可以直接 import、注入假 fetch。注意 opencli 进程里的全局 fetch 被官方换过（dist/src/main.js 调
 * node-network.js 的 installNodeNetwork）：设了 http(s)_proxy / all_proxy 环境变量就走代理（NO_PROXY 照认），没设才直连。
 */

export const SHORT_LINK_TIMEOUT_MS = 8_000;
export const DESKTOP_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/130.0.0.0 Safari/537.36';

const TIMED_OUT = Symbol('timed_out');

function fail(reason) {
    return { ok: false, target: null, reason };
}

async function askRedirect(shortUrl, fetchImpl, parseTarget, timeoutMs) {
    if (typeof fetchImpl !== 'function') return fail('no_fetch');
    if (typeof parseTarget !== 'function') return fail('no_parser');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    // 超时自己掐表：fetch 不理 signal（比如测试里的假 fetch）也照样 timeoutMs 后放弃。
    const timedOut = new Promise(resolve => {
        timer = setTimeout(() => {
            controller?.abort();
            resolve(TIMED_OUT);
        }, timeoutMs);
    });
    let response;
    try {
        response = await Promise.race([
            Promise.resolve().then(() => fetchImpl(shortUrl, {
                method: 'GET',
                redirect: 'manual',
                headers: { 'User-Agent': DESKTOP_CHROME_UA },
                signal: controller?.signal,
            })),
            timedOut,
        ]);
    } catch (error) {
        // 只有自己的掐表会 abort，所以 AbortError 也算超时。错误信息可能带地址，不往外带。
        return fail(error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'timeout' : 'fetch_error');
    } finally {
        clearTimeout(timer);
    }
    if (response === TIMED_OUT) return fail('timeout');
    // 只要跳转地址：响应体不读，能取消就取消（放掉连接）。
    try {
        response?.body?.cancel?.()?.catch?.(() => {});
    } catch {
        // 取消不了就算了。
    }
    const status = Number(response?.status);
    if (!(status >= 300 && status < 400)) return fail(`not_redirect:${Number.isFinite(status) ? status : 'none'}`);
    let location = null;
    try {
        location = response.headers?.get?.('location') || null;
    } catch {
        location = null;
    }
    if (!location) return fail('no_location');
    let target = null;
    try {
        target = parseTarget(location);
    } catch {
        target = null;
    }
    if (!target) return fail('bad_location');
    return { ok: true, target, reason: null };
}

/**
 * 只问短链跳去哪：GET、redirect: 'manual'（不跟随跳转、不开网页）、带桌面 Chrome 的 User-Agent、timeoutMs（默认 8 秒）
 * 超时；只看 3xx 的 location 头，交给 parseTarget（传 noteTargetFromUrl）认它是不是主站帖子、带不带通行码。
 * 不抛，返回 { ok, target, reason }：ok 时 target 是 { noteId, xsecToken, xsecSource }（交给 openNoteInPage）、reason 为 null；
 * 不成 target 为 null，reason 是 no_fetch / no_parser / timeout / fetch_error / not_redirect:<状态码|none> / no_location /
 * bad_location / unexpected。往 stderr 写一行 [xhs-resident] shortlink=resolved 或 [xhs-resident] shortlink=fallback:<原因>，
 * 不带任何地址（短链码、通行码、分享人标识都不写）。
 * [xhs-resident] 开头的 stderr 行是留给定时任务解析的协议，格式别随便改。
 */
export async function resolveShortLink(shortUrl, { fetch: fetchImpl, parseTarget, timeoutMs = SHORT_LINK_TIMEOUT_MS } = {}) {
    let result;
    try {
        result = await askRedirect(String(shortUrl ?? '').trim(), fetchImpl, parseTarget, timeoutMs);
    } catch {
        result = fail('unexpected');
    }
    process.stderr.write(`[xhs-resident] shortlink=${result.ok ? 'resolved' : `fallback:${result.reason}`}\n`);
    return result;
}
