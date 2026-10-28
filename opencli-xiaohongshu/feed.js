// 改自 OpenCLI 1.8.7 的 clis/xiaohongshu/feed.js（Apache-2.0），改动见 NOTICE.md
/**
 * 小红书首页推荐 feed —— 覆盖官方同名命令（官方 clis/xiaohongshu/feed.js）：参数、默认值、输出列和字段、报错类型都跟官方一样。
 *
 * 为什么覆盖：2026-10-27 起从新加坡整页打开主站会被导去海外版，主站整页只能经家里手机出口（慢、会断）；数据接口照旧直连。
 * 所以改在常驻页（siteSession: 'persistent'）里页内刷新：resident-helpers.js 的 refreshFeedInPage 回到干净的首页、点右下角
 * 「刷新」、等 feed store 整批换新；这里再从 pinia feed.feeds 取数——读法（FEEDS_READ_JS）和行的映射照抄官方。
 * --limit 比 store 里现有条数多时，在页内往下滚、等 store 涨（实测往下滚会接着拉推流接口、新条目也带 xsecToken）。官方 feed
 * 本身不滚；滚法照官方 search 的 buildScrollUntilJs：最多 15 次、连着 2 次没涨就停、每次最多等 2.5 秒——只是等待挪到 evaluate
 * 外面（page.evaluate 每次硬上限 8 秒），计数改数 store 条数（页面上的卡片是虚拟列表，始终约 30 张，数不出条数）。
 * 页内刷新不成，或刷新成了却读不出 store，就照官方原来的做法整页打开 /explore 再读（runFeed，经手机出口）——
 * 绝不拿刷新前的旧推流当新的返回。唯一例外：这轮回首页时常驻页不能用、刚整页重开过（goto 没出错），store 里就是这次 goto
 * 刚加载的推流，跟 runFeed「goto → 等 2 秒 → 读」是同一回事，就等 2 秒直接读，不再整页开第二次（有的调用方只给 35 秒）。
 * stderr：先是 reportResident 的两行（[xhs-resident] reused 或 reopened:<原因>、[xhs-resident] tab=<编号>），再一行
 * [xhs-resident] feed=inpage、feed=fresh_load:<刷新失败的原因> 或 feed=fallback:<原因>。stdout 只有命令结果。
 * [xhs-resident] 开头的 stderr 行是留给定时任务解析的协议，格式别随便改。
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { refreshFeedInPage, reportResident } from './resident-helpers.js';

const WEB_HOST = 'www.xiaohongshu.com';
const SCROLL_MAX = 15;          // 最多滚几次（官方 search buildScrollUntilJs 的 maxScrolls）
const SCROLL_PLATEAU = 2;       // 连着几次没涨就停（官方 plateauRounds >= 2）
const SCROLL_WAIT_MS = 2_500;   // 每次滚完最多等多久涨（官方 MutationObserver 的 2500ms 超时）
const SCROLL_POLL_MS = 500;     // 等涨时多久看一次 store

function parseLimit(raw) {
    const parsed = Number(raw ?? 20);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        throw new ArgumentError(`--limit must be a positive integer, got ${JSON.stringify(raw)}`);
    }
    if (parsed < 1) {
        throw new ArgumentError(`--limit must be a positive integer, got ${parsed}`);
    }
    return parsed;
}

// 官方原样：读 pinia feed store 的 feeds，每条取编号、标题、类型、作者、赞数和帖子自己的 xsecToken。
const FEEDS_READ_JS = `
  (() => {
    let pinia = null;
    const probe = (el) => el?.__vue_app__?.config?.globalProperties?.$pinia ?? null;
    pinia = probe(document.querySelector('#app'));
    if (!pinia) {
      // Some builds mount under a different root id; fall back to a full scan
      // only when the standard mount node misses.
      for (const el of document.querySelectorAll('*')) {
        pinia = probe(el);
        if (pinia) break;
      }
    }
    if (!pinia || !pinia._s) return { error: 'no_pinia' };
    const store = pinia._s.get('feed');
    if (!store) return { error: 'no_feed_store' };
    const feeds = store.feeds;
    if (!Array.isArray(feeds)) return { error: 'feeds_not_array' };
    return {
      items: feeds.map(entry => {
        const card = entry?.noteCard ?? {};
        return {
          id: entry?.id ?? '',
          title: card.displayTitle ?? '',
          type: card.type ?? '',
          // Live store exposes both user.nickname and user.nickName; prefer
          // nickname (observed populated on xhs), fall back to nickName.
          author: card.user?.nickname ?? card.user?.nickName ?? '',
          likes: card.interactInfo?.likedCount ?? '',
          // The note's signing token lives on the top-level entry. Do NOT read
          // card.user.xsecToken — that is the author profile's token, not the
          // note's.
          xsecToken: entry?.xsecToken ?? '',
        };
      }),
    };
  })()
`;

/** 页内读（读一下就返回）：feed store 里现在有几条；读不到为 null。 */
const FEEDS_COUNT_JS = `
  (() => {
    try {
      const feeds = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('feed').feeds;
      return Array.isArray(feeds) ? feeds.length : null;
    } catch {
      return null;
    }
  })()
`;

