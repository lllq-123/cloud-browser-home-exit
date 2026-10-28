// 改自 OpenCLI 1.8.7 的 clis/xiaohongshu/note-helpers.js（Apache-2.0），改动见 NOTICE.md
import { ArgumentError } from '@jackwener/opencli/errors';

/** Side-effect-free helpers shared by xiaohongshu note and comments commands. */
/** Extract a bare note ID from a full URL or raw ID string. */
export function parseNoteId(input) {
    const trimmed = input.trim();
    const match = trimmed.match(/\/(?:explore|note|search_result|discovery\/item)\/([a-f0-9]+)|\/user\/profile\/[^/?#]+\/([a-f0-9]+)/i);
    return match ? (match[1] || match[2]) : trimmed;
}

export const XHS_SIGNED_URL_HINT = 'Pass a full Xiaohongshu note URL with xsec_token from search results or user/profile context.';

/** App 分享短链：老的 xhslink.com 和现在 App 分享出来的 xhslink.cn（形如 https://xhslink.cn/o/<码>）。 */
export function isShortLink(input) {
    return /^https?:\/\/xhslink\.(?:com|cn)\//i.test(String(input ?? '').trim());
}

function isHostMatch(hostname, cookieRoot) {
    const normalized = hostname.toLowerCase();
    return normalized === cookieRoot || normalized.endsWith('.' + cookieRoot);
}

function isSupportedNotePath(pathname) {
    return /^\/(?:explore|note|search_result|discovery\/item)\/[a-f0-9]+(?:[/?#]|$)/i.test(pathname)
        || /^\/user\/profile\/[^/?#]+\/[a-f0-9]+(?:[/?#]|$)/i.test(pathname);
}

/**
 * Build the best navigation URL for a note.
 *
 * XHS note detail pages now require a valid signed URL for reliable access.
 * Bare note IDs no longer resolve deterministically, so callers must provide
 * a full note URL with xsec_token or, for downloads only, an xhslink short link.
 *
 * `options.cookieRoot` overrides the default `xiaohongshu.com` cookie root —
 * the rednote adapter passes `'rednote.com'` so the same validator accepts
 * `www.rednote.com` URLs without duplicating this function.
 * `options.signedUrlHint` overrides the default hint surfaced on rejection.
 */
export function buildNoteUrl(input, options = {}) {
    const {
        allowShortLink = false,
        commandName = 'xiaohongshu note',
        cookieRoot = 'xiaohongshu.com',
        signedUrlHint = XHS_SIGNED_URL_HINT,
    } = options;
    const trimmed = input.trim();
    const message = `${commandName} now requires a full signed URL`;
    const hint = allowShortLink
        ? `${signedUrlHint} For downloads, xhslink short links are also supported.`
        : signedUrlHint;

    if (/^https?:\/\//.test(trimmed)) {
        if (isShortLink(trimmed)) {
            if (allowShortLink)
                return trimmed;
            throw new ArgumentError(message, hint);
        }
        try {
            const url = new URL(trimmed);
            const xsecToken = url.searchParams.get('xsec_token')?.trim();
            if (isHostMatch(url.hostname, cookieRoot) && isSupportedNotePath(url.pathname) && xsecToken) {
                return trimmed;
            }
        }
        catch { }
        throw new ArgumentError(message, hint);
    }
    throw new ArgumentError(message, hint);
}

/** 浏览器内共享的访问状态识别；通过 toString() 注入，保持函数自包含。 */
export function inspectNoteAccess() {
    const bodyText = document.body?.innerText || '';
    const pageUrl = new URL(location.href);
    // 标题、正文、评论和推荐都可能讨论报错；先确认笔记确实存在。
    const scope = document.querySelector('#noteContainer');
    const clean = (selector) => (scope?.querySelector(selector)?.textContent || '').replace(/\s+/g, ' ').trim();
    const author = clean('.username, .author-wrapper .name');
    const title = clean('#detail-title, .title');
    const desc = clean('#detail-desc, .desc, .note-text');
    const media = scope?.querySelector('.swiper-slide img, .carousel-image img, .note-slider img, .note-image img, .image-wrapper img, .media-container img, video');
    const hasReadableNote = !!(scope && author && (title || desc || media));
    const visible = (element) => {
        const rect = element?.getBoundingClientRect?.();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
        if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
        const width = typeof innerWidth === 'number' ? innerWidth : Infinity;
        const height = typeof innerHeight === 'number' ? innerHeight : Infinity;
        return rect.right > 0 && rect.bottom > 0 && rect.left < width && rect.top < height;
    };
    // 登录弹窗可以盖在已加载的笔记上；只识别可见、含实际登录控件的面板。
    const loginPanel = Array.from(document.querySelectorAll('.login-container, [role="dialog"], [aria-modal="true"]')).some((element) => {
        if (!visible(element)) return false;
        const text = element.innerText || element.textContent || '';
        const controls = element.querySelector('input[type="tel"], input[autocomplete="tel"], input[autocomplete="one-time-code"], .qrcode, .qr-code, canvas');
        return !!controls && /登录|扫码/.test(text);
    });
    const onLoginPage = /^\/(?:login|website-login\/login)(?:\/|$)/.test(pageUrl.pathname);
    const onErrorPage = /^\/website-login\/error(?:\/|$)/.test(pageUrl.pathname)
        || ['300017', '300031'].includes(pageUrl.searchParams.get('error_code'));
    return {
        hasReadableNote,
        securityBlock: onErrorPage || (!hasReadableNote && /安全限制|访问链接异常/.test(bodyText)),
        loginWall: onLoginPage || loginPanel || (!hasReadableNote && /登录后查看|请登录|登录后才能/.test(bodyText)),
        notFound: pageUrl.pathname === '/404' || (!hasReadableNote && /页面不见了|笔记不存在|无法浏览/.test(bodyText)),
    };
}
