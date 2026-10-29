// 改自 OpenCLI 1.8.7 的 clis/xiaohongshu/comments.js（Apache-2.0），改动见 NOTICE.md
/**
 * Xiaohongshu comments — DOM extraction from note detail page.
 * XHS API requires signed requests, so we scrape the rendered DOM instead.
 *
 * Supports both top-level comments and nested replies (楼中楼) via
 * the --with-replies flag.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CliError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { parseNoteId, buildNoteUrl, inspectNoteAccess } from './note-helpers.js';
import { noteTargetFromUrl, openNoteInPage, reportResident } from './resident-helpers.js';

const XHS_PROFILE_HREF_SELECTOR = '.author-wrapper a[href*="/user/profile/"], a.name[href*="/user/profile/"], a.user-name[href*="/user/profile/"], a[href*="/user/profile/"]';

export function parseXhsProfileHref(href, webHost = 'www.xiaohongshu.com') {
    const raw = typeof href === 'string' ? href.trim() : '';
    if (!raw)
        return '';
    const expectedHost = String(webHost || 'www.xiaohongshu.com').toLowerCase();
    let parsed;
    try {
        parsed = new URL(raw, `https://${expectedHost}`);
    }
    catch {
        return '';
    }
    if (parsed.protocol !== 'https:')
        return '';
    const host = parsed.hostname.toLowerCase();
    if (host !== expectedHost)
        return '';
    const match = parsed.pathname.match(/^\/user\/profile\/([a-zA-Z0-9]+)\/?$/);
    return match?.[1] ?? '';
}

export function buildXhsProfileUrl(href, webHost = 'www.xiaohongshu.com') {
    const userId = parseXhsProfileHref(href, webHost);
    if (!userId)
        return '';
    return `https://${webHost}/user/profile/${userId}`;
}
export function parseCommentLimit(raw, fallback = 20) {
    const n = Number(raw);
    if (!Number.isFinite(n))
        return fallback;
    return Math.max(1, Math.min(Math.floor(n), 50));
}

export function parseXhsLikeCountText(value) {
    const integerRe = /^(?:\d+|\d{1,3}(?:[,，]\d{3})+)\+?$/u;
    const shortformRe = /^((?:\d+|\d{1,3}(?:[,，]\d{3})+)(?:\.\d+)?)([wWkK万千])\+?$/u;
    const raw = String(value ?? '').replace(/\s+/g, '');
    if (!raw)
        return 0;
    if (integerRe.test(raw))
        return Number(raw.replace(/[,+，]/g, ''));
    const short = raw.match(shortformRe);
    if (!short)
        return 0;
    const numeric = Number(short[1].replace(/[,，]/g, ''));
    if (!Number.isFinite(numeric))
        return 0;
    const unit = short[2].toLowerCase();
    const multiplier = unit === 'w' || unit === '万' ? 10000 : 1000;
    return Math.round(numeric * multiplier);
}

function normalizeOptionalString(value, field, commandName) {
    if (value == null)
        return '';
    if (typeof value !== 'string') {
        throw new CommandExecutionError(`${commandName}: malformed comment row ${field}`);
    }
    return value;
}

export function normalizeCommentImages(value, commandName) {
    if (value == null)
        return [];
    if (!Array.isArray(value)) {
        throw new CommandExecutionError(`${commandName}: malformed comment row images`);
    }
    const urls = [];
    for (const raw of value) {
        if (typeof raw !== 'string') {
            throw new CommandExecutionError(`${commandName}: malformed comment row image URL`);
        }
        const trimmed = raw.trim();
        let parsed;
        try {
            parsed = new URL(trimmed);
        }
        catch {
            throw new CommandExecutionError(`${commandName}: malformed comment row image URL`);
        }
        if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) {
            throw new CommandExecutionError(`${commandName}: malformed comment row image URL`);
        }
        const href = parsed.toString();
        if (!urls.includes(href))
            urls.push(href);
    }
    return urls;
}

export function normalizeCommentRows(value, commandName = 'xiaohongshu/comments') {
    if (value == null)
        return [];
    if (!Array.isArray(value)) {
        throw new CommandExecutionError(`${commandName}: malformed comments payload`);
    }
    return value.map((row, index) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new CommandExecutionError(`${commandName}: malformed comment row at index ${index}`);
        }
        const text = normalizeOptionalString(row.text, 'text', commandName);
        if (!text) {
            throw new CommandExecutionError(`${commandName}: malformed comment row text`);
        }
        const likes = Number(row.likes);
        if (!Number.isInteger(likes) || likes < 0) {
            throw new CommandExecutionError(`${commandName}: malformed comment row likes`);
        }
        if (typeof row.is_reply !== 'boolean') {
            throw new CommandExecutionError(`${commandName}: malformed comment row is_reply`);
        }
        return {
            author: normalizeOptionalString(row.author, 'author', commandName),
            authorHrefRaw: normalizeOptionalString(row.authorHrefRaw, 'authorHrefRaw', commandName),
            text,
            likes,
            time: normalizeOptionalString(row.time, 'time', commandName),
            is_reply: row.is_reply,
            reply_to: normalizeOptionalString(row.reply_to, 'reply_to', commandName),
            images: normalizeCommentImages(row.images, commandName),
        };
    });
}

/*
 * 读评论分步走：帖子打开后由 node 一步一步驱动——滚动一步、展开一步、最后取数一次，每一步是一次很短的 evaluate。
 * 页内脚本一律同步，不在页面里等：opencli 给每一次 evaluate 单独限时（= --timeout），原来滚动 + 展开 + 取数塞在一次
 * evaluate 里，帖子一大就撞线；页面在后台时浏览器还可能放慢页面里的计时器（推断，没复现）。所有等待都在 node 侧
 * page.wait（node 侧计时）。
 */

