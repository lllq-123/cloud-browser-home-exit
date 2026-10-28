// 我们家自己写的，按 Apache-2.0 公开（见 LICENSE）
/**
 * 小红书通知页的共用小工具（mentions / comment 都用）。只 import 同目录的 resident-helpers.js（它不 import 任何东西），
 * 没有副作用，测试可以直接 import。
 *
 * 打开通知页一律用 openNotificationPage，别直接 goto(NOTIFICATION_URL)：2026-10-27 实测，海外 IP 直接打开
 * /notification 会被服务器 302 到 www.rednote.com，我们的登录态在 .xiaohongshu.com，到了那边就是游客，
 * 看门狗 10 月 26 日晚起一条都读不到。首页 /explore 不跳；在首页点侧栏「通知」是页面自己换路由，
 * 不再向服务器要 /notification 这张页，实测登录身份和「评论和@」都正常。
 *
 * 2026-10-27 下午起首页也被导走了（带着登录也一样），上面「首页 /explore 不跳」不再成立。现在浏览器分流规则让
 * 主站 www.xiaohongshu.com 改走国内出口（家用手机隧道，慢，偶尔会断）；数据接口 edith 和图片脚本照旧新加坡直连。
 * 所以看门狗用 opencli 的常驻会话（--site-session persistent），同一张标签页跨轮保留：openNotificationPage 先在页内
 * 看一眼，常驻页活着（在主站、单页应用在、登录着、左上角 logo a[href="/explore"] 看得见——以前当成侧栏「发现」）就页内
 * 先回到 /explore（不在首页或开着帖子就点 logo）再点「通知」——单页应用自己换路由、通知接口重新拉一次，不重载整页；
 * 空白页、被导去别的站、掉了登录、单页应用不在、点 logo 没回到首页，才 goto 首页重开（出口断了也只影响重开那一下）。
 * comment.js 用一次性空白页，所以照旧 goto 首页再点「通知」。
 * 2026-10-27 晚起，常驻页的判断和页内回首页搬去了 resident-helpers.js（prepareResidentPage，别的命令也用它），这里只管
 * 点「通知」和切「评论和@」；搬走的名字在这里照旧导出，老的 import 不断。
 * 判断当前位置一律在页内读 location：opencli 的 page.getCurrentUrl() 是 goto 时的网址，页内换路由后不会更新。
 *
 * 通知页有三栏：评论和@ / 赞和收藏 / 新增关注。别的栏有未读时，页面一打开会停在那一栏，
 * 「评论和@」的列表根本不加载——2026-10-05 实测：store activeTabKey=1、notificationCount.likes=1、
 * mentions.messageList 为空，看门狗那一轮拿回 0 条、晚 5 分钟才发现她的 @。
 * 所以读或回「评论和@」之前，先用 ensureMentionsTab 切回来。
 */

import { EXPLORE_LINK_SELECTOR, HOME_URL, NOTIFICATION_LINK_SELECTOR, prepareResidentPage, readResidentPage } from './resident-helpers.js';

// 搬去 resident-helpers.js 的名字照旧从这里导出（mentions / comment / 测试都从这里 import）。
export { EXPLORE_LINK_SELECTOR, HOME_URL, NOTIFICATION_LINK_SELECTOR, readResidentPage };
// 只当地址标识用，别直接 goto 它（见文件头）。
export const NOTIFICATION_URL = 'https://www.xiaohongshu.com/notification';
export const MENTIONS_TAB_TEXT = '评论和@';
export const NOTIFICATION_TAB_SELECTOR = '.reds-tab-item.tab-item';
const SITE_HOST = 'www.xiaohongshu.com';
const LOGIN_PATH_RE = /^\/(?:login|website-login)\b/;
const HOP_WAIT_MS = 10_000;
const HOP_POLL_MS = 400;
const TAB_SWITCH_WAIT_MS = 8_000;
const TAB_SWITCH_POLL_MS = 400;

/**
 * 页内读（经 toString() 注入）：同时看当前栏、store 与可见列表，区分未加载和真的没有通知。
 */
export function readMentionsTabState(tabSelector, tabText) {
    const squash = (value) => String(value || '').replace(/\s+/g, '');
    const tabs = Array.from(document.querySelectorAll(tabSelector));
    // 未读数字也是 innerText 的一部分（实页「新增关注\n1」）；先剥掉尾部计数。
    const index = tabs.findIndex(tab => squash(tab.innerText || tab.textContent).replace(/\d+\+?$/, '') === tabText);
    let listLen = null;
    let hasMore = null;
    let isFetching = null;
    try {
        const state = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.notification;
        const tab = state.notificationMap.mentions;
        const list = tab.messageList;
        listLen = Array.isArray(list) ? list.length : null;
        hasMore = typeof tab.hasMore === 'boolean' ? tab.hasMore : null;
        isFetching = typeof state.isFetching === 'boolean' ? state.isFetching : null;
    } catch {
        listLen = null;
    }
    const visible = node => node.getClientRects().length > 0;
    const domCount = Array.from(document.querySelectorAll('.tabs-content-container > .container')).filter(visible).length;
    // 2026-10-17 站点 bundle 实证：初始 hasMore=true，仅成功响应后更新；失败保持 true。
    // 因此必须已结束分页、请求已结束、DOM 也没有条目，才能认作真正的空列表。
    const confirmedEmpty = listLen === 0 && hasMore === false && isFetching === false && domCount === 0;
    return {
        tabCount: tabs.length,
        index,
        active: index >= 0 && tabs[index].classList.contains('active'),
        listLen,
        hasMore,
        isFetching,
        domCount,
        confirmedEmpty,
    };
}

