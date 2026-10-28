// 改自 OpenCLI 1.8.7 的 clis/xiaohongshu/search.js（Apache-2.0），改动见 NOTICE.md
/**
 * 小红书搜索 —— 覆盖官方同名命令（官方 clis/xiaohongshu/search.js）：参数、默认值、输出列和字段、报错类型都跟官方一样。
 *
 * 为什么覆盖：同 feed.js——从新加坡整页打开主站会被导去海外版，主站整页只能经家里手机出口。所以改在常驻页
 * （siteSession: 'persistent'）里页内搜索：resident-helpers.js 的 searchInPage（关键词先 trim）路由跳搜索页、在看得见的框里
 * 填词点搜索、等确认是这次的结果；这里再从 pinia search store 取数。
 * - 只要帖子（modelType 'note'），hot_query 这类「相关搜索」条目跳过——官方读 DOM 时同样跳过 .query-note-item。
 * - 行的样子照官方：rank / title / author / likes / url / author_url / published_at，标题空的不要，按网址去重。
 *   url 是 /search_result/<编号>?xsec_token=…&xsec_source=、author_url 是 /user/profile/<用户>?xsec_token=…&xsec_source=pc_search
 *   （跟官方读到的 DOM 链接、官方测试里的样子一致）；published_at 照官方从帖子编号推。
 * - --limit 比 store 里现有帖子多时在页内往下滚、等 store 涨（滚法照官方 buildScrollUntilJs：最多 15 次、连着 2 次没涨就停、
 *   每次最多等 2.5 秒；等待挪到 evaluate 外面——page.evaluate 每次硬上限 8 秒）。
 * - search store 会留着上一次的结果：取数时再核对一遍 state 是 success、searchValue 是这次的词，对不上就当页内没搜成。
 * - store 里有帖子条目、却一行都映射不出来（帖子条目的字段名是照 feed store 推断的，万一对不上，标题全读成空会被全滤掉），
 *   也当页内没搜成（read_failed:no_titles），不返回看着像「没搜到」的 []。
 * 页内搜不成（或读不出这次的结果）就照官方原来的做法整页打开搜索页读 DOM（searchFullPage，经手机出口），绝不拿上一次的
 * 结果当这次的返回。官方只有 query、--limit 两个参数，没有页内做不到的参数。
 * stderr：先是 reportResident 的两行（[xhs-resident] reused 或 reopened:<原因>、[xhs-resident] tab=<编号>），再一行
 * [xhs-resident] search=inpage 或 [xhs-resident] search=fallback:<原因>。stdout 只有命令结果。
 * [xhs-resident] 开头的 stderr 行是留给定时任务解析的协议，格式别随便改。
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { reportResident, searchInPage } from './resident-helpers.js';

const WEB_HOST = 'www.xiaohongshu.com';
const SCROLL_MAX = 15;          // 最多滚几次（官方 buildScrollUntilJs 的 maxScrolls）
const SCROLL_PLATEAU = 2;       // 连着几次没涨就停（官方 plateauRounds >= 2）
const SCROLL_WAIT_MS = 2_500;   // 每次滚完最多等多久涨（官方 MutationObserver 的 2500ms 超时）
const SCROLL_POLL_MS = 500;     // 等涨时多久看一次 store

// ── 以下到 buildSearchExtractJs 为止照抄官方，整页兜底（searchFullPage）用 ─────────────────────────────

/**
 * Wait for search results or login wall using MutationObserver (max 5s).
 * Returns 'content' if note items appeared, 'login_wall' if login gate
 * detected, or 'timeout' if neither appeared within the deadline.
 *
 * Note-item detection tries the legacy `section.note-item` class first
 * (still observed in many sessions, including rednote) and falls back to
 * a `<section>` element containing a `/search_result/` or `/explore/`
 * link. Issue #1506 reports the class being dropped on some xhs renders.
 */