/**
 * 能返回的主评论（页内跑：toString 嵌进滚动 / 展开 / 取数三个脚本，三处共用这一个判断）：.parent-comment 里有 .comment-item、
 * 正文（.content / .note-text）有字。取数只收这种楼，纯图片 / 空正文的楼连同回复一起跳过，所以「够不够 limit」「展开哪几楼」
 * 「取哪几楼」都按它数——先按原始楼层截前 limit 个再跳，后面已经加载出来的有字楼就补不上（10-29 review 发现：要 50 给 48）。
 */
export function returnableParentComments(doc) {
    return Array.from(doc.querySelectorAll('.parent-comment')).filter((thread) => {
        const item = thread.querySelector('.comment-item');
        return Boolean(item) && (item.querySelector('.content, .note-text')?.textContent || '').replace(/\s+/g, ' ').trim() !== '';
    });
}

/**
 * 滚动一步（页内同步短脚本）。action：inspect 只看不动；bottom 滚到底；nudge 往上挪 max(2 × 可视高度, 1200) 像素（不低于 0）。
 * 已经在底时再滚到底等于原地不动，网站不加载下一页——得先往上挪一下、等一会儿再滚到底（10-29 实测）。
 * 滚动区：帖子弹层里真正在滚的 .note-scroller（能滚才算），否则整页（document.scrollingElement）。弹层下绝不用
 * window.scrollTo / scrollIntoView：那样滚的是弹层后面的首页推流，白白多拉推流数据（10-29 实测）；只有整页版式那一支用 window.scrollTo。
 * 返回 { parents, returnable, end, atBottom, total }：已加载的主评论（.parent-comment）个数、其中能返回的个数（见
 * returnableParentComments，纯图片 / 空正文楼不算）、有没有 .end-container（全部加载完）、滚动区是不是在底（误差 4px）、
 * 评论区「共 N 条评论」里的 N（支持「1.2万」，认不出给 null）。
 */