function unwrap(result) {
    if (result && typeof result === 'object') {
        if ('value' in result && Object.keys(result).length === 1) return result.value;
        if ('result' in result && Object.keys(result).length === 1) return result.result;
    }
    return result;
}

/**
 * 确保停在「评论和@」并等列表或明确空态出现；已在该栏也要等待加载。
 * 不抛错，返回 { switched, tabCount, index, active, listLen, error? }，由调用方决定怎么办。
 */
export async function ensureMentionsTab(page) {
    const readJs = `(${readMentionsTabState.toString()})(${JSON.stringify(NOTIFICATION_TAB_SELECTOR)}, ${JSON.stringify(MENTIONS_TAB_TEXT)})`;
    let state = unwrap(await page.evaluate(readJs));
    let switched = false;
    const deadline = Date.now() + TAB_SWITCH_WAIT_MS;
    while (true) {
        if (state?.active && (state.listLen > 0 || state.confirmedEmpty)) {
            return { switched, ...state };
        }
        if (!switched && state && state.index >= 0 && !state.active) {
            // bridge 的坐标点击曾无异常却没切栏。页内重新按文字定位，避免拿旧 index 点错。
            await page.evaluate(`(() => {
                const tab = Array.from(document.querySelectorAll(${JSON.stringify(NOTIFICATION_TAB_SELECTOR)}))
                    .find(node => String(node.innerText || node.textContent || '').replace(/\\s+/g, '').replace(/\\d+\\+?$/, '') === ${JSON.stringify(MENTIONS_TAB_TEXT)});
                if (tab) tab.click();
                return Boolean(tab);
            })()`);
            switched = true;
        }
        if (Date.now() >= deadline) break;
        await page.wait({ time: TAB_SWITCH_POLL_MS / 1_000 });
        state = unwrap(await page.evaluate(readJs));
    }
    const error = !state || state.index < 0 ? 'mentions_tab_not_found'
        : !state.active ? 'tab_switch_failed' : 'mentions_list_not_ready';
    return { switched, ...(state || {}), error };
}

/**
 * 页内读（经 toString() 注入）：现在停在哪个站、哪个路径，侧栏「通知」入口有几个看得见。
 */
export function readNotificationHop(linkSelector) {
    const links = Array.from(document.querySelectorAll(linkSelector));
    return {
        host: location.host,
        path: location.pathname,
        visibleLinks: links.filter(node => node.getClientRects().length > 0).length,
    };
}

/** 页内点第一个看得见的 selector，返回点没点着（和 ensureMentionsTab 一样用页内点击：bridge 的坐标点击曾无异常却没生效）。 */
async function clickVisibleLink(page, selector) {
    return Boolean(unwrap(await page.evaluate(`(() => {
        const link = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
            .find(node => node.getClientRects().length > 0);
        if (link) link.click();
        return Boolean(link);
    })()`)));
}

/**
 * 打开通知页（为什么这么绕见文件头）：常驻页活着就页内先回到 /explore（resident-helpers.js 的 prepareResidentPage），
 * 不 goto；没活着或点 logo 没回到首页，才 goto 首页重开（goto 出错照旧往外抛）。然后在页内点侧栏「通知」，等路径变成 /notification。
 * 被导去别的站、落到登录页都立刻停，不点也不干等。
 * 不抛错，返回 { clicked, host, path, visibleLinks, reused, reopenReason, error? }，由调用方决定怎么办：
 * reused=true 表示这轮没重载、reopenReason 为 null；否则 reopenReason 是 blank / left_site:<域名> / no_app /
 * not_logged_in / explore_hop_failed / no_page_state 之一。error 是 left_site:<域名> / login_required /
 * notification_link_not_found / notification_hop_failed / no_page_state 之一。
 */
export async function openNotificationPage(page) {
    const { reopenReason } = await prepareResidentPage(page);
    if (reopenReason) await page.goto(HOME_URL);
    const resident = { reused: reopenReason === null, reopenReason };
    const readJs = `(${readNotificationHop.toString()})(${JSON.stringify(NOTIFICATION_LINK_SELECTOR)})`;
    let state = unwrap(await page.evaluate(readJs));
    let clicked = false;
    const deadline = Date.now() + HOP_WAIT_MS;
    while (true) {
        if (state?.host && state.host !== SITE_HOST) break;
        if (LOGIN_PATH_RE.test(state?.path || '') || state?.path === '/notification') break;
        if (!clicked && state?.visibleLinks > 0) {
            clicked = await clickVisibleLink(page, NOTIFICATION_LINK_SELECTOR);
        }
        if (Date.now() >= deadline) break;
        await page.wait({ time: HOP_POLL_MS / 1_000 });
        state = unwrap(await page.evaluate(readJs));
    }
    const error = !state || !state.host ? 'no_page_state'
        : state.host !== SITE_HOST ? `left_site:${state.host}`
        : LOGIN_PATH_RE.test(state.path || '') ? 'login_required'
        : state.path === '/notification' ? null
        : clicked ? 'notification_hop_failed' : 'notification_link_not_found';
    return error ? { clicked, ...state, error, ...resident } : { clicked, ...state, ...resident };
}
