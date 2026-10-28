// 改自 OpenCLI 1.8.7 的 clis/xiaohongshu/download.js（Apache-2.0），改动见 NOTICE.md
/**
 * Xiaohongshu download — download images and videos from a note.
 *
 * Usage:
 *   opencli xiaohongshu download <signed-note-url-or-shortlink> --output ./xhs
 *
 * Accepts a full xiaohongshu.com URL with xsec_token or an xhslink short link.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { formatCookieHeader } from '@jackwener/opencli/download';
import { downloadMedia } from '@jackwener/opencli/download/media-download';
import { AuthRequiredError, CliError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { buildNoteUrl, parseNoteId, inspectNoteAccess, isShortLink } from './note-helpers.js';
import { noteTargetFromUrl, openNoteInPage, reportResident } from './resident-helpers.js';
import { resolveShortLink } from './short-link.js';

/**
 * 安全限制 / 登录墙 / 不存在：取数结果和「页内打开没成」时只跑的访问检查（inspectNoteAccess）共用这几条报错。
 * 取数脚本只带 securityBlock，登录墙 / 不存在两条只会在页内打开没成时由访问检查报出来（和 note 命令同一种错）。
 */
function throwDownloadAccessError(state, rawInput, noteId) {
    if (state?.securityBlock) {
        throw new CliError('SECURITY_BLOCK', 'Xiaohongshu security block: the note detail page was blocked by risk control.', /^https?:\/\//.test(rawInput)
            ? 'The page may be temporarily restricted. Try again later or from a different session.'
            : 'Try using a full URL from search results (with xsec_token) instead of a bare note ID.');
    }
    if (state?.loginWall) {
        throw new AuthRequiredError('www.xiaohongshu.com', 'Note media requires login');
    }
    if (state?.notFound) {
        throw new EmptyResultError('xiaohongshu download', `Note ${noteId} not found or unavailable — it may have been deleted or restricted`);
    }
}

/**
 * 在常驻页里页内打开这条帖子（openNoteInPage，做法见 resident-helpers.js 文件头），往 stderr 报常驻页情况（reportResident）。
 * 没打开（ok:false）时页面停在哪不确定（安全限制页 / 登录页 / 别的帖子都可能），绝不取数：只跑访问检查，认出安全限制 /
 * 登录墙 / 不存在就报对应的错，都不是就报打开失败（带 openNoteInPage 的原因）。
 * 打开了就返回是不是页内换路由打开的（openNoteInPage 的 inPage）：true 时文档是常驻页旧的那份，取数要防着（见
 * buildDownloadExtractJs）；false 是 openNoteInPage 自己整页兜底打开的，文档就是这条帖子刚加载的，照旧取数。
 */
async function openInResidentPage(page, target, rawInput, noteId) {
    const opened = await openNoteInPage(page, target);
    await reportResident(page, opened.resident);
    if (opened.ok) return opened.inPage === true;
    let access = null;
    try {
        access = await page.evaluate(`(${inspectNoteAccess.toString()})()`);
    } catch {
        access = null;
    }
    throwDownloadAccessError(access, rawInput, noteId);
    throw new CommandExecutionError(`xiaohongshu download: could not open note ${noteId} in the resident page (${opened.reason})`,
        'Opening the note inside the resident Xiaohongshu page failed. Try again later.');
}

/**
 * Build the media-extraction IIFE. The note id is interpolated as a default
 * since the IIFE may also resolve it from `location.pathname`. The CDN
 * substring allowlist includes `rednote` so the rednote adapter can reuse
 * this script unchanged — image / video URLs on both sites are served from
 * the same xhscdn family per #1136.
 *
 * `inPage`：帖子是在常驻页里页内换路由打开的（openNoteInPage 返回 inPage:true）。页内换路由不重载文档，页面脚本是这张页
 * 「当初整页打开时」那份（可能是别的帖子的 SSR，比如一条视频帖的 mp4 地址），详情弹层后面还盖着推流卡片，noteDetailMap 里
 * 也可能只剩别的帖子。所以页内打开时：视频 Method 2（扫页面脚本）跳过；图片 DOM 兜底和视频 Method 3 只在 #noteContainer
 * 里找，没有 #noteContainer 就什么都不找、不退回全页；Method 1 只按编号取，不用「整张表只有一条就拿它」的老兼容兜底。
 * 不传 / false（整页打开的：goto，或 openNoteInPage 自己整页兜底，文档就是这条帖子刚加载的）行为照旧。
 */