export function buildCommentsScrollStepJs(action = 'inspect') {
    if (!['inspect', 'bottom', 'nudge'].includes(action)) {
        throw new Error(`xiaohongshu comments: unknown scroll step "${action}"`);
    }
    return `
      (() => {
        const action = ${JSON.stringify(action)}
        const noteScroller = document.querySelector('.note-scroller')
        // 有评论区就只滚它（滚不动也只是原地不动）：弹层下退回去滚整页会滚到后面的首页推流
        const inNoteScroller = Boolean(noteScroller)
        const scroller = inNoteScroller ? noteScroller : (document.scrollingElement || document.documentElement)
        const scrollToY = (top) => {
          if (inNoteScroller) {
            noteScroller.scrollTo({ top, behavior: 'instant' })
          } else {
            // 整页版式：文档自己在滚（护栏只放行这一处）
            window.scrollTo({ top, behavior: 'instant' })
          }
        }
        if (action === 'bottom') scrollToY(scroller.scrollHeight)
        if (action === 'nudge') scrollToY(Math.max(0, scroller.scrollTop - Math.max(2 * scroller.clientHeight, 1200)))
        const totalOf = () => {
          for (const el of document.querySelectorAll('.total')) {
            const match = (el.textContent || '').replace(/\\s+/g, '').match(/共([\\d.,，]+)([万wW千kK]?)\\+?条评论/)
            if (!match) continue
            const value = Number(match[1].replace(/[,，]/g, ''))
            if (!Number.isFinite(value)) return null
            const unit = /[万wW]/.test(match[2]) ? 10000 : /[千kK]/.test(match[2]) ? 1000 : 1
            return Math.round(value * unit)
          }
          return null
        }
        return {
          parents: document.querySelectorAll('.parent-comment').length,
          returnable: (${returnableParentComments.toString()})(document).length,
          end: Boolean(document.querySelector('.end-container')),
          atBottom: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4,
          total: totalOf(),
        }
      })()
    `;
}

/** 展开阶段开始前清一次「每楼点过什么」的记录（记在 window 上，见 buildCommentsExpandStepJs）。 */
export function buildCommentsExpandResetJs() {
    return `
      (() => {
        window.__xhsCommentsExpand = new WeakMap()
        return true
      })()
    `;
}

/**
 * 展开一步（页内同步短脚本）：只在前 limit 个能返回的主评论（returnableParentComments，即取数要取的那几楼）里找「展开回复」
 * 一类的按钮点，文字规则和候选元素沿用原来的写法。每楼同一种文字只点一次、每楼最多点 3 次（跨步记在 window.__xhsCommentsExpand 这个 WeakMap 里：
 * 楼元素 → 点过的文字 + 次数），这一步最多点 maxClicks 个。点完就返回，等回复出来是 node 侧的事。
 * 返回 { clicked, pendingThreads }：这一步点了几个、点完后还有几楼有没点过的展开按钮（且次数没到 3）。
 */
export function buildCommentsExpandStepJs(limit = 20, maxClicks = 3) {
    return `
      (() => {
        const targetCount = ${Number(limit) || 20}
        const maxClicks = ${Number(maxClicks) || 3}
        const perThread = 3
        const clean = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim()
        if (!(window.__xhsCommentsExpand instanceof WeakMap)) window.__xhsCommentsExpand = new WeakMap()
        const memo = window.__xhsCommentsExpand
        const expandersOf = (thread, done) => {
          const found = Array.from(thread.querySelectorAll('button, [role="button"], span, div')).filter(el => {
            if (!(el instanceof HTMLElement)) return false
            const text = clean(el)
            if (!text || text.length > 24) return false
            if (!/(展开|更多回复|全部回复|查看.*回复|共\\d+条回复)/.test(text)) return false
            return !done.has(text)
          })
          // 同一段文字常套在几层元素里（div > span）：点最里面那层，点击会一路冒泡经过外面几层
          return found.filter(el => !found.some(other => other !== el && el.contains(other) && clean(other) === clean(el)))
        }
        let clicked = 0
        let pendingThreads = 0
        for (const thread of (${returnableParentComments.toString()})(document).slice(0, targetCount)) {
          let record = memo.get(thread)
          if (!record) {
            record = { texts: new Set(), count: 0 }
            memo.set(thread, record)
          }
          for (const el of expandersOf(thread, record.texts)) {
            if (clicked >= maxClicks || record.count >= perThread) break
            const text = clean(el)
            if (record.texts.has(text)) continue
            el.click()
            record.texts.add(text)
            record.count++
            clicked++
          }
          if (record.count < perThread && expandersOf(thread, record.texts).length) pendingThreads++
        }
        return { clicked, pendingThreads }
      })()
    `;
}