const WAIT_FOR_CONTENT_JS = `
  new Promise((resolve) => {
    const findNoteCard = () => document.querySelector(
      'section.note-item, section:has(a[href*="/search_result/"]), section:has(a[href*="/explore/"])'
    );
    const detect = () => {
      if (findNoteCard()) return 'content';
      if (/登录后查看搜索结果/.test(document.body?.innerText || '')) return 'login_wall';
      return null;
    };
    const found = detect();
    if (found) return resolve(found);
    const observer = new MutationObserver(() => {
      const result = detect();
      if (result) { observer.disconnect(); resolve(result); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve('timeout'); }, 5000);
  })
`;
/**
 * Extract approximate publish date from a Xiaohongshu note URL.
 * XHS note IDs follow MongoDB ObjectID format where the first 8 hex
 * characters encode a Unix timestamp (the moment the ID was generated,
 * which closely matches publish time but is not an official API field).
 * e.g. "697f6c74..." → 0x697f6c74 = 1769958516 → 2026-02-01
 */
export function noteIdToDate(url) {
    const match = url.match(/\/(?:search_result|explore|note)\/([0-9a-f]{24})(?=[?#/]|$)/i);
    if (!match)
        return '';
    const hex = match[1].substring(0, 8);
    const ts = parseInt(hex, 16);
    if (!ts || ts < 1_000_000_000 || ts > 4_000_000_000)
        return '';
    // Offset by UTC+8 (China Standard Time) so the date matches what XHS users see
    return new Date((ts + 8 * 3600) * 1000).toISOString().slice(0, 10);
}
export function stripXhsAuthorDateSuffix(value) {
    const text = (value || '').replace(/\s+/g, ' ').trim();
    const stripped = text.replace(/\s*(?:\d{1,2}天前|\d+小时前|\d+分钟前|\d+秒前|刚刚|昨天|前天|\d+周前|\d+个月前|\d{1,2}-\d{1,2}|\d{4}-\d{1,2}-\d{1,2})$/u, '').trim();
    return stripped || text;
}
/**
 * `page.evaluate` may return either the raw IIFE value or a
 * `{ session, data }` envelope depending on the browser-bridge version.
 * Adapter code that called `Array.isArray(payload)` directly on the
 * envelope silently received [] for every search. This helper normalizes
 * both shapes so callers can keep their Array.isArray checks unchanged.
 */
export function unwrapEvaluateResult(payload) {
    if (payload && !Array.isArray(payload) && typeof payload === 'object' && 'session' in payload && 'data' in payload) {
        return payload.data;
    }
    return payload;
}
function requireSearchRows(payload, phase) {
    const rows = unwrapEvaluateResult(payload);
    if (!Array.isArray(rows)) {
        throw new CommandExecutionError(`Unexpected Xiaohongshu search ${phase} payload shape; expected an array of rows.`);
    }
    return rows;
}
export function parseLimit(raw) {
    const parsed = Number(raw ?? 20);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        throw new ArgumentError(`--limit must be an integer between 1 and 100, got ${JSON.stringify(raw)}`);
    }
    if (parsed < 1 || parsed > 100) {
        throw new ArgumentError(`--limit must be between 1 and 100, got ${parsed}`);
    }
    return parsed;
}
/**
 * Build a "scroll until enough or plateaued" IIFE used in place of a fixed
 * `autoScroll({ times: N })`. Xiaohongshu's search results page lazy-loads
 * ~5-7 notes per scroll, so the previous `times: 2` capped extraction at
 * ~13 items regardless of `--limit` (see #1471). This helper drives scrolls
 * dynamically:
 *
 *   - count visible `section.note-item` rows (excluding related-search
 *     `.query-note-item` rows)
 *   - if count >= targetCount → break (got enough)
 *   - if two consecutive scrolls add no new rows → break (DOM plateaued,
 *     no more lazy-load available)
 *   - hard cap at `maxScrolls` iterations (default 15) to bound runtime
 *
 * Exported so the rednote adapter (same DOM shape) can reuse it.
 */
export function buildScrollUntilJs(targetCount, maxScrolls = 15) {
    if (!Number.isSafeInteger(targetCount) || targetCount < 1) {
        throw new ArgumentError(`targetCount must be a positive integer, got ${JSON.stringify(targetCount)}`);
    }
    if (!Number.isSafeInteger(maxScrolls) || maxScrolls < 1) {
        throw new ArgumentError(`maxScrolls must be a positive integer, got ${JSON.stringify(maxScrolls)}`);
    }
    return `
      (async () => {
        const isVisibleNote = (el) => {
          if (el.classList.contains('query-note-item')) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden';
        };
        // Note containers: legacy \`section.note-item\` first, fallback to
        // any \`<section>\` that wraps a search-result/explore note link
        // (#1506 reports the class being dropped on some xhs renders).
        const collectNoteCards = () => {
          const classMatches = document.querySelectorAll('section.note-item');
          if (classMatches.length > 0) return classMatches;
          const sections = new Set();
          for (const a of document.querySelectorAll('a[href*="/search_result/"], a[href*="/explore/"]')) {
            const section = a.closest('section');
            if (section) sections.add(section);
          }
          return sections;
        };
        const countItems = () => {
          let count = 0;
          for (const el of collectNoteCards()) {
            if (isVisibleNote(el)) count++;
          }
          return count;
        };

        let lastCount = countItems();
        let plateauRounds = 0;
        for (let i = 0; i < ${maxScrolls}; i++) {
          if (countItems() >= ${targetCount}) break;
          const lastHeight = document.body.scrollHeight;
          window.scrollTo(0, lastHeight);
          await new Promise((resolve) => {
            let to;
            const ob = new MutationObserver(() => {
              if (document.body.scrollHeight > lastHeight) {
                clearTimeout(to);
                ob.disconnect();
                setTimeout(resolve, 200);
              }
            });
            ob.observe(document.body, { childList: true, subtree: true });
            to = setTimeout(() => { ob.disconnect(); resolve(null); }, 2500);
          });
          const newCount = countItems();
          if (newCount === lastCount) {
            plateauRounds++;
            if (plateauRounds >= 2) break;
          } else {
            plateauRounds = 0;
            lastCount = newCount;
          }
        }
        return countItems();
      })()
    `;
}
/**
 * Build the search-result extraction IIFE. The web host is baked into the
 * `normalizeUrl` fallback so relative `/explore/...` hrefs resolve to a full
 * URL on the calling site. Exported so the rednote adapter can call it with
 * `www.rednote.com` without duplicating the selector logic.
 */
export function buildSearchExtractJs(webHost) {
    return `
      (() => {
        const normalizeUrl = (href) => {
          if (!href) return '';
          if (href.startsWith('http://') || href.startsWith('https://')) return href;
          if (href.startsWith('/')) return 'https://${webHost}' + href;
          return '';
        };

        const cleanText = (value) => (value || '').replace(/\\s+/g, ' ').trim();
        const stripXhsAuthorDateSuffix = ${stripXhsAuthorDateSuffix.toString()};
        const isVisibleNote = (el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden';
        };

        const results = [];
        const seen = new Set();

        // Note containers: legacy \`section.note-item\` first, fallback to any
        // \`<section>\` wrapping a search-result/explore link (#1506 reports the
        // class being dropped on some xhs renders).
        const collectNoteCards = () => {
          const classMatches = document.querySelectorAll('section.note-item');
          if (classMatches.length > 0) return classMatches;
          const sections = new Set();
          for (const a of document.querySelectorAll('a[href*="/search_result/"], a[href*="/explore/"]')) {
            const section = a.closest('section');
            if (section) sections.add(section);
          }
          return sections;
        };

        for (const el of collectNoteCards()) {
          // Skip "related searches" sections
          if (el.classList?.contains('query-note-item')) continue;
          if (!isVisibleNote(el)) continue;

          const titleEl = el.querySelector('.title, .note-title, a.title, .footer .title span');
          const nameEl = el.querySelector('a.author .name, .author-name, .nick-name, .name');
          const authorWrapEl = el.querySelector('a.author');
          let author = cleanText(nameEl?.textContent || '');
          if (!author && authorWrapEl) {
            const nameChild = authorWrapEl.querySelector('.name');
            author = nameChild ? cleanText(nameChild.textContent || '') : stripXhsAuthorDateSuffix(authorWrapEl.textContent || '');
          }
          const likesEl = el.querySelector('.count, .like-count, .like-wrapper .count');
          // Prefer search_result link (preserves xsec_token) over generic /explore/ link
          const detailLinkEl =
            el.querySelector('a.cover.mask') ||
            el.querySelector('a[href*="/search_result/"]') ||
            el.querySelector('a[href*="/explore/"]') ||
            el.querySelector('a[href*="/note/"]');
          const authorLinkEl = el.querySelector('a.author, a[href*="/user/profile/"]');

          const url = normalizeUrl(detailLinkEl?.getAttribute('href') || '');
          if (!url) continue;

          const key = url;
          if (seen.has(key)) continue;
          seen.add(key);

          // Fallback title: the new bare-section render keeps the note caption
          // inside the search_result anchor's first span, not in a class-named
          // .title element. Pull from there when the class-based pick is empty.
          let title = cleanText(titleEl?.textContent || '');
          if (!title) {
            const captionSpan = detailLinkEl?.querySelector('span');
            title = cleanText(captionSpan?.textContent || '');
          }

          results.push({
            title,
            author,
            likes: cleanText(likesEl?.textContent || '0'),
            url,
            author_url: normalizeUrl(authorLinkEl?.getAttribute('href') || ''),
          });
        }

        return results;
      })()
    `;
}

/** 官方原来的整页做法（官方 func 原样）：goto 搜索页（经手机出口）→ 等结果或登录墙 → 读 DOM → 不够再滚。页内不成时的兜底。 */
async function searchFullPage(page, kwargs, limit) {
    const keyword = encodeURIComponent(kwargs.query);
    await page.goto(`https://www.xiaohongshu.com/search_result?keyword=${keyword}&source=web_search_result_notes`);
    // Wait for search results to render (or login wall to appear).
    // Uses MutationObserver to resolve as soon as content appears,
    // instead of a fixed delay + blind retry.
    const waitResult = unwrapEvaluateResult(await page.evaluate(WAIT_FOR_CONTENT_JS));
    if (waitResult === 'login_wall') {
        throw new AuthRequiredError('www.xiaohongshu.com', 'Xiaohongshu search results are blocked behind a login wall');
    }
    // Extract before scrolling. Xiaohongshu uses a virtualized masonry
    // layout, so scrolling to the bottom can evict the initially visible
    // note cards from the DOM and make extraction return [] even though the
    // browser rendered results correctly.
    const initialPayload = requireSearchRows(await page.evaluate(buildSearchExtractJs('www.xiaohongshu.com')), 'initial extraction');
    const payload = [...initialPayload];
    if (payload.length < limit) {
        // Scroll until enough rows are rendered or the lazy-load plateaus.
        // Replaces the previous fixed `autoScroll({ times: 2 })` which capped
        // extraction at ~13 notes regardless of `--limit` (#1471).
        await page.evaluate(buildScrollUntilJs(limit));
        const scrolledPayload = requireSearchRows(await page.evaluate(buildSearchExtractJs('www.xiaohongshu.com')), 'post-scroll extraction');
        const seen = new Set(payload.map((item) => item.url).filter(Boolean));
        for (const item of scrolledPayload) {
            if (item?.url && seen.has(item.url))
                continue;
            if (item?.url)
                seen.add(item.url);
            payload.push(item);
            if (payload.length >= limit)
                break;
        }
    }
    const data = payload;
    return data
        .filter((item) => item.title)
        .slice(0, limit)
        .map((item, i) => ({
        rank: i + 1,
        ...item,
        published_at: noteIdToDate(item.url),
    }));
}

// ── 以下是页内那条路 ─────────────────────────────────────────────────────────────────────────────

/**
 * 页内读（读一下就返回）：search store 的 state、searchValue，以及每个条目的类型、编号、帖子通行码、标题、作者、赞数、作者编号
 * 和作者通行码（字段可能是 ref，拆一层 _value，跟 resident-helpers 读 search store 一样）。读不出返回 { error }。
 */
const SEARCH_STORE_READ_JS = `
  (() => {
    const plain = (value) => (value && typeof value === 'object' && '_value' in value ? value._value : value);
    const text = (value) => (value == null ? '' : String(value));
    let store = null;
    try {
      store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('search');
    } catch {
      return { error: 'no_pinia' };
    }
    if (!store) return { error: 'no_search_store' };
    const feeds = plain(store.feeds);
    if (!Array.isArray(feeds)) return { error: 'feeds_not_array' };
    const state = plain(store.state);
    const value = plain(store.searchValue);
    return {
      state: state == null ? null : String(state),
      searchValue: value == null ? null : String(value),
      items: feeds.map((entry) => {
        const card = (entry && entry.noteCard) || {};
        const user = card.user || {};
        return {
          modelType: text(entry && entry.modelType),
          hasCard: Boolean(entry && entry.noteCard),
          id: text(entry && entry.id),
          // 帖子自己的通行码在条目顶层；card.user.xsecToken 是作者主页的。
          xsecToken: text(entry && entry.xsecToken),
          title: text(card.displayTitle),
          author: text(user.nickname ?? user.nickName),
          likes: text(card.interactInfo && card.interactInfo.likedCount),
          userId: text(user.userId),
          userToken: text(user.xsecToken),
        };
      }),
    };
  })()
`;

/** 页内读（读一下就返回）：search store 里现在有几条帖子（不算 hot_query 之类）；读不到为 null。 */
const SEARCH_NOTE_COUNT_JS = `
  (() => {
    try {
      const plain = (value) => (value && typeof value === 'object' && '_value' in value ? value._value : value);
      const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('search');
      const feeds = plain(store.feeds);
      if (!Array.isArray(feeds)) return null;
      return feeds.filter((entry) => entry && (entry.modelType ? entry.modelType === 'note' : Boolean(entry.noteCard))).length;
    } catch {
      return null;
    }
  })()
`;

/** 页内跑：滚到页底一次就返回（跟官方 buildScrollUntilJs 一样 window.scrollTo(0, document.body.scrollHeight)）。 */
const SCROLL_TO_BOTTOM_JS = `(() => { window.scrollTo(0, document.body.scrollHeight); return true; })()`;

const cleanText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** 帖子条目才要：modelType 是 'note'；没有 modelType 的看有没有 noteCard。hot_query 等一律跳过。 */
function isNoteItem(item) {
    return item.modelType ? item.modelType === 'note' : Boolean(item.hasCard);
}

/** 带签名的搜索结果网址：https://www.xiaohongshu.com/search_result/<编号>?xsec_token=…&xsec_source=；没有通行码时不带参数。 */
function buildSearchNoteUrl(id, xsecToken) {
    const url = new URL(`https://${WEB_HOST}/search_result/${encodeURIComponent(id)}`);
    const token = cleanText(xsecToken);
    if (!token)
        return url.toString();
    url.searchParams.set('xsec_token', token);
    url.searchParams.set('xsec_source', '');
    return url.toString();
}

/** 作者主页网址：https://www.xiaohongshu.com/user/profile/<用户>?xsec_token=…&xsec_source=pc_search；没有作者编号为空串。 */
function buildAuthorUrl(userId, userToken) {
    const id = cleanText(userId);
    if (!id)
        return '';
    const url = new URL(`https://${WEB_HOST}/user/profile/${encodeURIComponent(id)}`);
    const token = cleanText(userToken);
    if (!token)
        return url.toString();
    url.searchParams.set('xsec_token', token);
    url.searchParams.set('xsec_source', 'pc_search');
    return url.toString();
}

/** store 条目 → 官方的行：只要帖子、按网址去重、标题空的不要、取前 limit 条，再加 rank 和 published_at（同官方）。 */
function toSearchRows(items, limit) {
    const results = [];
    const seen = new Set();
    for (const item of items) {
        if (!item || typeof item !== 'object' || !isNoteItem(item)) continue;
        const id = cleanText(item.id);
        if (!id) continue;
        const url = buildSearchNoteUrl(id, item.xsecToken);
        if (seen.has(url)) continue;
        seen.add(url);
        results.push({
            title: cleanText(item.title),
            author: cleanText(item.author),
            likes: cleanText(item.likes) || '0',
            url,
            author_url: buildAuthorUrl(item.userId, item.userToken),
        });
    }
    return results
        .filter((item) => item.title)
        .slice(0, limit)
        .map((item, i) => ({
        rank: i + 1,
        ...item,
        published_at: noteIdToDate(item.url),
    }));
}

/** 页内读 search store。读出来返回 { state, searchValue, items }，读不出返回 { reason }（交给整页兜底），不抛。 */
async function readSearchStore(page) {
    let data;
    try {
        data = unwrapEvaluateResult(await page.evaluate(SEARCH_STORE_READ_JS));
    } catch {
        return { reason: 'read_failed:evaluate_threw' };
    }
    if (!data || typeof data !== 'object') return { reason: 'read_failed:unexpected_response' };
    if (data.error) return { reason: `read_failed:${data.error}` };
    if (!Array.isArray(data.items)) return { reason: 'read_failed:bad_items' };
    return data;
}

async function countSearchNotes(page) {
    try {
        const count = unwrapEvaluateResult(await page.evaluate(SEARCH_NOTE_COUNT_JS));
        return typeof count === 'number' ? count : null;
    } catch {
        return null;
    }
}

/**
 * 页内往下滚、等 store 里的帖子涨，直到够 target 条或涨不动：最多 SCROLL_MAX 次，连着 SCROLL_PLATEAU 次没涨就停，每次滚完
 * 最多等 SCROLL_WAIT_MS（规矩同官方 buildScrollUntilJs）。不抛，返回滚了几次。
 */
async function scrollForMore(page, target) {
    let scrolls = 0;
    try {
        let last = await countSearchNotes(page);
        if (last == null) return 0;
        let plateau = 0;
        while (scrolls < SCROLL_MAX && last < target) {
            await page.evaluate(SCROLL_TO_BOTTOM_JS);
            scrolls++;
            const deadline = Date.now() + SCROLL_WAIT_MS;
            let current = last;
            while (current <= last && Date.now() < deadline) {
                await page.wait({ time: SCROLL_POLL_MS / 1_000 });
                current = (await countSearchNotes(page)) ?? last;
            }
            if (current > last) {
                last = current;
                plateau = 0;
            } else if (++plateau >= SCROLL_PLATEAU) {
                break;
            }
        }
    } catch {
        // 滚的途中页面出错：拿已经有的。
    }
    return scrolls;
}

/**
 * 页内那条路：searchInPage → reportResident → 读 store 并核对是这个词的结果 → 帖子不够 limit 就往下滚再读（滚完还得是这个词，
 * 不然用滚之前那份）→ 映射成行。成了返回 { rows }，不成返回 { reason }（交给整页兜底）。不抛。
 */
async function searchStoreInPage(page, keyword, limit) {
    const searched = await searchInPage(page, keyword);
    await reportResident(page, searched.resident);
    if (!searched.ok) return { reason: searched.reason || 'search_failed' };
    const first = await readSearchStore(page);
    if (first.reason) return first;
    // search store 留着上一次的结果：必须是这次的词、而且搜成了。
    if (first.state !== 'success' || first.searchValue !== keyword) return { reason: 'read_failed:not_this_keyword' };
    let items = first.items;
    if (items.filter((item) => item && isNoteItem(item)).length < limit && (await scrollForMore(page, limit)) > 0) {
        const after = await readSearchStore(page);
        if (!after.reason && after.searchValue === keyword && after.items.length > items.length) items = after.items;
    }
    const rows = toSearchRows(items, limit);
    // 有帖子条目、却一行都映射不出来：多半是 store 字段名跟这里读的对不上（标题全读成空、全被滤掉），别当「没搜到」返回 []。
    if (rows.length === 0 && items.some((item) => item && isNoteItem(item))) return { reason: 'read_failed:no_titles' };
    return { rows };
}

export const command = cli({
    site: 'xiaohongshu',
    name: 'search',
    access: 'read',
    description: '搜索小红书笔记',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    siteSession: 'persistent',
    args: [
        { name: 'query', required: true, positional: true, help: 'Search keyword' },
        { name: 'limit', type: 'int', default: 20, help: 'Number of results' },
    ],
    columns: ['rank', 'title', 'author', 'likes', 'published_at', 'url'],
    func: async (page, kwargs) => {
        const limit = parseLimit(kwargs.limit);
        const keyword = String(kwargs.query ?? '').trim();
        const inPage = await searchStoreInPage(page, keyword, limit);
        if (inPage.rows) {
            process.stderr.write('[xhs-resident] search=inpage\n');
            return inPage.rows;
        }
        process.stderr.write(`[xhs-resident] search=fallback:${inPage.reason}\n`);
        return searchFullPage(page, kwargs, limit);
    },
});
export const __test__ = {
    stripXhsAuthorDateSuffix,
};
