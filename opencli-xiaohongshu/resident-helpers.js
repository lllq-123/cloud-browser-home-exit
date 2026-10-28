// 我们家自己写的，按 Apache-2.0 公开（见 LICENSE）
/**
 * 小红书「常驻页」公共工具：判断常驻页能不能接着用、页内回首页、页内打开指定帖子、页内搜索、页内刷新推流，
 * 以及往 stderr 报这轮用没用上常驻页。不 import 任何东西、没有副作用，测试可以直接 import。
 *
 * 为什么要常驻页：2026-10-27 中午起，从新加坡整页打开主站 www.xiaohongshu.com 会被导去海外版（www.rednote.com，
 * 我们的登录在 .xiaohongshu.com，到那边就是游客），主站整页只能改走家里手机出口（慢、会断）；数据接口 edith 和图片
 * 照旧新加坡直连、不查出口。所以日常操作都在一张早就打开的「常驻页」（opencli 常驻会话 site:xiaohongshu）里页内换页
 * 完成——单页应用自己换路由、自己调数据接口，全程不向主站要整页；只有常驻页不能用时才 page.goto 整页重开（经手机出口，
 * 叫「开门」）。
 *
 * 下面的做法都是 2026-10-27 在真实页面、屏蔽主站（等于手机出口断了）的条件下实测的：
 * - 当前位置一律在页内读 location：opencli 的 page.getCurrentUrl() 是 goto 时的网址，页内换路由后不更新。
 * - 页内点击一律在 evaluate 里对第一个看得见的元素（getClientRects().length > 0）调 .click()。
 * - 回首页 = 点左上角 logo a[href="/explore"]（第一个看得见的就是它）：能关掉「路由打开的帖子」，在 /explore 上点它什么都
 *   不发生。侧栏那项现在叫「首页」（a[href="/explore?channel_id=homefeed_recommend"]），以前叫「发现」。
 *   绝不用浏览器「后退」：实测有一次网站把跳转改写成替换、历史里没多一步，后退一路退出网站退到 about:blank。
 * - 页内打开帖子（这里采用的做法）：新开的页 note store 的 prevRoute 是 'Empty'，这时路由跳帖子会被网站当成外部直链，
 *   改写成 Explore 路由 /explore?…&target_note_id=<id>（下面叫「直链改写」：弹层不出、首页变灰色占位，后台流程过几秒
 *   还会把页面拽回 /explore、干扰下一次）；跳之前把 prevRoute 改成 'Explore' 就成。开着一条直接跳下一条，地址变了、弹层
 *   还是上一条（currentNoteId 不变）——所以先点 logo 关、再跳、再核对 currentNoteId。页内两次都不成才整页打开（经手机出口）。
 *   /search_result/<id>、/notification/<id> 这两种路由从首页跳会被打回 /explore，别用。
 * - 搜索：单靠路由跳 /search_result?keyword=… 不出结果（search store 的 state 是 'error'），首页的 #search-input 是隐藏的；
 *   跳到搜索页以后在看得见的搜索框里填词、点搜索才出。search store 会留着上一次的结果，要核对是这次的。
 * - 推流刷新：点右下角「刷新」（.floating-btn-sets .reload），feed store 的 feeds 整批换新。
 * - page.evaluate 每次硬上限 8 秒：这里注入的页内代码都只读一下 / 点一下就返回，等待一律放在外面用 page.wait。
 */

export const HOME_URL = 'https://www.xiaohongshu.com/explore';
export const EXPLORE_LINK_SELECTOR = 'a[href="/explore"]';
export const NOTIFICATION_LINK_SELECTOR = 'a[href="/notification"]';
const SITE_ORIGIN = 'https://www.xiaohongshu.com';
const SITE_HOST = 'www.xiaohongshu.com';
const EXPLORE_PATH = '/explore';
const SEARCH_PATH = '/search_result';
const LOGIN_PATH_RE = /^\/(?:login|website-login)\b/;
const SEARCH_INPUT_SELECTOR = '#search-input';
const SEARCH_BUTTON_SELECTOR = '.search-icon';
const REFRESH_BUTTON_SELECTOR = '.floating-btn-sets .reload';
const NOTE_ID_RE = /^[0-9a-zA-Z]+$/;
const POLL_MS = 400;
const HOP_WAIT_MS = 10_000;         // 点 logo 后最多等多久回到 /explore（和原 notification-helpers 一样）
const SETTLE_WAIT_MS = 6_000;       // 回到 /explore 后最多等多久推流有卡片
const NOTE_WAIT_MS = 10_000;        // 每次打开帖子最多等多久核对上
const NOTE_IN_PAGE_ATTEMPTS = 2;    // 页内跳几次，都不成才整页打开
const SEARCH_PAGE_WAIT_MS = 10_000; // 路由跳搜索页后最多等多久出现看得见的搜索框
const SEARCH_RESULT_WAIT_MS = 10_000; // 点搜索后最多等多久出这次的结果（实测 2.6 秒）
const REFRESH_WAIT_MS = 8_000;      // 点「刷新」后最多等多久推流换新