/**
 * 取数（页内同步短脚本）：开头先做访问检查（inspectNoteAccess），再只取前 limit 个能返回的主评论（returnableParentComments）
 * 及其楼中楼回复；不滚、不点、不等——滚动和展开在这之前由 node 分步做完。选择器和字段沿用原来的写法（原注释：导出是为了 rednote 适配器复用同一条选择器链）。
 * 返回 { pageUrl, securityBlock, loginWall, results }。
 */
export function buildCommentsExtractJs(withReplies, limit = 20) {
    const parseLikeCountText = parseXhsLikeCountText.toString();
    return `
      (() => {
        const withReplies = ${withReplies}
        const targetCount = ${Number(limit) || 20}

        // Check login state
        const { securityBlock, loginWall } = (${inspectNoteAccess.toString()})()

        const clean = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim()
        const parseLikeCountText = ${parseLikeCountText}
        const parseLikes = (el) => {
          return parseLikeCountText(clean(el))
        }
        const HREF_SELECTOR = ${JSON.stringify(XHS_PROFILE_HREF_SELECTOR)}
        const extractAuthorHref = (el) => {
          if (!el) return ''
          const anchor = el.querySelector(HREF_SELECTOR)
          return anchor ? (anchor.getAttribute('href') || '') : ''
        }
        // Attached comment photos, excluding avatars, inline emoji, badges, and
        // other UI images. Only images inside comment/reply media containers are
        // projected as media evidence.
        const extractImages = (el) => {
          if (!el) return []
          const urls = []
          el.querySelectorAll('img').forEach(img => {
            if (img.classList.contains('avatar-item')) return
            if (img.closest('.content, .note-text')) return
            if (!img.closest('.comment-pic, .reply-pic, .comment-image, .reply-image, .comment-img, .reply-img, [class*="comment-pic"], [class*="reply-pic"], [class*="comment-image"], [class*="reply-image"]')) return
            const src = img.currentSrc || img.src || img.getAttribute('data-src') || ''
            if (src && !urls.includes(src)) urls.push(src)
          })
          return urls
        }
        const results = []
        // 只取前 targetCount 个能返回的主评论（及其回复）：先筛掉纯图片 / 空正文楼再数，后面已加载的有字楼照样补上
        const parents = (${returnableParentComments.toString()})(document).slice(0, targetCount)
        for (const p of parents) {
          const item = p.querySelector('.comment-item')
          if (!item) continue

          const author = clean(item.querySelector('.author-wrapper .name, .user-name'))
          const authorHrefRaw = extractAuthorHref(item)
          const text = clean(item.querySelector('.content, .note-text'))
          const likes = parseLikes(item.querySelector('.count'))
          const time = clean(item.querySelector('.date, .time'))
          const images = extractImages(item)

          if (!text) continue
          results.push({ author, authorHrefRaw, text, likes, time, is_reply: false, reply_to: '', images })

          // Extract nested replies (楼中楼)
          if (withReplies) {
            p.querySelectorAll('.reply-container .comment-item-sub, .sub-comment-list .comment-item').forEach(sub => {
              const sAuthor = clean(sub.querySelector('.name, .user-name'))
              const sAuthorHrefRaw = extractAuthorHref(sub)
              const sContent = sub.querySelector('.content, .note-text')
              const sText = clean(sContent)
              // Xiaohongshu renders the direct target only for reply-to-reply
              // rows (回复 <span class="nickname">Bob</span> : ...). A nested
              // row without that marker is a direct reply to the thread root.
              const sReplyTo = clean(sContent?.querySelector(':scope > .nickname')) || author
              const sLikes = parseLikes(sub.querySelector('.count'))
              const sTime = clean(sub.querySelector('.date, .time'))
              const sImages = extractImages(sub)
              if (!sText) return
              results.push({ author: sAuthor, authorHrefRaw: sAuthorHrefRaw, text: sText, likes: sLikes, time: sTime, is_reply: true, reply_to: sReplyTo, images: sImages })
            })
          }
        }

        return { pageUrl: location.href, securityBlock, loginWall, results }
      })()
    `;
}

