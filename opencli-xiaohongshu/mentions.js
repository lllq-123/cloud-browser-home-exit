// 我们家自己写的，按 Apache-2.0 公开（见 LICENSE）
/**
 * xiaohongshu mentions — 「评论和@」通知的原始字段版（只读）。
 *
 * 官方 `notifications --type mentions` 最后的 map 只留昵称 / 动作标题 / 文字，
 * 用户 ID、帖子 ID、xsec_token、评论 ID 全丢了。看门狗要按用户 ID 认人、
 * 按帖子 ID + token 进帖子、按通知 ID 去重、按评论 ID 回复，所以这里把它们保留下来。
 *
 * 取数方式（2026-10-05 实测定的，和官方不同）：
 *   官方调 store action `notification.getNotification(type)`，但那个 action **不收类型参数**，
 *   只给当前 tab 翻下一页（同一参数两次实测分别拉回 connections / mentions 第二页）。
 *   所以这里不调 action：/notification 首屏自己就把「评论和@」加载进 pinia store 了，
 *   直接读 `notification.$state.notificationMap.mentions.messageList`，零额外请求。
 *   2026-10-27 起不直接打开 /notification（海外 IP 会被导去 www.rednote.com，成了游客）：
 *   由 openNotificationPage 先开首页、再点侧栏「通知」进去，store 照样是通知页首屏加载的那份。
 *
 * 已知行为：
 *   - 首屏"先给未读"：有未读时 messageList 只含未读那几条（打开即标已读），无未读时给最近 20 条。
 *   - 别的栏（赞和收藏 / 新增关注）有未读时，页面会停在那一栏、「评论和@」不加载 → 以前这一轮拿回 0 条。
 *     现在读之前先 ensureMentionsTab 切回来（2026-10-05 实测查明，见 notification-helpers.js）。
 *   - type/title 不可信：别人帖子评论区里 @ 我们，API 仍给 `comment/item · 评论了你的笔记`；
 *     区分要看 note_author_id 是否是本号 + 评论里有没有 @。调用方按 user_id 过滤，别按 type。
 *   - page.evaluate 整体有 8s 硬上限，页内等待压在 5s 内。
 *
 * 用法：
 *   opencli xiaohongshu mentions -f json --limit 20
 *   opencli xiaohongshu mentions --raw true -f json      # 原样吐 store 条目（新类型出现时拿它看字段）
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { MENTIONS_TAB_TEXT, NOTIFICATION_TAB_SELECTOR, ensureMentionsTab, openNotificationPage, readMentionsTabState } from './notification-helpers.js';
import { readResidentTabId } from './resident-helpers.js';

const TAB = 'mentions';
const MAX_WAIT_MS = 4000;   // 单次 page.evaluate 硬上限 8s，每轮页内最多等 4s
const WAIT_ROUNDS = 3;      // 列表还空就再来一轮，总共最多等 ~12s + 首屏 1.5s（实测偶发 5s 内加载不完）

// 在页面里：找 pinia store → 等 mentions tab 的 messageList 出现（最多 MAX_WAIT_MS）→ 拍成普通 JSON 带回。
const READ_STORE_JS = `
  async () => {
    const plain = (v) => { try { return JSON.parse(JSON.stringify(v)); } catch { return null; } };
    const out = { href: location.href, error: null, store: null, messageList: [], hasMore: null, cursor: null };
    const app = document.querySelector('#app');
    const gp = app && app.__vue_app__ && app.__vue_app__.config ? app.__vue_app__.config.globalProperties : null;
    const pinia = gp ? gp.$pinia : null;
    const store = pinia && pinia._s ? pinia._s.get('notification') : null;
    if (!store) {
      out.error = 'store_not_found';
      out.piniaStores = pinia && pinia._s ? Array.from(pinia._s.keys()) : null;
      return out;
    }
    const readTab = () => {
      const st = store.$state || {};
      const nm = st.notificationMap || {};
      return { st, nm, tab: nm[${JSON.stringify(TAB)}] };
    };
    let { st, nm, tab } = readTab();
    const deadline = Date.now() + ${MAX_WAIT_MS};
    while ((!tab || !Array.isArray(tab.messageList) || !tab.messageList.length) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 250));
      ({ st, nm, tab } = readTab());
    }
    const summary = {};
    for (const k of Object.keys(nm)) {
      const v = nm[k] || {};
      summary[k] = { listLen: Array.isArray(v.messageList) ? v.messageList.length : null, hasMore: plain(v.hasMore), cursor: plain(v.cursor) };
    }
    out.store = { activeTabKey: plain(st.activeTabKey), notificationCount: plain(st.notificationCount), notificationMap: summary };
    const list = tab ? plain(tab.messageList) : null;
    out.messageList = Array.isArray(list) ? list : [];
    out.hasMore = tab ? plain(tab.hasMore) : null;
    out.cursor = tab ? plain(tab.cursor) : null;
    out.tabState = (${readMentionsTabState.toString()})(${JSON.stringify(NOTIFICATION_TAB_SELECTOR)}, ${JSON.stringify(MENTIONS_TAB_TEXT)});
    return out;
  }
`;

function unwrap(result) {
    if (result && typeof result === 'object') {
        if ('value' in result && Object.keys(result).length === 1) return result.value;
        if ('result' in result && Object.keys(result).length === 1) return result.result;
    }
    return result;
}

function noteTypeFromLink(link) {
    const m = typeof link === 'string' ? link.match(/[?&]type=([a-z]+)/) : null;
    return m ? m[1] : null;
}

export function buildNoteUrl(noteId, xsecToken) {
    if (!noteId || !xsecToken) return null;
    return `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_notice`;
}

/** store 条目 → 扁平行。字段名 2026-10-05 实测（store 里已是驼峰）。 */
export function flattenMention(item, rank) {
    const u = item.userInfo || {};
    const n = item.itemInfo || {};
    const c = item.commentInfo || {};
    const tc = c.targetComment || {};
    return {
        rank,
        id: item.id ?? null,
        type: item.type ?? null,
        title: item.title ?? null,
        track_type: item.trackType ?? null,
        time: item.time ?? null,
        user_id: u.userid ?? null,
        nickname: u.nickname ?? null,
        indicator: u.indicator ?? null,
        note_id: n.id ?? null,
        note_token: n.xsecToken ?? null,
        note_title: n.content ?? null,
        note_type: noteTypeFromLink(n.link),
        note_author_id: n.userInfo?.userid ?? null,
        note_author: n.userInfo?.nickname ?? null,
        comment_id: c.id ?? null,
        comment: c.content ?? null,
        target_comment_id: tc.id ?? null,
        target_comment: tc.content ?? null,
        target_comment_author_id: tc.userInfo?.userid ?? null,
        note_url: buildNoteUrl(n.id, n.xsecToken),
    };
}