/** 页内跑：滚到页底一次就返回（跟官方 search 一样 window.scrollTo(0, document.body.scrollHeight)），等不等涨放在外面。 */
const SCROLL_TO_BOTTOM_JS = `(() => { window.scrollTo(0, document.body.scrollHeight); return true; })()`;

function toCleanString(value) {
    return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function unwrapEvaluateResult(payload) {
    if (payload && !Array.isArray(payload) && typeof payload === 'object' && 'session' in payload && 'data' in payload) {
        return payload.data;
    }
    return payload;
}

/**
 * 官方原样：带签名的帖子网址 https://<host>/explore/<编号>?xsec_token=…&xsec_source=（来源留空，跟网站推流卡片上的一样）；
 * 没有通行码时是不带参数的 /explore/<编号>。
 */
export function buildFeedNoteUrl(webHost, id, xsecToken) {
    const cleanId = toCleanString(id);
    const url = new URL(`https://${webHost}/explore/${encodeURIComponent(cleanId)}`);
    const cleanToken = toCleanString(xsecToken);
    if (!cleanToken)
        return url.toString();
    url.searchParams.set('xsec_token', cleanToken);
    url.searchParams.set('xsec_source', '');
    return url.toString();
}

/**
 * 官方 runFeed 的后半段原样：条目映射成行（id / title / type / author / likes / url），取够 limit 条为止；条目不是对象、缺编号、
 * 缺 xsecToken 都报 CommandExecutionError（缺 token 那条实测不会触发，照官方保留），一行都没有报 EmptyResultError。
 */
function toFeedRows(items, limit, webHost) {
    const rows = [];
    for (const row of items) {
        if (rows.length >= limit)
            break;
        if (!row || typeof row !== 'object') {
            throw new CommandExecutionError(`${webHost} feed: malformed feed item`);
        }
        const id = toCleanString(row.id);
        if (!id) {
            throw new CommandExecutionError(`${webHost} feed: feed item is missing note id`);
        }
        const xsecToken = toCleanString(row.xsecToken);
        if (!xsecToken) {
            throw new CommandExecutionError(`${webHost} feed: feed item ${id} is missing xsecToken; cannot build a signed drill-down URL`);
        }
        rows.push({
            id,
            title: toCleanString(row.title),
            type: toCleanString(row.type),
            author: toCleanString(row.author),
            likes: toCleanString(row.likes),
            url: buildFeedNoteUrl(webHost, id, xsecToken),
        });
    }
    if (rows.length === 0) {
        throw new EmptyResultError(`${webHost}/feed`, 'No feed items in the hydrated store.');
    }
    return rows;
}

/** 官方原来的整页做法（官方 runFeed 原样）：goto /explore（经手机出口）→ 等 2 秒 → 读 store → 映射。页内不成时的兜底。 */
export async function runFeed(page, kwargs, webHost) {
    const limit = parseLimit(kwargs.limit);
    await page.goto(`https://${webHost}/explore`);
    // Pinia store hydrates from SSR; give the page a beat to finish
    // bootstrapping before reading the array.
    await page.wait({ time: 2 });
    const data = unwrapEvaluateResult(await page.evaluate(FEEDS_READ_JS));
    if (!data || typeof data !== 'object') {
        throw new CommandExecutionError(`${webHost} feed: unexpected evaluate response`);
    }
    if (data.error) {
        throw new CommandExecutionError(`${webHost} feed: ${data.error}`, `The SPA may still be hydrating; reload ${webHost}/explore and retry.`);
    }
    if (!Array.isArray(data.items)) {
        throw new CommandExecutionError(`${webHost} feed: unexpected items payload shape`);
    }
    return toFeedRows(data.items, limit, webHost);
}

/** 页内读 store 的条目（读法同官方）。读出来返回 { items }，读不出返回 { reason }（交给整页兜底），不抛。 */
async function readFeedItems(page) {
    let data;
    try {
        data = unwrapEvaluateResult(await page.evaluate(FEEDS_READ_JS));
    } catch {
        return { reason: 'read_failed:evaluate_threw' };
    }
    if (!data || typeof data !== 'object') return { reason: 'read_failed:unexpected_response' };
    if (data.error) return { reason: `read_failed:${data.error}` };
    if (!Array.isArray(data.items)) return { reason: 'read_failed:bad_items' };
    if (data.items.length === 0) return { reason: 'read_failed:empty' };
    return { items: data.items };
}

async function countFeeds(page) {
    try {
        const count = unwrapEvaluateResult(await page.evaluate(FEEDS_COUNT_JS));
        return typeof count === 'number' ? count : null;
    } catch {
        return null;
    }
}

/**
 * 页内往下滚、等 store 涨，直到够 target 条或涨不动：最多 SCROLL_MAX 次，连着 SCROLL_PLATEAU 次没涨就停，每次滚完最多等
 * SCROLL_WAIT_MS（规矩同官方 search 的 buildScrollUntilJs）。不抛，返回滚了几次。
 */
async function scrollForMore(page, target) {
    let scrolls = 0;
    try {
        let last = await countFeeds(page);
        if (last == null) return 0;
        let plateau = 0;
        while (scrolls < SCROLL_MAX && last < target) {
            await page.evaluate(SCROLL_TO_BOTTOM_JS);
            scrolls++;
            const deadline = Date.now() + SCROLL_WAIT_MS;
            let current = last;
            while (current <= last && Date.now() < deadline) {
                await page.wait({ time: SCROLL_POLL_MS / 1_000 });
                current = (await countFeeds(page)) ?? last;
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
 * 这轮的 ensureResidentPage 刚整页重开过、goto 也没出错（resident.reused === false 且没有 gotoError）：
 * store 里就是这次 goto 刚加载的推流，不是刷新前的旧推流。
 */
function justReopened(resident) {
    return Boolean(resident) && resident.reused === false && !resident.gotoError;
}

/** 刚整页重开过的页：照官方 runFeed 等 2 秒再读 store（不滚，同官方）。读出来返回 { items }，读不出返回 { reason }，不抛。 */
async function readFreshLoad(page) {
    try {
        await page.wait({ time: 2 });
    } catch {
        return { reason: 'read_failed:wait_threw' };
    }
    return readFeedItems(page);
}

/**
 * 页内那条路：refreshFeedInPage → reportResident → 读 store → 不够 limit 就往下滚再读。成了返回 { items, line }（line 是
 * stderr 那一行 feed= 后面的字），不成返回 { reason }（交给整页兜底）。不抛。
 * - 刷新成了：line 'inpage'，条目全是这次刷新以后的。
 * - 刷新不成、但这轮刚整页重开过（justReopened）：readFreshLoad 等 2 秒直接读，line 'fresh_load:<刷新失败的原因>'，
 *   不再整页开第二次；读不出来才交给整页兜底，原因照旧是刷新失败的原因。
 * - 刷新不成、常驻页是接着用的（或重开时 goto 出错）：store 里是刷新前的旧推流，绝不读，直接交给整页兜底。
 */
async function readFeedInPage(page, limit) {
    const refreshed = await refreshFeedInPage(page);
    await reportResident(page, refreshed.resident);
    if (!refreshed.ok) {
        const reason = refreshed.reason || 'refresh_failed';
        if (justReopened(refreshed.resident)) {
            const fresh = await readFreshLoad(page);
            if (fresh.items) return { items: fresh.items, line: `fresh_load:${reason}` };
        }
        return { reason };
    }
    const first = await readFeedItems(page);
    if (!first.items) return first;
    let items = first.items;
    if (items.length < limit && (await scrollForMore(page, limit)) > 0) {
        const after = await readFeedItems(page);
        if (after.items && after.items.length > items.length) items = after.items;
    }
    return { items, line: 'inpage' };
}

export const command = cli({
    site: 'xiaohongshu',
    name: 'feed',
    access: 'read',
    description: '小红书首页推荐 Feed (reads hydrated Pinia store)',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    siteSession: 'persistent',
    args: [
        { name: 'limit', type: 'int', default: 20, help: 'Number of items to return' },
    ],
    columns: ['id', 'title', 'author', 'likes', 'type', 'url'],
    func: async (page, kwargs) => {
        const limit = parseLimit(kwargs.limit);
        const inPage = await readFeedInPage(page, limit);
        if (inPage.items) {
            process.stderr.write(`[xhs-resident] feed=${inPage.line}\n`);
            return toFeedRows(inPage.items, limit, WEB_HOST);
        }
        process.stderr.write(`[xhs-resident] feed=fallback:${inPage.reason}\n`);
        return runFeed(page, kwargs, WEB_HOST);
    },
});