/**
 * 安全限制 / 登录墙 / 不存在：取数结果和「页内打开没成」时只跑的访问检查（inspectNoteAccess）共用这几条报错。
 * 取数脚本只带 securityBlock / loginWall 两样，不存在那条只会在页内打开没成时由访问检查报出来（和 note 命令同一种错）。
 */
function throwCommentsAccessError(state, raw, noteId) {
    if (state?.securityBlock) {
        throw new CliError('SECURITY_BLOCK', 'Xiaohongshu security block: the note detail page was blocked by risk control.', /^https?:\/\//.test(raw)
            ? 'The page may be temporarily restricted. Try again later or from a different session.'
            : 'Try using a full URL from search results (with xsec_token) instead of a bare note ID.');
    }
    if (state?.loginWall) {
        throw new AuthRequiredError('www.xiaohongshu.com', 'Note comments require login');
    }
    if (state?.notFound) {
        throw new EmptyResultError('xiaohongshu/comments', `Note ${noteId} not found or unavailable — it may have been deleted or restricted`);
    }
}

/**
 * 在常驻页里页内打开这条帖子（openNoteInPage，做法见 resident-helpers.js 文件头），往 stderr 报常驻页情况（reportResident）。
 * 没打开（ok:false）时页面停在哪不确定（安全限制页 / 登录页 / 别的帖子都可能），绝不取数：只跑访问检查，认出安全限制 /
 * 登录墙 / 不存在就报对应的错，都不是就报打开失败（带 openNoteInPage 的原因）。
 */
async function openInResidentPage(page, target, raw, noteId) {
    const opened = await openNoteInPage(page, target);
    await reportResident(page, opened.resident);
    if (opened.ok) return;
    let access = null;
    try {
        access = await page.evaluate(`(${inspectNoteAccess.toString()})()`);
    } catch {
        access = null;
    }
    throwCommentsAccessError(access, raw, noteId);
    throw new CommandExecutionError(`xiaohongshu comments: could not open note ${noteId} in the resident page (${opened.reason})`,
        'Opening the note inside the resident Xiaohongshu page failed. Try again later.');
}

// 读评论各阶段的节奏（秒），和两个截止时间占 --timeout 的比例（截止时间从 func 开始算）。
const SCROLL_NUDGE_SETTLE_SECONDS = 0.8; // 在底时往上挪一下之后、再滚到底之前等多久
const SCROLL_POLL_SECONDS = 0.4; // 滚到底之后每隔多久看一眼主评论涨没涨
const SCROLL_POLL_MAX_SECONDS = 3; // 每轮最多看多久（0.4 × 7 = 2.8 秒）
const SCROLL_STALL_ROUNDS = 3; // 连续几轮不涨就停
const SCROLL_BUDGET_SHARE = 0.45; // 滚动截止 = 0.45 × timeout
const EXPAND_BUDGET_SHARE = 0.8; // 展开截止 = 0.8 × timeout
const EXPAND_CLICKS_PER_STEP = 3; // 展开一步最多点几个

/** --timeout（秒）。opencli 已校验过是正整数，这里只兜底默认的 120。 */
function commentsTimeoutSeconds(raw) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 120;
}