export function buildDownloadExtractJs(noteId, { inPage = false } = {}) {
    return `
      (() => {
        const result = {
          noteId: '${noteId}',
          pageUrl: location.href,
          securityBlock: (${inspectNoteAccess.toString()})().securityBlock,
          title: '',
          author: '',
          media: []
        };
        // 页内打开时 DOM 兜底只在详情弹层 #noteContainer 里找（为什么见 buildDownloadExtractJs 的说明）；整页打开照旧全页找。
        const inPage = ${inPage ? 'true' : 'false'};
        const domScope = inPage ? document.querySelector('#noteContainer') : document;
        const findAll = (selector) => (domScope ? Array.from(domScope.querySelectorAll(selector)) : []);
        const seenMedia = new Set();
        const pushMedia = (type, url) => {
          if (!url) return;
          const key = type + ':' + url;
          if (seenMedia.has(key)) return;
          seenMedia.add(key);
          result.media.push({ type, url });
        };
        const locationMatch = (location.pathname || '').match(/\\/(?:explore|note|search_result|discovery\\/item)\\/([a-f0-9]+)|\\/user\\/profile\\/[^/?#]+\\/([a-f0-9]+)/i);
        if (locationMatch) {
          result.noteId = locationMatch[1] || locationMatch[2];
        }

        // Get title
        const titleEl = document.querySelector('.title, #detail-title, .note-content .title');
        result.title = titleEl?.textContent?.trim() || 'untitled';

        // Get author
        const authorEl = document.querySelector('.username, .author-name, .name');
        result.author = authorEl?.textContent?.trim() || 'unknown';

        // Get images: prefer canonical carousel order from __INITIAL_STATE__
        // so the saved order matches what the user sees on the platform (#1514).
        // DOM extraction is used only as a fallback because multiple selectors,
        // hidden / duplicated / preloaded slides, and lazy rendering can reorder
        // the discovered nodes away from the platform's display order.

        const normalizeImageUrl = (raw) => {
          if (!raw || typeof raw !== 'string') return '';
          let src = raw.split('?')[0];
          src = src.replace(/\\/imageView\\d+\\/\\d+\\/w\\/\\d+/, '');
          return src;
        };
        const orderedImageUrls = [];
        const seenImageUrls = new Set();
        const pushImage = (url) => {
          if (!url || seenImageUrls.has(url)) return;
          seenImageUrls.add(url);
          orderedImageUrls.push(url);
        };

        const getStructuredNotes = () => {
          const state = window.__INITIAL_STATE__;
          const noteData = state?.note?.noteDetailMap || state?.note?.note || {};
          if (!noteData || typeof noteData !== 'object') return [];
          const currentIds = [...new Set([result.noteId, '${noteId}'].filter(Boolean))];
          const notes = [];
          for (const id of currentIds) {
            const entry = noteData[id];
            const note = entry?.note || entry;
            if (note && typeof note === 'object') notes.push(note);
          }
          // Compatibility fallback for legacy single-note stores. Do not use this
          // when keyed detail maps contain multiple notes, or carousel order can
          // be polluted by preloaded/previous note entries.
          const keys = Object.keys(noteData);
          // 页内打开时不用：表里只剩的那一条可能是常驻页当初整页打开的别的帖子。
          if (!inPage && notes.length === 0 && keys.length === 1) {
            const entry = noteData[keys[0]];
            const note = entry?.note || entry;
            if (note && typeof note === 'object') notes.push(note);
          }
          return notes;
        };

        // Method 1: walk __INITIAL_STATE__.note.noteDetailMap[id].note.imageList
        // in array order. Each entry exposes urlDefault as the canonical CDN URL.
        let imageInitialStateUsed = false;
        try {
          for (const note of getStructuredNotes()) {
            const list = Array.isArray(note?.imageList) ? note.imageList : [];
            for (const item of list) {
              const candidate = item?.urlDefault || item?.urlPre || item?.url
                || item?.infoList?.find(i => i?.imageScene === 'WB_DFT')?.url
                || item?.infoList?.[0]?.url
                || '';
              const src = normalizeImageUrl(candidate);
              if (src && (src.includes('xhscdn') || src.includes('xiaohongshu') || src.includes('rednote'))) {
                pushImage(src);
                imageInitialStateUsed = true;
              }
            }
          }
        } catch(e) {}

        // Method 2: fallback to DOM scraping when the structured state is missing
        // (e.g. preview pages without full SSR hydration). Order may differ from
        // the carousel; surface it anyway rather than returning zero images.
        if (!imageInitialStateUsed) {
          const imageSelectors = [
            '.swiper-slide img',
            '.carousel-image img',
            '.note-slider img',
            '.note-image img',
            '.image-wrapper img',
            '#noteContainer .media-container img[src*="xhscdn"]',
            'img[src*="ci.xiaohongshu.com"]'
          ];
          for (const selector of imageSelectors) {
            findAll(selector).forEach(img => {
              const raw = img.src || img.getAttribute('data-src') || '';
              const src = normalizeImageUrl(raw);
              if (src && (src.includes('xhscdn') || src.includes('xiaohongshu') || src.includes('rednote'))) {
                pushImage(src);
              }
            });
          }
        }

        // Get video — prefer real URL from page state over blob: URLs

        // Method 1: Extract from __INITIAL_STATE__ (SSR hydration data)
        try {
          for (const note of getStructuredNotes()) {
            const video = note?.video;
            if (video) {
              const vUrl = video.url || video.originVideoKey || video.consumer?.originVideoKey;
              if (vUrl) {
                const fullUrl = vUrl.startsWith('http') ? vUrl : 'https://sns-video-bd.xhscdn.com/' + vUrl;
                pushMedia('video', fullUrl);
              }
              const streams = video.media?.stream?.h264 || [];
              for (const stream of streams) {
                if (stream.masterUrl) pushMedia('video', stream.masterUrl);
              }
            }
          }
        } catch(e) {}

        // Method 2: Extract video URLs from inline script JSON
        // 页内打开时跳过：页面脚本是这张页当初整页打开时那份，可能是别的帖子的。
        if (!inPage && result.media.filter(m => m.type === 'video').length === 0) {
          try {
            const scripts = document.querySelectorAll('script');
            for (const s of scripts) {
              const text = s.textContent || '';
              const videoMatches = text.match(/https?:\\/\\/sns-video[^"'\\s]+\\.mp4[^"'\\s]*/g)
                || text.match(/https?:\\/\\/[^"'\\s]*xhscdn[^"'\\s]*\\.mp4[^"'\\s]*/g);
              if (videoMatches) {
                videoMatches.forEach(url => {
                  pushMedia('video', url.replace(/\\\\u002F/g, '/'));
                });
              }
            }
          } catch(e) {}
        }

        // Method 3: Fallback to DOM video elements, skip blob: URLs
        if (result.media.filter(m => m.type === 'video').length === 0) {
          const videoSelectors = [
            'video source',
            'video[src]',
            '.player video',
            '.video-player video'
          ];
          for (const selector of videoSelectors) {
            findAll(selector).forEach(v => {
              const src = v.src || v.getAttribute('src') || '';
              if (src && !src.startsWith('blob:')) {
                pushMedia('video', src);
              }
            });
          }
        }

        // Preserve the pre-existing media type order (videos first, then images)
        // while keeping image carousel order stable within the image batch.
        orderedImageUrls.forEach(url => pushMedia('image', url));

        return result;
      })()
    `;
}
export const command = cli({
    site: 'xiaohongshu',
    name: 'download',
    access: 'read',
    description: '下载小红书笔记中的图片和视频',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    // 走常驻页（opencli 常驻会话 site:xiaohongshu）：帖子在常驻页里页内打开，不整页打开主站（为什么见 resident-helpers.js 文件头）。
    siteSession: 'persistent',
    args: [
        { name: 'note-id', positional: true, required: true, help: 'Full Xiaohongshu note URL with xsec_token, or xhslink short link' },
        { name: 'output', default: './xiaohongshu-downloads', help: 'Output directory' },
        // opencli 只认名叫 timeout 的参数来定整条命令的上限（= timeout + 30 秒）；不写是 60 秒，装不下页内打开最坏约 85 秒。
        { name: 'timeout', type: 'int', required: false, default: 120, help: 'Max seconds for the overall command (default: 120)' },
    ],
    columns: ['index', 'type', 'status', 'size'],
    func: async (page, kwargs) => {
        const rawInput = String(kwargs['note-id']);
        const output = kwargs.output;
        const url = buildNoteUrl(rawInput, { allowShortLink: true, commandName: 'xiaohongshu download' });
        // 短链（xhslink.com / xhslink.cn）先只问跳转地址、不开网页（short-link.js）；解不开就照旧整页打开短链（经手机出口）。
        const target = isShortLink(url)
            ? (await resolveShortLink(url, { fetch: globalThis.fetch, parseTarget: noteTargetFromUrl })).target
            : noteTargetFromUrl(url);
        const noteId = target ? target.noteId : parseNoteId(rawInput);
        // 页内换路由打开的（inPage=true）取数时别信页面脚本和弹层外的东西；整页打开的（下面的 goto，或 openNoteInPage
        // 自己整页兜底）文档就是这条帖子刚加载的，照旧。
        let inPage = false;
        if (target) {
            inPage = await openInResidentPage(page, target, rawInput, noteId);
        }
        else {
            await page.goto(url);
        }
        await page.wait({ time: 1 + Math.random() * 2 });
        const data = await page.evaluate(buildDownloadExtractJs(noteId, { inPage }));
        throwDownloadAccessError(data, rawInput, noteId);
        if (!data || typeof data !== 'object' || !Array.isArray(data.media)) {
            throw new CommandExecutionError('Xiaohongshu media extraction returned malformed payload.');
        }
        if (data.media.length === 0) {
            throw new EmptyResultError('xiaohongshu download', 'No downloadable media found on this note.');
        }
        // Extract cookies for authenticated downloads
        const cookies = formatCookieHeader(await page.getCookies({ domain: 'xiaohongshu.com' }));
        const resolvedNoteId = typeof data.noteId === 'string' && data.noteId.trim()
            ? data.noteId.trim()
            : noteId;
        return downloadMedia(data.media, {
            output,
            subdir: resolvedNoteId,
            cookies,
            filenamePrefix: resolvedNoteId,
            timeout: 60000,
        });
    },
});