/**
 * 页内读（经 toString() 注入）：常驻页还能不能接着用——在哪个站、哪个路径，侧栏「通知」、左上角 logo（a[href="/explore"]，
 * 以前当成侧栏「发现」）各有几个看得见，单页应用（#app 上的 pinia）在不在，登录没有。读不到的一律当没有，不抛错。
 */
export function readResidentPage(noticeSelector, exploreSelector) {
    const visibleCount = selector => {
        try {
            return Array.from(document.querySelectorAll(selector)).filter(node => node.getClientRects().length > 0).length;
        } catch {
            return 0;
        }
    };
    let app = false;
    let loggedIn = false;
    try {
        const state = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value;
        app = Boolean(state) && typeof state === 'object';
        const flag = state.user && state.user.loggedIn;
        // 登录标记可能是 ref 包装（{ _value: true }），和 collection-helpers 一样先拆一层；只认 true。
        loggedIn = (flag && typeof flag === 'object' ? flag._value : flag) === true;
    } catch {
        // 没有 #app / pinia：app、loggedIn 保持 false。
    }
    return {
        host: location.host,
        path: location.pathname,
        noticeLinks: visibleCount(noticeSelector),
        exploreLinks: visibleCount(exploreSelector),
        app,
        loggedIn,
    };
}

/**
 * 页内读（经 toString() 注入）：现在在哪；开没开着帖子（#noteContainer）；是不是「直链改写」（路由名 Explore 且 query 带
 * target_note_id）；首页推流稳没稳（section.note-item 卡片数、feed store feeds 条数）。给了 noteId 再看打开的是不是这一条：
 * note store 的 currentNoteId、地址里有没有这个编号、#noteContainer 里有没有作者和标题 / 正文 / 媒体。读不到的一律当没有，不抛。
 */
function readPageState(noteId) {
    const text = node => String((node && (node.innerText || node.textContent)) || '').trim();
    const plain = value => (value && typeof value === 'object' && '_value' in value ? value._value : value);
    const out = {
        host: location.host,
        path: location.pathname,
        noteOpen: false,
        directLink: false,
        cards: 0,
        feeds: null,
        currentNoteId: null,
        pathHasId: Boolean(noteId) && String(location.pathname || '').includes(noteId),
        author: false,
        title: false,
        desc: false,
        media: false,
    };
    let props = null;
    try {
        props = document.querySelector('#app').__vue_app__.config.globalProperties;
    } catch {
        props = null;
    }
    try {
        const current = props.$router.currentRoute;
        const route = current && typeof current === 'object' && 'value' in current ? current.value : current;
        out.directLink = route.name === 'Explore'
            && Object.prototype.hasOwnProperty.call(route.query || {}, 'target_note_id');
    } catch {
        out.directLink = false;
    }
    try {
        const feeds = plain(props.$pinia._s.get('feed').feeds);
        out.feeds = Array.isArray(feeds) ? feeds.length : null;
    } catch {
        out.feeds = null;
    }
    try {
        const id = plain(props.$pinia._s.get('note').currentNoteId);
        out.currentNoteId = typeof id === 'string' && id ? id : null;
    } catch {
        out.currentNoteId = null;
    }
    try {
        out.cards = document.querySelectorAll('section.note-item').length;
    } catch {
        out.cards = 0;
    }
    try {
        const box = document.querySelector('#noteContainer');
        out.noteOpen = Boolean(box);
        if (box) {
            out.author = Boolean(text(box.querySelector('.username, .author-wrapper .name')));
            out.title = Boolean(text(box.querySelector('#detail-title')));
            out.desc = Boolean(text(box.querySelector('#detail-desc')));
            out.media = Boolean(box.querySelector('.swiper-slide img, .note-slider img, .media-container img, video'));
        }
    } catch {
        // 读到一半出错：没读到的保持 false。
    }
    return out;
}