/** 滚动一步的回执；不是对象（页面没了之类）给 null，滚动阶段就此结束，交给取数那一步报错。 */
function readScrollState(value) {
    if (!value || typeof value !== 'object') return null;
    const parents = Number(value.parents);
    const returnable = Number(value.returnable);
    return {
        parents: Number.isFinite(parents) && parents > 0 ? parents : 0,
        returnable: Number.isFinite(returnable) && returnable > 0 ? returnable : 0,
        end: value.end === true,
        atBottom: value.atBottom === true,
        total: typeof value.total === 'number' && Number.isFinite(value.total) ? value.total : null,
    };
}

/**
 * 滚动阶段。一轮 =「在底的话先往上挪一下（nudge）、等 0.8 秒」→ 滚到底 → 每 0.4 秒看一眼、最多看 3 秒，主评论涨没涨。
 * 能返回的主评论（returnable）够 limit、出现 .end-container、连续 3 轮不涨、或到了滚动截止时间（deadline，毫秒时间戳）就停。
 * 涨没涨看原始楼层数（parents）：新加载出来的哪怕全是纯图片楼，也说明网站还在给。
 * 因为不涨 / 到时间停下的返回 { stoppedBy: 'stall' | 'budget', total }，取完数主评论还不够 limit 时 func 据此往 stderr 写一行 short；
 * 够数 / 到底（end）/「共 0 条」返回 null（帖子本身就这么多，不算少拿）；回执不是对象（页面没了）也返回 null，交给取数那一步报错。
 */
async function scrollForTopLevelComments(page, limit, deadline, now) {
    const step = async (action) => readScrollState(await page.evaluate(buildCommentsScrollStepJs(action)));
    const polls = Math.floor(SCROLL_POLL_MAX_SECONDS / SCROLL_POLL_SECONDS);
    let state = await step('inspect');
    let stalls = 0;
    while (state) {
        // 「共 0 条评论」：没什么可滚的，也不算少拿
        if (state.returnable >= limit || state.end || state.total === 0) return null;
        const stoppedBy = stalls >= SCROLL_STALL_ROUNDS ? 'stall' : now() >= deadline ? 'budget' : null;
        if (stoppedBy) return { stoppedBy, total: state.total };
        const before = state.parents;
        if (state.atBottom) {
            await page.evaluate(buildCommentsScrollStepJs('nudge'));
            await page.wait({ time: SCROLL_NUDGE_SETTLE_SECONDS });
        }
        state = await step('bottom');
        for (let poll = 0; poll < polls && state && state.parents <= before && !state.end && now() < deadline; poll++) {
            await page.wait({ time: SCROLL_POLL_SECONDS });
            state = await step('inspect');
        }
        if (state) stalls = state.parents > before ? 0 : stalls + 1;
    }
    return null;
}

/**
 * 展开阶段（只在 --with-replies 时）：先清记录，再循环「展开一步（最多点 3 个）→ 等 0.5~0.9 秒」，直到某一步一个都没点、
 * 或到了展开截止时间（deadline，毫秒时间戳）；到时间停下时往 stderr 写一行，说明回复可能没展开全。
 */
async function expandReplyThreads(page, limit, deadline, now) {
    await page.evaluate(buildCommentsExpandResetJs());
    for (;;) {
        if (now() >= deadline) {
            process.stderr.write('[xhs-comments] replies: stopped by budget\n');
            return;
        }
        const step = await page.evaluate(buildCommentsExpandStepJs(limit, EXPAND_CLICKS_PER_STEP));
        if (!(Number(step?.clicked) > 0)) return;
        await page.wait({ time: 0.5 + Math.random() * 0.4 });
    }
}