cli({
    site: 'xiaohongshu',
    name: 'mentions',
    access: 'read',
    description: '小红书「评论和@」通知，保留用户ID / 帖子ID / xsec_token / 评论ID（定时检查和回复要用）',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.INTERCEPT,
    navigateBefore: false,   // 自己从首页点进通知页（openNotificationPage），见文件头
    browser: true,
    // 默认就走常驻页：看门狗本来就传 --site-session persistent，裸调 mentions 也不再新开一次性页、经一加。
    siteSession: 'persistent',
    args: [
        { name: 'limit', type: 'int', default: 20, help: '最多返回几条（1–100）' },
        { name: 'raw', type: 'boolean', default: false, help: '原样吐出 store 条目和 tab 状态，不做映射（排查新类型用）' },
    ],
    columns: ['rank', 'id', 'type', 'title', 'time', 'user_id', 'nickname', 'note_id', 'note_title', 'note_author', 'comment_id', 'comment', 'target_comment_id'],
    func: async (page, kwargs) => {
        const limit = Math.max(1, Math.min(Number(kwargs.limit) || 20, 100));
        // 常驻页活着就页内换到通知页，不然从首页点进去（直接打开会被导去 rednote，见文件头）；raw 模式不抛，把结果带回去排查
        const hop = await openNotificationPage(page);
        // 这轮是接着用常驻页还是重开了，写一行到 stderr 给看门狗看；stdout 的 JSON 不变
        // [xhs-resident] 开头的 stderr 行是留给定时任务（注释里叫「看门狗」）解析的协议，格式别随便改
        process.stderr.write(`[xhs-resident] ${hop.reused ? 'reused' : `reopened:${hop.reopenReason}`}\n`);
        if (hop.error && !kwargs.raw) {
            if (hop.error === 'login_required') {
                throw new AuthRequiredError('mentions: xiaohongshu login required (home page went to login)');
            }
            throw new CommandExecutionError(`mentions: notification page not reached: ${hop.error} (hop: ${JSON.stringify(hop)})`);
        }
        // 这轮常驻会话实际用的标签页编号，再写一行 stderr 给看门狗记；拿不到就不写，后面确认为空的轮次也照写
        const tabId = await readResidentTabId(page);
        if (tabId) process.stderr.write(`[xhs-resident] tab=${tabId}\n`);
        // 等页面首屏请求落定再读 store；列表还空就多等几轮（每轮都在 evaluate 的 8s 上限内）
        await page.sleep(1.5);
        // 别的栏有未读时页面停在那一栏、「评论和@」不加载（以前偶发回 0 条的根因）→ 先切回来
        const tabSwitch = await ensureMentionsTab(page);
        if (tabSwitch.error && tabSwitch.error !== 'mentions_list_not_ready' && !kwargs.raw) {
            throw new CommandExecutionError(`mentions: ${tabSwitch.error} (tab: ${JSON.stringify(tabSwitch)})`);
        }
        let out = null;
        for (let round = 0; round < WAIT_ROUNDS; round++) {
            out = unwrap(await page.evaluate(READ_STORE_JS));
            if (!out || typeof out !== 'object') {
                throw new CommandExecutionError('mentions: page.evaluate returned nothing');
            }
            if (out.error || (out.messageList && out.messageList.length) || out.tabState?.confirmedEmpty) break;
        }
        if (kwargs.raw) {
            out.messageList = (out.messageList || []).slice(0, limit);
            out.tabSwitch = tabSwitch;
            out.hop = hop;
            return out;
        }
        if (out.error === 'store_not_found') {
            const href = String(out.href || '');
            if (/\/login\b/.test(href) || /passport|signin/i.test(href)) {
                throw new AuthRequiredError('mentions: xiaohongshu login required (redirected to login page)');
            }
            throw new CommandExecutionError(`mentions: notification store not found at ${href} (page changed or not loaded; pinia stores: ${JSON.stringify(out.piniaStores)})`);
        }
        if (out.error) {
            throw new CommandExecutionError(`mentions: ${out.error}`);
        }
        const tabState = out.tabState;
        if (!tabState?.active) {
            throw new CommandExecutionError(`mentions: comments tab is not active (tab: ${JSON.stringify(tabState)})`);
        }
        if (!Array.isArray(out.messageList)) {
            throw new CommandExecutionError('mentions: invalid messageList');
        }
        const list = (out.messageList || []).slice(0, limit);
        if (!list.length) {
            if (tabState.confirmedEmpty) {
                throw new EmptyResultError('mentions: 0 notifications in 「评论和@」 (confirmed empty page)');
            }
            throw new CommandExecutionError(`mentions: list unreadable or not loaded (tab: ${JSON.stringify(tabState)})`);
        }
        return list.map((item, i) => flattenMention(item, i + 1));
    },
});