/**
 * 页内跑（经 toString() 注入）：路由跳到 path。toNote 时先看 note store：prevRoute 还是 'Empty'（新开的页）就先改成
 * 'Explore'，再跳——不然网站把这一跳当外部直链改写掉（见文件头）。push 返回的 Promise 不等，只挂个 catch 免得报未处理；
 * 跳没跳成由外面轮询核对。返回 { pushed, prevRoute?, fixed?, error? }。
 */
function pushRoute(path, toNote) {
    let props = null;
    try {
        props = document.querySelector('#app').__vue_app__.config.globalProperties;
    } catch {
        props = null;
    }
    const router = props && props.$router;
    if (!router || typeof router.push !== 'function') return { pushed: false, error: 'no_router' };
    let prevRoute = null;
    let fixed = false;
    if (toNote) {
        let store = null;
        try {
            store = props.$pinia._s.get('note');
        } catch {
            store = null;
        }
        if (!store) return { pushed: false, error: 'no_note_store' };
        prevRoute = typeof store.prevRoute === 'string' ? store.prevRoute : null;
        if (prevRoute === 'Empty') {
            store.prevRoute = 'Explore';
            fixed = true;
        }
    }
    try {
        const pending = router.push(path);
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {
        return { pushed: false, error: 'push_threw', prevRoute, fixed };
    }
    return { pushed: true, prevRoute, fixed };
}

/**
 * 页内读（经 toString() 注入）：在哪、看得见的搜索框有几个，search store 的 state / searchValue / 条目编号
 * （字段可能是 ref，拆一层 _value；state 用 String() 比）。还没有 search store 就当没有结果，不抛。
 */
function readSearchState(inputSelector) {
    const plain = value => (value && typeof value === 'object' && '_value' in value ? value._value : value);
    let inputs = 0;
    try {
        inputs = Array.from(document.querySelectorAll(inputSelector)).filter(node => node.getClientRects().length > 0).length;
    } catch {
        inputs = 0;
    }
    const out = { host: location.host, path: location.pathname, inputs, state: null, searchValue: null, ids: [] };
    try {
        const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('search');
        if (store) {
            const state = plain(store.state);
            const value = plain(store.searchValue);
            const feeds = plain(store.feeds);
            out.state = state == null ? null : String(state);
            out.searchValue = value == null ? null : String(value);
            out.ids = Array.isArray(feeds) ? feeds.map(item => (item && item.id != null ? String(item.id) : '')) : [];
        }
    } catch {
        // 没有 search store（这张页还没进过搜索页）：当没有结果。
    }
    return out;
}

/**
 * 页内跑（经 toString() 注入）：在第一个看得见的搜索框里用原生 setter 填词、派发冒泡的 input 事件（实测这样页面才认），
 * 再点第一个看得见的搜索按钮。返回 { filled, clicked }。
 */
function submitSearch(keyword, inputSelector, buttonSelector) {
    const firstVisible = selector => Array.from(document.querySelectorAll(selector))
        .find(node => node.getClientRects().length > 0);
    const input = firstVisible(inputSelector);
    if (!input) return { filled: false, clicked: false };
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, keyword);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const button = firstVisible(buttonSelector);
    if (button) button.click();
    return { filled: true, clicked: Boolean(button) };
}

/** 页内读（经 toString() 注入）：feed store 里推流条目的编号（feeds 可能是 ref，拆一层 _value）；读不到 ids 为 null。 */
function readFeedIds() {
    try {
        const feeds = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('feed').feeds;
        const list = feeds && typeof feeds === 'object' && '_value' in feeds ? feeds._value : feeds;
        return { ids: Array.isArray(list) ? list.map(item => (item && item.id != null ? String(item.id) : '')) : null };
    } catch {
        return { ids: null };
    }
}

function unwrap(result) {
    if (result && typeof result === 'object') {
        if ('value' in result && Object.keys(result).length === 1) return result.value;
        if ('result' in result && Object.keys(result).length === 1) return result.result;
    }
    return result;
}