export const command = cli({
    site: 'xiaohongshu',
    name: 'comments',
    access: 'read',
    description: '获取小红书笔记评论（支持楼中楼子回复）',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    // 走常驻页（opencli 常驻会话 site:xiaohongshu）：帖子在常驻页里页内打开，不整页打开主站（为什么见 resident-helpers.js 文件头）。
    siteSession: 'persistent',
    args: [
        { name: 'note-id', required: true, positional: true, help: 'Full Xiaohongshu note URL with xsec_token' },
        { name: 'limit', type: 'int', default: 20, help: 'Number of top-level comments (max 50)' },
        { name: 'with-replies', type: 'boolean', default: false, help: 'Include nested replies; reply_to is the direct target shown by the page' },
        // opencli 只认名叫 timeout 的参数来定整条命令的上限（= timeout + 30 秒）；不写是 60 秒，装不下页内打开最坏约 85 秒。
        { name: 'timeout', type: 'int', required: false, default: 120, help: 'Max seconds for the overall command (default: 120)' },
    ],
    columns: ['rank', 'author', 'userId', 'profileUrl', 'text', 'likes', 'time', 'is_reply', 'reply_to', 'images'],
    func: async (page, kwargs) => {
        // 时钟：每次现取 Date.now（单测换成假时钟）；滚动 / 展开的截止时间都从这里起算。
        const now = () => Date.now();
        const startedAt = now();
        const limit = parseCommentLimit(kwargs.limit);
        const withReplies = Boolean(kwargs['with-replies']);
        const raw = String(kwargs['note-id']);
        const noteId = parseNoteId(raw);
        const url = buildNoteUrl(raw, { commandName: 'xiaohongshu comments' });
        const target = noteTargetFromUrl(url);
        if (target) {
            await openInResidentPage(page, target, raw, noteId);
        }
        else {
            await page.goto(url);
        }
        await page.wait({ time: 2 + Math.random() * 3 });
        const timeoutMs = commentsTimeoutSeconds(kwargs.timeout) * 1000;
        const shortfall = await scrollForTopLevelComments(page, limit, startedAt + SCROLL_BUDGET_SHARE * timeoutMs, now);
        if (withReplies) {
            await expandReplyThreads(page, limit, startedAt + EXPAND_BUDGET_SHARE * timeoutMs, now);
        }
        const data = await page.evaluate(buildCommentsExtractJs(withReplies, limit));
        if (!data || typeof data !== 'object') {
            throw new EmptyResultError('xiaohongshu/comments', 'Unexpected evaluate response');
        }
        throwCommentsAccessError(data, raw, noteId);
        const all = normalizeCommentRows(data.results, 'xiaohongshu/comments');
        // authorHrefRaw is a raw transport field from the extractor; it is consumed
        // here into userId / profileUrl and intentionally not part of the row shape.
        const enrich = (c, i) => ({
            rank: i + 1,
            author: c.author,
            userId: c.authorHrefRaw ? parseXhsProfileHref(c.authorHrefRaw) : '',
            profileUrl: c.authorHrefRaw ? buildXhsProfileUrl(c.authorHrefRaw) : '',
            text: c.text,
            likes: c.likes,
            time: c.time,
            is_reply: c.is_reply,
            reply_to: c.reply_to,
            images: c.images ?? [],
        });
        // 滚动因为不涨 / 到时间停下、最后拿到的主评论又不够 limit：按最终条数往 stderr 写一行 short，免得少拿了也没人知道
        const finish = (rows) => {
            const topLevel = rows.filter(c => !c.is_reply).length;
            if (shortfall && topLevel < limit) {
                process.stderr.write(`[xhs-comments] short: got ${topLevel}/${limit} top-level (total ${shortfall.total ?? '?'}), stopped by ${shortfall.stoppedBy}\n`);
            }
            return rows.map(enrich);
        };
        // When limiting, count only top-level comments; their replies are included for free
        if (withReplies) {
            const limited = [];
            let topCount = 0;
            for (const c of all) {
                if (!c.is_reply)
                    topCount++;
                if (topCount > limit)
                    break;
                limited.push(c);
            }
            return finish(limited);
        }
        return finish(all.slice(0, limit));
    },
});