/** 跑一段只读的页内代码；出错或没拿回对象都当 null，不抛。 */
async function read(page, js) {
    try {
        const value = unwrap(await page.evaluate(js));
        return value && typeof value === 'object' ? value : null;
    } catch {
        return null;
    }
}

/** 页内点第一个看得见的 selector，返回点没点着；读页面出错也只当没点着，不抛。 */
async function clickVisible(page, selector) {
    try {
        return Boolean(unwrap(await page.evaluate(`(() => {
            const node = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
                .find(item => item.getClientRects().length > 0);
            if (node) node.click();
            return Boolean(node);
        })()`)));
    } catch {
        return false;
    }
}

function pause(page) {
    return page.wait({ time: POLL_MS / 1_000 });
}

function pageStateJs(noteId = null) {
    return `(${readPageState.toString()})(${JSON.stringify(noteId)})`;
}

/** 错误信息压成一行（要写进 stderr 的一行里）。 */
function oneLine(error) {
    return String((error && error.message) || error).replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** 干净的首页：在主站 /explore、没开着帖子、也不是停在直链改写上。 */
function isCleanExplore(state) {
    return Boolean(state) && state.host === SITE_HOST && state.path === EXPLORE_PATH && !state.noteOpen && !state.directLink;
}

/**
 * 点了 logo 以后最多等 HOP_WAIT_MS 到干净的首页（isCleanExplore：#noteContainer 没了、也不停在直链改写上）；到了返回那一刻的
 * 页面状态，没到返回 null。直链改写那一刻的路径本来就是 /explore、也没开着帖子，只看这两样会在 logo 还没起作用时就当回来了；
 * logo 清不掉直链改写的话（在 Explore 路由上点 logo 什么都不发生，直链改写的路由名也是 Explore，没实测过），就等网站自己拽回首页。
 */
async function waitForExplore(page) {
    const deadline = Date.now() + HOP_WAIT_MS;
    try {
        while (Date.now() < deadline) {
            await pause(page);
            const state = await read(page, pageStateJs());
            if (isCleanExplore(state)) return state;
            // 被导去别的站、落到登录页都不干等，直接重开。
            if ((state?.host && state.host !== SITE_HOST) || LOGIN_PATH_RE.test(state?.path || '')) return null;
        }
    } catch {
        // 换页途中出错：当没过去，交给 goto 重开。
    }
    return null;
}

/**
 * 回到 /explore 后最多等 SETTLE_WAIT_MS，直到推流有卡片（section.note-item）且 feed store 有条目——直链改写失败过的页是
 * 半加载的（灰色占位、feeds 为空），不等稳就接着跳会被后台流程干扰。等到返回 true，等不到返回 false（照常往下走）。
 */
async function waitFeedSettled(page, state) {
    const deadline = Date.now() + SETTLE_WAIT_MS;
    let current = state;
    try {
        while (!(current?.cards > 0 && current.feeds > 0)) {
            if (Date.now() >= deadline) return false;
            await pause(page);
            current = await read(page, pageStateJs());
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * 常驻页能不能接着用；能用就页内回到干净的 /explore，再等首页推流稳（为什么见文件头）。自己不 goto、不抛。
 * 已在 /explore、没开着帖子、也没停在直链改写上就不点；开着帖子、在别的路径、或停在直链改写上，就点 logo，
 * 最多等 HOP_WAIT_MS 到同样干净的 /explore（waitForExplore）。然后最多等 SETTLE_WAIT_MS 推流稳，等不到也照常返回。
 * 返回 { reopenReason, settled }：能接着用 reopenReason 为 null、settled 是推流稳没稳；不能用 reopenReason 是要 goto
 * 重开的原因——blank / left_site:<域名> / no_app / not_logged_in / explore_hop_failed / no_page_state（名字沿用原
 * notification-helpers），settled 为 null。openNotificationPage 用它（goto 照旧自己做，出错照旧往外抛）；别的命令用
 * ensureResidentPage。
 */
export async function prepareResidentPage(page) {
    const reopen = reopenReason => ({ reopenReason, settled: null });
    let probe;
    try {
        probe = unwrap(await page.evaluate(
            `(${readResidentPage.toString()})(${JSON.stringify(NOTIFICATION_LINK_SELECTOR)}, ${JSON.stringify(EXPLORE_LINK_SELECTOR)})`));
    } catch {
        return reopen('no_page_state');
    }
    if (!probe || typeof probe !== 'object') return reopen('no_page_state');
    if (!probe.host) return reopen('blank');
    if (probe.host !== SITE_HOST) return reopen(`left_site:${probe.host}`);
    if (!probe.app) return reopen('no_app');
    if (!probe.loggedIn) return reopen('not_logged_in');
    if (!(probe.exploreLinks > 0)) return reopen('explore_hop_failed');
    let state = await read(page, pageStateJs());
    if (!isCleanExplore(state)) {
        if (!(await clickVisible(page, EXPLORE_LINK_SELECTOR))) return reopen('explore_hop_failed');
        state = await waitForExplore(page);
        if (!state) return reopen('explore_hop_failed');
    }
    return { reopenReason: null, settled: await waitFeedSettled(page, state) };
}

/**
 * 常驻页能用就页内回到 /explore（prepareResidentPage），不能用就 goto 首页重开（经手机出口）。不抛。
 * 返回 { reused, reopenReason, settled }：reused=true 时 reopenReason 为 null、settled 是推流稳没稳；重开了 reopenReason
 * 是原因、settled 为 null（重开后不等推流）。goto 本身出错也不抛，多带一个 gotoError（一行错误信息），后面的步骤自会失败。
 */
export async function ensureResidentPage(page) {
    const { reopenReason, settled } = await prepareResidentPage(page);
    if (!reopenReason) return { reused: true, reopenReason: null, settled };
    try {
        await page.goto(HOME_URL);
    } catch (error) {
        return { reused: false, reopenReason, settled: null, gotoError: oneLine(error) };
    }
    return { reused: false, reopenReason, settled: null };
}

/**
 * 帖子打开对没对：对了返回 null，不对返回原因。打开的判据：currentNoteId 是这一条、地址里有这个编号、#noteContainer 里有作者
 * 并有标题 / 正文 / 媒体之一。inPage=true（页内打开）必须 currentNoteId 对上；整页打开时 currentNoteId 读不到就只看地址和
 * 内容，读到了也得对上。
 */
function noteVerdict(state, noteId, inPage) {
    if (!state) return 'no_page_state';
    if (state.host && state.host !== SITE_HOST) return `left_site:${state.host}`;
    if (LOGIN_PATH_RE.test(state.path || '')) return `login_page:${state.path}`;
    if (state.directLink) return 'direct_link';
    if (state.currentNoteId && state.currentNoteId !== noteId) return 'note_mismatch';
    if (!state.currentNoteId && inPage) return 'not_opened';
    if (!state.pathHasId) return 'not_opened';
    if (!state.author || !(state.title || state.desc || state.media)) return 'no_content';
    return null;
}

/** 这些原因再等也不会好：直链改写、离站、落到登录页，立刻判这次失败。 */
function isFinalNoteReason(reason) {
    return reason === 'direct_link' || reason.startsWith('left_site:') || reason.startsWith('login_page:');
}

/** 最多等 NOTE_WAIT_MS 核对帖子打开了、而且是这一条；成了返回 null，不成返回最后一次的原因。 */
async function waitNoteOpened(page, noteId, inPage) {
    const deadline = Date.now() + NOTE_WAIT_MS;
    while (true) {
        const reason = noteVerdict(await read(page, pageStateJs(noteId)), noteId, inPage);
        if (!reason || isFinalNoteReason(reason) || Date.now() >= deadline) return reason;
        await pause(page);
    }
}

/** 页内跳一次帖子（prevRoute 是 'Empty' 先改，再 push），然后核对；成了返回 null，不成返回原因。 */
async function pushNote(page, noteId, path) {
    const pushed = await read(page, `(${pushRoute.toString()})(${JSON.stringify(path)}, true)`);
    if (!pushed) return 'no_page_state';
    if (!pushed.pushed) return pushed.error || 'push_failed';
    return waitNoteOpened(page, noteId, true);
}

async function openNote(page, noteId, xsecToken, xsecSource) {
    if (typeof noteId !== 'string' || !NOTE_ID_RE.test(noteId)) {
        return { ok: false, inPage: false, attempts: 0, fallback: false, reason: 'bad_note_id', resident: null };
    }
    const path = `/explore/${noteId}?xsec_token=${encodeURIComponent(xsecToken ?? '')}`
        + `&xsec_source=${encodeURIComponent(xsecSource ?? '')}`;
    const resident = await ensureResidentPage(page);
    let reason = null;
    for (let attempt = 1; attempt <= NOTE_IN_PAGE_ATTEMPTS; attempt++) {
        // 第二次之前清场：点 logo 关掉残局回首页、等推流稳；页坏了就重开。
        if (attempt > 1) await ensureResidentPage(page);
        reason = await pushNote(page, noteId, path);
        if (!reason) return { ok: true, inPage: true, attempts: attempt, fallback: false, reason: null, resident };
    }
    const failed = finalReason => ({
        ok: false, inPage: false, attempts: NOTE_IN_PAGE_ATTEMPTS, fallback: true, reason: finalReason, resident,
    });
    try {
        await page.goto(`${SITE_ORIGIN}${path}`);
    } catch {
        return failed('goto_failed');
    }
    const fallbackReason = await waitNoteOpened(page, noteId, false);
    if (fallbackReason) return failed(fallbackReason);
    return { ok: true, inPage: false, attempts: NOTE_IN_PAGE_ATTEMPTS, fallback: true, reason, resident };
}

/**
 * 页内打开指定帖子（方案 A，为什么见文件头）：ensureResidentPage 回到干净的首页 → note store prevRoute 还是 'Empty' 就先改成
 * 'Explore' → 路由跳 /explore/<id>?xsec_token=…&xsec_source=… → 最多等 NOTE_WAIT_MS 核对打开的就是这一条（判据见
 * noteVerdict），看到直链改写立刻判这次失败 → 不成就 ensureResidentPage 清场再跳一次 → 还不成才 goto 帖子网址整页打开
 * （经手机出口），按同样判据核对（currentNoteId 读不到时只看地址和内容）。
 * 不抛，返回 { ok, inPage, attempts, fallback, reason, resident }：attempts 是页内跳了几次；fallback 表示用了整页打开；
 * reason 在页内打开成功时为 null、整页打开成功时是页内失败的原因、全失败时是最后失败的原因；resident 是第一次
 * ensureResidentPage 的结果（给 reportResident 用）。往 stderr 写一行 [xhs-resident] note=inpage / note=fallback:<原因> /
 * note=failed:<原因>。
 * [xhs-resident] 开头的 stderr 行是留给定时任务（注释里叫「看门狗」）解析的协议，格式别随便改。
 */
export async function openNoteInPage(page, { noteId, xsecToken, xsecSource } = {}) {
    let result;
    try {
        result = await openNote(page, noteId, xsecToken, xsecSource);
    } catch (error) {
        result = { ok: false, inPage: false, attempts: 0, fallback: false, reason: `unexpected:${oneLine(error)}`, resident: null };
    }
    const line = result.ok ? (result.inPage ? 'inpage' : `fallback:${result.reason}`) : `failed:${result.reason}`;
    process.stderr.write(`[xhs-resident] note=${line}\n`);
    return result;
}

const NOTE_URL_PATH_RE = /^\/(?:explore|note|search_result|discovery\/item)\/([0-9a-f]+)(?:[/?#]|$)|^\/user\/profile\/[^/?#]+\/([0-9a-f]+)(?:[/?#]|$)/i;

/**
 * 从一条帖子网址里取出页内打开要的三样 { noteId, xsecToken, xsecSource }，交给 openNoteInPage。认的网址跟 note-helpers.js 的
 * buildNoteUrl 一样：主站 xiaohongshu.com（含子域），路径 /explore|note|search_result|discovery/item/<编号> 或
 * /user/profile/<用户>/<编号>，带 xsec_token；短链解开后的 /discovery/item/<编号>?…&xsec_source=app_share 也在内。
 * 查询参数手动取、只做 decodeURIComponent，不用 URLSearchParams：它把「+」解成空格，通行码里要是有「+」就坏了，连整页兜底
 * 也会带着坏通行码去开（openNoteInPage 拼地址时再 encodeURIComponent，「+」变 %2B，网站路由解回来还是「+」）。
 * xsec_source 没有就是空串（实测来源参数不是关键）。不是主站、认不出编号、没有 xsec_token 都返回 null，不抛。
 */
export function noteTargetFromUrl(noteUrl) {
    let url;
    try {
        url = new URL(String(noteUrl ?? '').trim());
    } catch {
        return null;
    }
    const host = url.hostname.toLowerCase();
    if (host !== 'xiaohongshu.com' && !host.endsWith('.xiaohongshu.com')) return null;
    const match = url.pathname.match(NOTE_URL_PATH_RE);
    if (!match) return null;
    const param = name => {
        const found = url.search.match(new RegExp(`[?&]${name}=([^&]*)`));
        if (!found) return null;
        try {
            return decodeURIComponent(found[1]);
        } catch {
            return found[1];
        }
    };
    const xsecToken = param('xsec_token')?.trim();
    if (!xsecToken) return null;
    return { noteId: match[1] || match[2], xsecToken, xsecSource: param('xsec_source')?.trim() || '' };
}

async function search(page, keyword) {
    if (typeof keyword !== 'string' || !keyword.trim()) return { ok: false, reason: 'empty_keyword', count: 0, resident: null };
    const resident = await ensureResidentPage(page);
    const fail = reason => ({ ok: false, reason, count: 0, resident });
    const readJs = `(${readSearchState.toString()})(${JSON.stringify(SEARCH_INPUT_SELECTOR)})`;
    const before = await read(page, readJs);
    if (!before) return fail('no_page_state');
    const beforeIds = before.ids.join('\n');
    const path = `${SEARCH_PATH}?keyword=${encodeURIComponent(keyword)}&source=web_explore_feed`;
    const pushed = await read(page, `(${pushRoute.toString()})(${JSON.stringify(path)}, false)`);
    if (!pushed) return fail('no_page_state');
    if (!pushed.pushed) return fail(pushed.error || 'push_failed');
    // 第一步：等到了搜索页、有一个看得见的搜索框（首页那个是隐藏的）。
    let deadline = Date.now() + SEARCH_PAGE_WAIT_MS;
    let state;
    while (true) {
        state = await read(page, readJs);
        if (state?.path === SEARCH_PATH && state.inputs > 0) break;
        if (state?.host && state.host !== SITE_HOST) return fail(`left_site:${state.host}`);
        if (Date.now() >= deadline) return fail(state?.path === SEARCH_PATH ? 'search_input_not_found' : 'search_page_not_reached');
        await pause(page);
    }
    // 第二步：框里填词、点搜索。
    const submitted = await read(page, `(${submitSearch.toString()})(${JSON.stringify(keyword)}, `
        + `${JSON.stringify(SEARCH_INPUT_SELECTOR)}, ${JSON.stringify(SEARCH_BUTTON_SELECTOR)})`);
    if (!submitted) return fail('no_page_state');
    if (!submitted.filled) return fail('search_input_not_found');
    if (!submitted.clicked) return fail('search_button_not_found');
    // 第三步：等这次的结果。store 留着上一次的，所以要 state 成功、searchValue 是这次的词、有条目，
    // 且条目编号跟跳之前不同（或者跳之前搜的就是这个词，同词重搜结果可以一样）。
    deadline = Date.now() + SEARCH_RESULT_WAIT_MS;
    while (true) {
        await pause(page);
        state = await read(page, readJs);
        const ids = state ? state.ids : [];
        const ours = state?.state === 'success' && state.searchValue === keyword;
        if (ours && ids.length > 0 && (ids.join('\n') !== beforeIds || before.searchValue === keyword)) {
            return { ok: true, reason: null, count: ids.length, resident };
        }
        if (Date.now() >= deadline) {
            if (!state) return fail('no_page_state');
            if (state.state === 'error') return fail('search_error');
            if (ours) return fail(ids.length ? 'stale_results' : 'no_results');
            return fail('search_timeout');
        }
    }
}

/**
 * 页内搜索（为什么两步走见文件头）：ensureResidentPage 回首页 → 记下 search store 里现有的结果 → 路由跳
 * /search_result?keyword=…&source=web_explore_feed → 等看得见的搜索框 → 原生 setter 填词 + input 事件 → 点搜索 →
 * 等到确认是这次的结果。只负责把结果弄进 search store，取数留给 search 命令。
 * 不抛，返回 { ok, reason, count, resident }：count 是这次结果条数（失败为 0）；resident 是 ensureResidentPage 的结果。
 * reason：empty_keyword / no_page_state / no_router / push_threw / left_site:<域名> / search_page_not_reached /
 * search_input_not_found / search_button_not_found / search_error / stale_results / no_results / search_timeout。
 */
export async function searchInPage(page, keyword) {
    try {
        return await search(page, keyword);
    } catch (error) {
        return { ok: false, reason: `unexpected:${oneLine(error)}`, count: 0, resident: null };
    }
}

async function refreshFeed(page) {
    const resident = await ensureResidentPage(page);
    const fail = reason => ({ ok: false, reason, count: 0, resident });
    const readJs = `(${readFeedIds.toString()})()`;
    const before = await read(page, readJs);
    if (!before) return fail('no_page_state');
    const beforeIds = (before.ids || []).join('\n');
    if (!(await clickVisible(page, REFRESH_BUTTON_SELECTOR))) return fail('refresh_button_not_found');
    const deadline = Date.now() + REFRESH_WAIT_MS;
    let state;
    while (true) {
        await pause(page);
        state = await read(page, readJs);
        const ids = state?.ids || [];
        if (ids.length > 0 && ids.join('\n') !== beforeIds) return { ok: true, reason: null, count: ids.length, resident };
        if (Date.now() >= deadline) break;
    }
    return fail(!state ? 'no_page_state' : !state.ids?.length ? 'feed_empty' : 'feed_not_refreshed');
}

/**
 * 页内刷新首页推流：ensureResidentPage 回首页 → 记下 feed store 现有条目编号 → 点右下角看得见的「刷新」→ 最多等
 * REFRESH_WAIT_MS 到编号换了。只负责把新推流弄进 feed store，取数留给 feed 命令。
 * 不抛，返回 { ok, reason, count, resident }：count 是新推流条数（失败为 0）。reason：refresh_button_not_found /
 * no_page_state / feed_empty / feed_not_refreshed。
 */
export async function refreshFeedInPage(page) {
    try {
        return await refreshFeed(page);
    } catch (error) {
        return { ok: false, reason: `unexpected:${oneLine(error)}`, count: 0, resident: null };
    }
}

/**
 * 本轮 persistent 会话认领的那张标签页的浏览器调试编号（page.tabs() 里的 page 字段，和 9222/json/list 的 id 同一种）。
 * 只认「恰好列出一张、它的编号可用」：会话只认领一张页，列出来不是一张（没认领 / 扩展行为变了）就是和假设对不上，
 * 宁可不报也别猜；可用 = 非空、不含空白的字符串（要原样写进 `tab=` 那一行，看门狗按 \S+ 解析）。
 * 看门狗把它记成 resident_tab_id，定期整理脚本只留这一张、关掉别的网页；
 * 浏览器重启后恢复出来的旧通知页没被会话认领，不在这个列表里，不会被认成常驻页。
 * 绝不抛：这是取数路上新加的一步，拿不到（page.tabs 不存在 / 扩展没应答 / 数据不对）就返回 null，不能把取数弄坏。
 */
export async function readResidentTabId(page) {
    try {
        const tabs = await page.tabs();
        const id = Array.isArray(tabs) && tabs.length === 1 ? tabs[0]?.page : null;
        return typeof id === 'string' && /^\S+$/.test(id) ? id : null;
    } catch {
        return null;
    }
}

/**
 * 往 stderr 报这轮常驻页的情况，格式和 mentions.js 写的一字不差（看门狗按这两行解析）：先写
 * [xhs-resident] reused 或 [xhs-resident] reopened:<原因>，再写 [xhs-resident] tab=<编号>（readResidentTabId 拿得到才写）。
 * resident 是 ensureResidentPage（或 openNoteInPage / searchInPage / refreshFeedInPage 带回的 resident）；没有就什么都不写。
 * 返回写出去的标签页编号（没有为 null）。stdout 一个字不碰。
 */
export async function reportResident(page, resident) {
    if (!resident) return null;
    process.stderr.write(`[xhs-resident] ${resident.reused ? 'reused' : `reopened:${resident.reopenReason}`}\n`);
    const tabId = await readResidentTabId(page);
    if (tabId) process.stderr.write(`[xhs-resident] tab=${tabId}\n`);
    return tabId;
}
