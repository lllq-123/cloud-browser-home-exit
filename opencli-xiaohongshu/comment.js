// 我们家自己写的，按 Apache-2.0 公开（见 LICENSE）
/**
 * Xiaohongshu 评论发布 — note detail page UI automation.
 *
 * Flow:
 *   1. Open the note in the resident tab without reloading (openNoteForComment → resident-helpers.js
 *      openNoteInPage; xsec_token URL required, same as `comments`), then clear what the last round
 *      left in that page (resetCommentRound) — see 「常驻页」 below
 *   2. Wait for the lazy editor, check login / 风控 gates
 *   3. Pause as if reading, replace any stale draft, type the text in short bursts, verify the
 *      exact text, pause before Enter (typeCommentLikeHuman; one-shot exact fill as fallback)
 *   4. Press Enter in the input — 小红书's own keyboard shortcut — and prove the input
 *      received keyCode 13
 *   5. Read the real POST status (461 = 扫码验证), fall back to explicit UI postconditions
 *   6. Only if Enter is proved undelivered (or never attempted), and time remains:
 *      fall back to the old route (expand the 取消/发送 row, trusted click on 发送)
 *
 * Why Enter is the primary path (2026-09-06): every breakage since 7-22 was geometry —
 * the 取消/发送 row lives in `div.bottom` (height:0 + overflow:hidden) and 小红书 keeps
 * changing what expands it. In the modal layout (`.note-detail-mask.undertake-ssr`)
 * nothing expands it at all: click / focus / typing all leave it clipped, so a
 * coordinate click lands on the mask. The input's own keydown handler is
 * `13 === e.keyCode && (ctrl/meta/shift ? newline : emit('handleSubmit'))` — a user
 * feature, not layout. `p.content-input` has been stable since 2026-05-04.
 *
 * Why the key event is dispatched by hand: opencli's `pressKey('Enter')` sends
 * `Input.dispatchKeyEvent` without `windowsVirtualKeyCode`, so the page sees keyCode 0
 * and 小红书 ignores it. We send keyCode 13 through `page.cdp`, verified by a capture
 * probe on the input; a synthetic KeyboardEvent is the last resort (handler does not
 * check isTrusted).
 *
 * Why step 5 reads the HTTP status: on 风控 rejection 小红书 answers HTTP 461 with a
 * body of `{code: 0, success: true, data: {}}` — body-only inspection reports a false
 * success. Status plus non-empty data are both required. (2026-07-27)
 *
 * Why step 3 types (2026-10-17): web-sent comments started landing in 审核中 while the same words
 * sent from the app passed. One suspect is the text appearing in one piece and going out at once,
 * so it now goes in as 1–4 character bursts between human-length pauses.
 *
 * Reply mode (`--reply-to <评论ID>`, 2026-10-05) puts the text under one specific comment:
 *   Route 1 — 通知页: open /notification by clicking through from the home page (loaded directly,
 *     overseas IPs are sent to www.rednote.com since 2026-10-27), switch to 「评论和@」, find the notice whose
 *     commentInfo.id is the target, click its 回复, require the box to say 「回复 <昵称>」, fill,
 *     click 发送. Everything that @s us, replies to us or comments on our notes is listed there,
 *     however busy the note is (a 1420-comment note loads 10 top-level comments per batch, and
 *     the web ignores the app's anchorCommentId).
 *   Route 2 — 帖子页: open the note, find `#comment-<id>` (opening 「展开 N 条回复」 threads and
 *     scrolling `.note-scroller`, bounded), click its 回复, require pinia
 *     `note.commentTarget.id === <id>` before and after filling, then steps 4–6 above.
 *   Neither finds it → nothing is sent. There is deliberately no match-by-user-ID fallback —
 *   that is how xiaohongshu-mcp replies under the wrong comment (its issue #860).
 *   Send-time guard: in reply mode the comment/post request is inspected inside the page and
 *   blocked unless its target_comment_id is the target, so a lost reply state can never turn
 *   into a top-level comment or a reply to someone else.
 *
 * 常驻页（2026-10-27）：从新加坡整页打开主站会被导去海外版，主站整页只能经家里手机出口（慢、会断），所以这条命令跑在
 *   opencli 常驻会话（siteSession: 'persistent'，site:xiaohongshu 那一张页）里：帖子用 openNoteInPage 页内打开，页内
 *   两次都不成才整页打开（经手机出口）；没打开（ok:false）页面停在哪不确定，不打字、不点发送。这张页在命令之间从不刷新，
 *   所以每轮开头、打字之前清掉上一轮留在页面里的回复对象（__xhsReplyExpectedTarget）和没取走的回执
 *   （__xhsCommentCaptures），发送前装钩子时再清一次回执；钩子每张页只装一次，不会套两层。发评论的接口
 *   /api/sns/web/v1/comment/post 在 edith，本来就新加坡直连。
 *
 * Requires: logged into www.xiaohongshu.com in Chrome (cookie injected).
 *
 * Usage:
 *   opencli xiaohongshu comment "<note-url-with-xsec_token>" "评论内容"
 *   opencli xiaohongshu comment "<note-url-with-xsec_token>" "回复内容" --reply-to <评论ID>
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CliError } from '@jackwener/opencli/errors';
import { buildNoteUrl, inspectNoteAccess, parseNoteId } from './note-helpers.js';
import { ensureMentionsTab, openNotificationPage } from './notification-helpers.js';
import { noteTargetFromUrl, openNoteInPage, reportResident } from './resident-helpers.js';

const MAX_COMMENT_LEN = 300;
const COMMENT_INPUT_WAIT_MS = 20_000;
const COMMENT_INPUT_POLL_MS = 750;
const EDITOR_EXPAND_WAIT_MS = 8_000;
const EDITOR_EXPAND_POLL_MS = 400;
const SUBMIT_WAIT_MS = 15_000;
const SUBMIT_POLL_MS = 750;
const COMMENT_POST_API = '/api/sns/web/v1/comment/post';
// 回执钩子的版本号（第 3 版：请求发出那一刻绑上轮次编号）。常驻页不刷新，页上可能还装着旧版钩子（没有版本号）：
// 版本对不上就在外层再装一层这一版；读回执只认这一版记的、这一轮的（installCommentCapture / readCommentCaptures）。
const COMMENT_HOOK_VERSION = 3;
// CDP key event that reaches the page as keyCode 13. `pressKey` omits the virtual key
// code, so 小红书's `13 === e.keyCode` check never fires through it.
const ENTER_KEY_EVENT = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
const INPUT_SELECTORS = [
    'p.content-input',
    '.content-edit [contenteditable="true"]',
];
const SUBMIT_SELECTORS = [
    'button.btn.submit',
    'button[class*="submit"]',
];
const CANCEL_SELECTORS = [
    'button.btn.cancel',
    'button[class*="cancel"]',
];
const CAPTCHA_SELECTORS = [
    '.r-captcha-modal',
    '.fe-captcha-app',
    '[class*="captcha-modal"]',
];
// opencli gives browser commands 60s by default and does not cancel the adapter when that
// fires — the tab keeps going. Reply mode can visit two pages, so the command declares its own.
// 2026-10-27 180 → 270：帖子改成常驻页里页内打开（openNoteInPage），最坏约 85 秒（回首页 ≤16s + 页内跳两次各核对
// ≤10s + 第二次前清场 ≤16s + 整页兜底经手机出口约 22s + 再核对 ≤10s），原来一次 goto 只要几秒到二十来秒。顶层评论最坏：
// 打开 85 + 等页面 4 + 等输入框 20 = 109s，离发送时限（270 − SUBMIT_MARGIN_S = 225s）还有 116s 给读一会儿 + 逐段打字；
// 只走帖子页的回复再加找评论最多 60s + 点回复约 7s，还剩约 50s。先通知页再帖子页、两边都碰上最坏时会撞上发送时限，
// 照旧报 timeUpRow、不发。opencli 在这个数上再加 30 秒才判整条命令超时（execution.js:322-324、:537）。
const COMMAND_TIMEOUT_S = 270;
// Never start a send with less than this left: Enter + receipt wait + button fallback ≈ 40s.
const SUBMIT_MARGIN_S = 45;
const REPLY_ROUTES = ['auto', 'notice', 'note'];
const REPLY_ARM_WAIT_MS = 5_000;
const REPLY_ARM_POLL_MS = 300;
const REPLY_READBACK_WAIT_MS = 6_000;
const NOTICE_ITEM_SELECTOR = '.tabs-content-container > .container';
const NOTICE_TARGET_ATTR = 'data-xhs-reply-target';
const NOTICE_MAX_PAGES = 5;
const NOTE_SEARCH_MAX_MS = 60_000;
const NOTE_SEARCH_MAX_ROUNDS = 30;
const NOTE_SEARCH_STALL_ROUNDS = 5;
const NOTE_SEARCH_MAX_EXPAND = 3;
// 「展开 N 条回复」 / 「展开更多回复」 only — other 展开 buttons are not reply threads.
const EXPAND_REPLIES_RE = '^展开\\s*(\\d+\\s*条|更多)回复$';
const READBACK_NOTES = {
    in_thread: '页面上已挂在这条底下',
    elsewhere: '⚠️ 页面上出现在别处',
    not_rendered: '页面上还没刷出来（以服务器回执为准）',
    no_id: '回执里没有新回复 ID，页面上没法核对',
};
// Step 3 pacing (typeCommentLikeHuman): a pause before touching the box, one before Enter.
const READ_PAUSE_MS = [1_500, 4_000];
const REVIEW_PAUSE_MS = [800, 2_500];
// Assumed cost of one Input.insertText round trip — only for budgeting the typing.
const TYPE_BURST_RPC_MS = 100;
// Kept free after typing: read-back, the exact-fill fallback, the caller's last checks before Enter.
const TYPE_TAIL_MS = 10_000;

const normalizeText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const preview = (value, max = 60) => {
    const text = String(value ?? '');
    return `${text.slice(0, max)}${text.length > max ? '…' : ''}`;
};
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** `--reply-to` takes a comment ID (24 hex). A long all-digit number is a notice ID — the easy mix-up. */
function parseReplyTarget(raw) {
    const value = String(raw ?? '').trim();
    if (!value) return { id: null };
    if (/^[0-9a-f]{24}$/i.test(value)) return { id: value.toLowerCase() };
    if (/^\d{15,22}$/.test(value)) {
        return { error: `「${value}」是通知编号，不是评论 ID。评论 ID 是 24 位字母数字（mentions 输出里的 comment_id）` };
    }
    return { error: `「${value}」不像小红书评论 ID（应为 24 位字母数字）` };
}

/**
 * Send-time guard, injected into the page via toString(). In reply mode a comment/post request
 * whose target_comment_id is not the target is blocked before it leaves. Without a target
 * (top-level comment) a body that reads as JSON and carries a target_comment_id is blocked
 * (unexpected_target)：常驻页上网站自己的回复态（pinia note.commentTarget）可能跨轮残留，顶层评论绝不能
 * 带着回复对象发出去。顶层模式下读不成 JSON 的请求照旧放行，和原来一样。
 */
function replyGuardVerdict(rawBody, expectedTarget) {
    let body = null;
    try { body = typeof rawBody === 'string' ? JSON.parse(rawBody) : null; } catch { body = null; }
    const readable = Boolean(body) && typeof body === 'object';
    const raw = readable ? body.target_comment_id : undefined;
    const target = raw === undefined || raw === null || raw === '' ? null : String(raw);
    if (!expectedTarget) {
        if (target) return { block: true, target, reason: 'unexpected_target', keys: Object.keys(body).slice(0, 12) };
        return { block: false, target: null };
    }
    if (!readable) return { block: true, target: null, reason: 'unreadable_body' };
    if (target !== String(expectedTarget)) {
        return { block: true, target, reason: target ? 'wrong_target' : 'no_target', keys: Object.keys(body).slice(0, 12) };
    }
    return { block: false, target };
}

/**
 * Does a notice's rendered text match the store's comment? Emoji codes like [偷笑R] render as
 * images (no text), and long comments may be cut with an ellipsis. Injected via toString().
 */
function noticeTextMatches(storeContent, domText) {
    const squash = (value) => String(value ?? '').replace(/\[[^\[\]\n]{1,12}\]/g, '').replace(/\s+/g, '');
    const want = squash(storeContent);
    const got = squash(domText);
    if (want === got) return true;
    if (want.length >= 2 && got.includes(want)) return true;
    const cut = got.replace(/(\.\.\.|…)$/, '');
    return cut !== got && cut.length >= 8 && want.startsWith(cut);
}

async function locateVisibleTarget(page, selectors, options = {}) {
    const result = await page.evaluateWithArgs(`
      (() => {
        const isVisible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        for (const selector of selectors) {
          const nodes = Array.from(document.querySelectorAll(selector));
          for (let nth = 0; nth < nodes.length; nth++) {
            const el = nodes[nth];
            if (!isVisible(el)) continue;
            if (requiredText && (el.innerText || el.textContent || '').trim() !== requiredText) continue;
            if (requireEnabled && (el.disabled || el.getAttribute('aria-disabled') === 'true')) continue;
            return { selector, nth };
          }
        }
        return null;
      })()
    `, {
        selectors,
        requiredText: String(options.text ?? ''),
        requireEnabled: Boolean(options.enabled),
    });
    return result?.selector ? result : null;
}

/**
 * Strict hit test: is this exact element the topmost paintable thing at its own
 * centre? An ancestor answering instead means the element is clipped or covered, and
 * a coordinate click would land on the wrong node while still reporting success.
 */
async function hitTest(page, target, { scrollIntoView = false } = {}) {
    return page.evaluateWithArgs(`
      (() => {
        const el = document.querySelectorAll(selector)[nth];
        if (!el) return { found: false };
        if (scrollIntoView) el.scrollIntoView({ behavior: 'instant', block: 'center' });
        const rect = el.getBoundingClientRect();
        const cx = Math.round(rect.x + rect.width / 2);
        const cy = Math.round(rect.y + rect.height / 2);
        const at = (cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight)
          ? document.elementFromPoint(cx, cy)
          : null;
        const describe = (node) => node
          ? node.tagName + (node.className ? '.' + String(node.className).trim().split(/\\s+/).join('.') : '')
          : null;
        return {
          found: true,
          hit: !!(at && (at === el || el.contains(at))),
          blockedBy: describe(at),
          inViewport: rect.top >= 0 && rect.bottom <= innerHeight,
          rect: { y: Math.round(rect.y), bottom: Math.round(rect.bottom), h: Math.round(rect.height) },
          viewport: { w: innerWidth, h: innerHeight },
          disabled: !!el.disabled,
        };
      })()
    `, { selector: target.selector, nth: target.nth, scrollIntoView });
}

async function detectVerificationGate(page) {
    return page.evaluateWithArgs(`
      (() => {
        const isVisible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        for (const selector of selectors) {
          const el = Array.from(document.querySelectorAll(selector)).find(isVisible);
          if (el) return { present: true, text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160) };
        }
        return { present: false, text: '' };
      })()
    `, { selectors: CAPTCHA_SELECTORS });
}

async function waitForCommentInput(page) {
    const deadline = Date.now() + COMMENT_INPUT_WAIT_MS;
    let lastGate = null;

    while (Date.now() < deadline) {
        lastGate = await page.evaluate(`
      (() => {
        const bodyText = document.body?.innerText || '';
        return {
          ...(${inspectNoteAccess.toString()})(),
          commentsLoading: /加载中/.test(bodyText),
          url: location.href,
        };
      })()
    `);
        if (lastGate.securityBlock) {
            throw new CliError('SECURITY_BLOCK', 'Xiaohongshu security block on the note detail page.', 'The page may be temporarily restricted. Try a different note URL or retry later.');
        }
        if (lastGate.loginWall) {
            throw new AuthRequiredError('www.xiaohongshu.com', 'Posting comments requires login');
        }

        const target = await locateVisibleTarget(page, INPUT_SELECTORS);
        if (target) return target;
        await page.wait({ time: COMMENT_INPUT_POLL_MS / 1_000 });
    }

    await page.screenshot({ path: '/tmp/xhs_comment_no_input_debug.png' });
    const loadingHint = lastGate?.commentsLoading ? ' The comment area was still showing “加载中”.' : '';
    throw new Error(`Comment input did not become ready within ${COMMENT_INPUT_WAIT_MS / 1_000}s.${loadingHint} ` +
        'Debug screenshot: /tmp/xhs_comment_no_input_debug.png');
}

/**
 * Click the collapsed comment bar so 小红书 renders the 取消/发送 row. Runs before the
 * text is filled: focus alone leaves `div.bottom` at height 0 and its buttons unclickable.
 */
async function activateEditor(page) {
    const deadline = Date.now() + EDITOR_EXPAND_WAIT_MS;
    let clicks = 0;
    let lastState = null;

    while (Date.now() < deadline) {
        const submit = await locateVisibleTarget(page, SUBMIT_SELECTORS, { text: '发送' });
        if (submit) {
            lastState = await hitTest(page, submit);
            if (lastState?.hit) return { submit, clicks };
            if (lastState?.found && !lastState.inViewport) {
                lastState = await hitTest(page, submit, { scrollIntoView: true });
                if (lastState?.hit) return { submit, clicks };
            }
        }
        if (clicks < 2) {
            const target = await locateVisibleTarget(page, INPUT_SELECTORS);
            if (target) {
                await page.click(target.selector, { nth: target.nth });
                clicks += 1;
            }
        }
        await page.wait({ time: EDITOR_EXPAND_POLL_MS / 1_000 });
    }

    await page.screenshot({ path: '/tmp/xhs_comment_collapsed_debug.png' });
    throw new Error('评论编辑器没有展开：发送按钮仍被裁剪/遮挡' +
        `${lastState?.blockedBy ? `（该位置上的元素是 ${lastState.blockedBy}）` : ''}。` +
        `点击输入框 ${clicks} 次后仍未展开。截图: /tmp/xhs_comment_collapsed_debug.png`);
}

async function readCommentUi(page, expectedText) {
    return page.evaluateWithArgs(`
      (() => {
        const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const isVisible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        let input = null;
        for (const selector of inputSelectors) {
          input = Array.from(document.querySelectorAll(selector)).find(isVisible) || null;
          if (input) break;
        }
        const inputText = input ? (input.innerText || input.textContent || '').trim() : '';
        const matched = Array.from(document.querySelectorAll('.parent-comment .content, .comment-item .content'))
          .some(el => clean(el.textContent) === clean(expectedText));
        const notices = Array.from(document.querySelectorAll(
          '[role="alert"], [class*="toast"], [class*="message"], [class*="notice"], [class*="error"]'
        )).filter(isVisible).map(el => clean(el.innerText || el.textContent)).filter(text => text && text.length <= 240);
        const blockedText = notices.find(text => /(评论失败|发送失败|包含敏感|违规|发送过快|操作频繁|请求失败)/.test(text)) || '';
        const successText = notices.find(text => /(评论成功|发送成功|发布成功)/.test(text)) || '';
        return {
          inputFound: !!input,
          inputText,
          inputCleared: !input || clean(inputText).length === 0,
          matched,
          blockedText,
          successText,
        };
      })()
    `, { inputSelectors: INPUT_SELECTORS, expectedText });
}

async function fillCommentExactly(page, text) {
    const exact = value => String(value ?? '').replace(/\r\n?/g, '\n').trim();
    let target = await locateVisibleTarget(page, INPUT_SELECTORS);
    if (!target) throw new Error('Comment input not found while preparing text.');

    const fill = async () => {
        if (typeof page.fillText === 'function') {
            return page.fillText(target.selector, text, { nth: target.nth });
        }
        await page.typeText(target.selector, text, { nth: target.nth });
        return null;
    };

    let result = await fill();
    let state = await readCommentUi(page, text);
    if (result?.verified !== true || exact(state.inputText) !== exact(text)) {
        target = await locateVisibleTarget(page, INPUT_SELECTORS);
        if (!target) throw new Error('Comment input disappeared while retrying exact fill.');
        if (typeof page.focus === 'function') {
            const focused = await page.focus(target.selector, { nth: target.nth });
            if (!focused?.focused) throw new Error('Could not focus comment input.');
        }
        await page.pressKey('Control+a');
        await page.pressKey('Backspace');
        await page.wait({ time: 0.15 });
        result = await fill();
        state = await readCommentUi(page, text);
    }

    if (exact(state.inputText) !== exact(text)) {
        await page.screenshot({ path: '/tmp/xhs_comment_type_debug.png' });
        throw new Error(`Failed to set exact comment text. Got "${preview(state.inputText, 100)}". ` +
            'Debug screenshot: /tmp/xhs_comment_type_debug.png');
    }
    return state;
}

async function clearCommentInput(page) {
    let target = await locateVisibleTarget(page, INPUT_SELECTORS);
    if (!target) return { cleared: true, inputMissing: true };
    if (typeof page.focus === 'function') {
        const focused = await page.focus(target.selector, { nth: target.nth });
        if (!focused?.focused) throw new Error('Could not focus comment input for cleanup.');
    }
    await page.pressKey('Control+a');
    await page.pressKey('Backspace');
    await page.wait({ time: 0.15 });

    let state = await readCommentUi(page, '');
    if (!state.inputCleared && typeof page.fillText === 'function') {
        target = await locateVisibleTarget(page, INPUT_SELECTORS);
        if (target) await page.fillText(target.selector, '', { nth: target.nth });
        state = await readCommentUi(page, '');
    }
    if (!state.inputCleared) {
        await page.screenshot({ path: '/tmp/xhs_comment_cleanup_debug.png' });
        throw new Error(`Comment input cleanup failed; residual text: "${preview(state.inputText, 100)}". ` +
            'Debug screenshot: /tmp/xhs_comment_cleanup_debug.png');
    }
    return { cleared: true, inputMissing: !state.inputFound };
}

/**
 * Split `text` into typing bursts of 1–4 code points (emoji and other surrogate pairs stay whole),
 * each with the pause that follows it: 60–220ms, and 300–900ms about every 8–15 characters.
 * Joining the chunks gives back exactly `text`. Pure; `rand` is injectable for tests.
 */
function planTypingChunks(text, rand = Math.random) {
    // Clamp whatever rand returns into [0, 1) so every range below holds.
    const unit = () => {
        const value = Number(rand());
        return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1 - Number.EPSILON) : 0;
    };
    const between = (min, max) => min + Math.floor(unit() * (max - min + 1));
    const points = Array.from(String(text ?? ''));
    const plan = [];
    let untilLong = between(8, 15);
    for (let i = 0; i < points.length;) {
        const size = Math.min(between(1, 4), points.length - i);
        const chunk = points.slice(i, i + size).join('');
        i += size;
        untilLong -= size;
        let delayMs;
        if (untilLong <= 0) {
            delayMs = between(300, 900);
            untilLong = between(8, 15);
        } else {
            delayMs = between(60, 220);
        }
        plan.push({ chunk, delayMs });
    }
    return plan;
}

/** `@` / `#` open 小红书's mention / topic pickers as they are typed: such texts keep the one-shot fill. */
function needsExactFill(text) {
    return /[@#]/.test(String(text ?? ''));
}

/**
 * Step 3 the way a person does it: a pause before touching the box (reading the note), the text in
 * planTypingChunks bursts through CDP `Input.insertText` — the primitive `page.fillText` itself
 * uses, just not all at once — then a pause before Enter.
 *
 * Focus: nothing in the main flow clicks or focuses the box beforehand (activateEditor only runs in
 * the button fallback since 9-06; the one-shot fill got focus from fillText's own CDP DOM.focus),
 * so this takes it: the existing clear when a draft is showing, `page.focus`, then everything in
 * the box selected so the first burst also overwrites what innerText cannot show (emoji images).
 *
 * Held to fillCommentExactly's read-back. A text with @ / #, no CDP, no box, too little time before
 * `deadline`, a failed burst or a read-back that does not match all end in fillCommentExactly — the
 * box then holds exactly `text` or this throws, as before. Nothing here can send: only a keyCode-13
 * keydown submits, and Input.insertText dispatches no key events.
 * `deadline` = the latest moment the send may start (sendDeadline); the pacing never eats into it.
 */
async function typeCommentLikeHuman(page, target, text, { deadline = Infinity, editor = null } = {}) {
    // Notice replies use a textarea; share pacing and fallback policy, not note-page selectors.
    const readUi = editor?.readUi ?? readCommentUi;
    const clearInput = editor?.clearInput ?? clearCommentInput;
    const exact = value => String(value ?? '').replace(/\r\n?/g, '\n').trim();
    const matches = editor?.matches ?? ((actual, expected) => exact(actual) === exact(expected));
    const pauseMs = ([min, max]) => Math.round(min + Math.random() * (max - min));
    const readMs = pauseMs(READ_PAUSE_MS);
    const reviewMs = pauseMs(REVIEW_PAUSE_MS);
    const oneShot = needsExactFill(text) ? '含 @ / #'
        : typeof page.cdp !== 'function' ? '没有 CDP'
            : !target ? '没找到输入框' : '';
    const plan = oneShot ? [] : planTypingChunks(text);
    const typingMs = plan.reduce((sum, step, i) => sum + TYPE_BURST_RPC_MS + (i < plan.length - 1 ? step.delayMs : 0), 0);
    if (Date.now() + readMs + typingMs + reviewMs + TYPE_TAIL_MS > deadline) {
        // Too close to the send deadline for any pacing: the old one-shot fill, no pauses.
        const state = editor ? await editor.fillExactly(page, text) : await fillCommentExactly(page, text);
        return { ...state, typed: false, note: '离发送时限太近，一次填入' };
    }
    await sleep(readMs);

    let state = null;
    let why = oneShot;
    if (!oneShot) {
        try {
            if (!(await readUi(page, '')).inputCleared) await clearInput(page);
            if (typeof page.focus === 'function') await page.focus(target.selector, { nth: target.nth });
            const ready = await page.evaluateWithArgs(`
              (() => {
                const el = document.querySelectorAll(selector)[nth];
                if (!el) return { ok: false, reason: 'missing' };
                if (el.tagName === 'TEXTAREA') {
                  el.focus({ preventScroll: true });
                  if (document.activeElement !== el || el.disabled || el.readOnly) return { ok: false, reason: 'not_focused' };
                  el.setSelectionRange(0, el.value.length);
                  return { ok: true };
                }
                let host = el;
                while (host && !(host.hasAttribute && host.hasAttribute('contenteditable'))) host = host.parentElement;
                host = host || (el.isContentEditable ? el : null);
                if (!host) return { ok: false, reason: 'not_editable' };
                const inside = () => document.activeElement === host || host.contains(document.activeElement);
                if (!inside()) { try { host.focus({ preventScroll: true }); } catch { host.focus(); } }
                if (!inside()) return { ok: false, reason: 'not_focused' };
                const selection = window.getSelection();
                if (!selection) return { ok: false, reason: 'no_selection' };
                const range = document.createRange();
                range.selectNodeContents(host);
                selection.removeAllRanges();
                selection.addRange(range);
                return { ok: true };
              })()
            `, { selector: target.selector, nth: target.nth });
            if (ready?.ok !== true) throw new Error(`输入框没拿到焦点（${ready?.reason ?? '无返回'}）`);
            for (let i = 0; i < plan.length; i++) {
                if (Date.now() + TYPE_TAIL_MS > deadline) {
                    why = `打到第 ${i + 1}/${plan.length} 段时离发送时限太近`;
                    break;
                }
                await page.cdp('Input.insertText', { text: plan[i].chunk });
                if (i < plan.length - 1) await sleep(plan[i].delayMs);
            }
            if (!why) {
                const after = await readUi(page, text);
                if (after.inputFound !== false && matches(after.inputText, text)) state = after;
                else why = `打完框里是「${preview(after.inputText, 20)}」`;
            }
        } catch (error) {
            why = `出错：${preview(String(error?.message ?? error), 60)}`;
        }
    }
    const typed = Boolean(state);
    // The old path, unchanged: exact replace plus its own re-check; throws if the box will not match.
    if (!state) state = editor ? await editor.fillExactly(page, text) : await fillCommentExactly(page, text);
    if (Date.now() + reviewMs + TYPE_TAIL_MS <= deadline) await sleep(reviewMs);
    const note = typed
        ? `逐段打字（${plan.length} 段）`
        : (oneShot ? `${why}，一次填入` : `逐段打字没成（${why}），改一次填入`);
    return { ...state, typed, note };
}

/**
 * Own fetch/XHR capture — the built-in interceptor keeps response bodies only, and
 * 小红书 hides its 风控 rejection in the HTTP status (461) behind a success-shaped body.
 */
async function installCommentCapture(page) {
    const result = await page.evaluateWithArgs(`
      (() => {
        const hide = (key, value) => {
          try { Object.defineProperty(window, key, { value, writable: true, enumerable: false, configurable: true }); }
          catch { window[key] = value; }
        };
        // 判断函数每轮都换上这一版（装过钩子也换），钩子每个请求现取：以后改了 replyGuardVerdict，常驻页不用等刷新。
        hide('__xhsReplyGuard', (${replyGuardVerdict.toString()}));
        // 常驻页不刷新：发送前清掉已经到了的回执；还在路上、晚到的回执靠请求发出时绑的轮次编号挡（readCommentCaptures）。
        hide('__xhsCommentCaptures', []);
        const installed = window.__xhsCommentCaptureInstalled;
        // 这一版已经装过：只装一次、不套两层。它每个请求现读 __xhsReplyGuard 和 __xhsReplyExpectedTarget，读到的是这一轮的设置。
        if (installed === version) return { installed: true, reused: true, version };
        // 没装过，或装的是旧版（true / 别的版本号）：不刷新页面，在现有的 fetch / XHR 外面再包一层这一版。外层先判、先记：
        // 被拦的请求停在外层，旧层见不到；放行的请求旧层照旧记它那份（没有轮次编号和版本号），读回执时一律不认，不会重复计数。
        const record = (entry) => { try { window.__xhsCommentCaptures.push({ ...entry, v: version }); } catch {} };
        // Reply guard, decided per request: window.__xhsReplyExpectedTarget unset = top-level comment
        // (blocked only when it carries a reply target); set = only a request answering exactly that
        // comment may leave. Verdict = window.__xhsReplyGuard (this round's), the install-time copy if missing.
        const installedGuard = (${replyGuardVerdict.toString()});
        const verdictFor = (body) => (typeof window.__xhsReplyGuard === 'function' ? window.__xhsReplyGuard : installedGuard)(body, window.__xhsReplyExpectedTarget || null);
        // 请求发出那一刻的轮次编号（resetCommentRound 每轮开头设）：响应哪怕晚到下一轮，回执也只归它自己那一轮。
        const roundNow = () => window.__xhsCommentRound || null;
        const innerFetch = window.fetch;
        window.fetch = async function (...args) {
          const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
          if (!url.includes(pattern)) return innerFetch.apply(this, args);
          const round = roundNow();
          const verdict = verdictFor(args[1] && args[1].body);
          if (verdict.block) {
            record({ round, blocked: true, verdict });
            throw new TypeError('xhs reply guard: comment request blocked');
          }
          let response;
          try {
            response = await innerFetch.apply(this, args);
          } catch (error) {
            // 里层（旧版钩子）拦下的也记成这一轮「拦下了」，不能只让旧层记到；网络错误照旧不记（结果不明，不重发）。
            if (/xhs reply guard/.test(String(error && error.message))) {
              record({ round, blocked: true, verdict: { block: true, target: verdict.target, reason: 'inner_guard' } });
            }
            throw error;
          }
          try { record({ round, status: response.status, body: await response.clone().json(), requestTarget: verdict.target }); }
          catch (error) { record({ round, status: response.status, body: null, parseError: String(error), requestTarget: verdict.target }); }
          return response;
        };

        const proto = XMLHttpRequest.prototype;
        const innerOpen = proto.open;
        const innerSend = proto.send;
        proto.open = function (method, url) {
          try { this.__xhsCaptureUrl = String(url); } catch {}
          return innerOpen.apply(this, arguments);
        };
        proto.send = function (body) {
          if (this.__xhsCaptureUrl && this.__xhsCaptureUrl.includes(pattern)) {
            const round = roundNow();
            const verdict = verdictFor(body);
            if (verdict.block) {
              record({ round, blocked: true, verdict });
              return undefined;
            }
            this.addEventListener('load', function () {
              let parsed = null;
              try { parsed = JSON.parse(this.responseText); } catch {}
              record({ round, status: this.status, body: parsed, requestTarget: verdict.target });
            });
          }
          return innerSend.apply(this, arguments);
        };

        hide('__xhsCommentCaptureInstalled', version);
        return { installed: true, reused: false, version, upgradedFrom: installed === undefined ? null : String(installed) };
      })()
    `, { pattern: COMMENT_POST_API, version: COMMENT_HOOK_VERSION });
    return result?.installed === true;
}

async function readCommentCaptures(page) {
    const captures = await page.evaluateWithArgs(`
      (() => {
        const data = window.__xhsCommentCaptures || [];
        window.__xhsCommentCaptures = [];
        // 只认这一版钩子记的、请求发出时绑的是这一轮编号的回执：上一轮迟到的（成功的、失败的都一样）和旧版钩子记的
        // （没有轮次编号 / 版本号）一律不认。这一轮还没有编号（没清过场）就一条都不认。
        const round = window.__xhsCommentRound || null;
        return round ? data.filter(entry => entry && entry.round === round && entry.v === version) : [];
      })()
    `, { version: COMMENT_HOOK_VERSION });
    return Array.isArray(captures) ? captures : [];
}

function classifyCapture(entry) {
    if (!entry || typeof entry !== 'object') return null;
    // 发送那一刻被钩子拦下的（顶层评论带着回复对象 = unexpected_target）：没发出去，这轮就是失败。
    if (entry.blocked) {
        const verdict = entry.verdict || {};
        const why = verdict.reason === 'unexpected_target'
            ? `顶层评论带着回复对象（${verdict.target || '?'}）`
            : `发送防护拦下（${verdict.reason || '原因不明'}）`;
        return { ok: false, blocked: true, message: `拦下了、没发：${why}` };
    }
    const status = Number(entry.status);
    const body = entry.body && typeof entry.body === 'object' ? entry.body : null;
    const message = String(body?.msg ?? body?.message ?? '').trim();
    const rawCode = body?.code ?? body?.error_code;
    const code = rawCode === undefined || rawCode === null || rawCode === '' ? null : Number(rawCode);

    // 461 is 小红书's "scan to verify" gate, and its body still claims success.
    if (status === 461 || /验证/.test(message)) {
        return { ok: false, verification: true, message: message || `HTTP ${status} · 账号需要扫码验证` };
    }
    if (Number.isFinite(status) && (status < 200 || status >= 300)) {
        return { ok: false, message: message || `HTTP ${status}` };
    }
    if (body?.success === false || (code !== null && Number.isFinite(code) && code !== 0)) {
        return { ok: false, message: message || `接口返回错误码 ${rawCode}` };
    }
    if (body?.data?.comment ?? body?.data?.comment_id ?? body?.data?.id ?? null) {
        return { ok: true, message: message || '服务器已确认' };
    }
    // 2xx + success:true but an empty data object proves nothing — let the UI decide.
    return null;
}

/** classifyCapture plus the reply checks: a blocked send, and which comment the server says it answered. */
function classifyReplyCapture(entry, expectedTarget) {
    if (entry?.blocked) {
        const verdict = entry.verdict || {};
        const got = verdict.target
            ? `回的是 ${verdict.target}`
            : (verdict.reason === 'unreadable_body' ? '请求内容读不出来' : '请求里没有回复对象');
        const keys = Array.isArray(verdict.keys) && verdict.keys.length ? `（请求字段：${verdict.keys.join(', ')}）` : '';
        return { ok: false, blocked: true, message: `发送那一刻拦下了：${got}，不是 ${expectedTarget}${keys}` };
    }
    const base = classifyCapture(entry);
    if (!base || base.ok !== true) return base;
    const comment = entry.body?.data?.comment && typeof entry.body.data.comment === 'object' ? entry.body.data.comment : null;
    const responseTarget = comment?.target_comment?.id ?? null;
    if (responseTarget && String(responseTarget) !== String(expectedTarget)) {
        return { ok: false, mismatch: true, message: `服务器回执说回的是 ${responseTarget}，不是 ${expectedTarget}` };
    }
    return { ...base, newCommentId: comment?.id ?? null, responseTarget, requestTarget: entry.requestTarget ?? null };
}

/**
 * 附加核对（轮次编号已在页内筛过，readCommentCaptures）：回执里带着评论正文就得是这一轮的正文（空白不算），回复这一轮，
 * 这条请求回的得是这一轮的目标。对不上的不认——只是不拿它定结果，不当失败。被拦下的条目没发出去，拦它的就是这一轮的钩子，照认。
 */
function receiptFitsRound(entry, text, expectedTarget) {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.blocked) return true;
    const squash = (value) => String(value ?? '').replace(/\s+/g, '');
    const content = entry.body?.data?.comment?.content;
    if (typeof content === 'string' && content.trim() && squash(content) !== squash(text)) return false;
    if (expectedTarget && String(entry.requestTarget ?? '') !== String(expectedTarget)) return false;
    return true;
}

async function waitForSubmitOutcome(page, text, captureReady, { readUi = readCommentUi, expectedTarget = null } = {}) {
    const deadline = Date.now() + SUBMIT_WAIT_MS;
    let lastUi = await readUi(page, text);
    while (Date.now() < deadline) {
        await page.wait({ time: SUBMIT_POLL_MS / 1_000 });

        let apiOutcome = null;
        if (captureReady) {
            for (const entry of await readCommentCaptures(page)) {
                if (!receiptFitsRound(entry, text, expectedTarget)) continue;
                const classified = expectedTarget ? classifyReplyCapture(entry, expectedTarget) : classifyCapture(entry);
                if (classified) apiOutcome = classified;
            }
        }
        lastUi = await readUi(page, text);

        if (apiOutcome?.verification) {
            return { ok: false, verification: true, reason: apiOutcome.message, ui: lastUi, source: 'api' };
        }
        if (apiOutcome?.ok === false) {
            return {
                ok: false,
                blocked: Boolean(apiOutcome.blocked),
                mismatch: Boolean(apiOutcome.mismatch),
                reason: apiOutcome.message,
                ui: lastUi,
                source: apiOutcome.blocked ? 'guard' : 'api',
            };
        }
        if (apiOutcome?.ok === true) {
            return {
                ok: true,
                reason: apiOutcome.message,
                ui: lastUi,
                source: 'api',
                newCommentId: apiOutcome.newCommentId ?? null,
                responseTarget: apiOutcome.responseTarget ?? null,
                requestTarget: apiOutcome.requestTarget ?? null,
            };
        }
        const gate = await detectVerificationGate(page);
        if (gate.present) {
            return { ok: false, verification: true, reason: gate.text || '弹出扫码验证', ui: lastUi, source: 'ui' };
        }
        if (lastUi.blockedText) {
            return { ok: false, reason: lastUi.blockedText, ui: lastUi, source: 'ui' };
        }
        if (lastUi.matched || lastUi.successText) {
            return { ok: true, reason: lastUi.successText || '已在评论列表显示', ui: lastUi, source: 'ui' };
        }
    }
    if (lastUi.matched) {
        return { ok: true, reason: '已在评论列表显示', ui: lastUi, source: 'ui' };
    }
    if (lastUi.inputCleared) {
        return { ok: true, reason: '输入框已清空（未捕获服务器回执）', ui: lastUi, source: 'ui' };
    }
    return { ok: null, reason: '未捕获成功或失败回执', ui: lastUi, source: 'timeout' };
}

/**
 * Capture-phase keydown probe on the input. Records what keyCode the page actually saw.
 * With `block: true` it also swallows the event before 小红书's own handler runs — that
 * is the dry-run mode: prove delivery without submitting anything.
 */
async function installEnterProbe(page, target, { block = false } = {}) {
    const result = await page.evaluateWithArgs(`
      (() => {
        const el = document.querySelectorAll(selector)[nth];
        if (!el) return { installed: false };
        if (el.__xhsEnterProbe) el.removeEventListener('keydown', el.__xhsEnterProbe, true);
        window.__xhsEnterProbeHits = [];
        const probe = (event) => {
          try { window.__xhsEnterProbeHits.push({ keyCode: event.keyCode, trusted: event.isTrusted }); } catch {}
          if (block) { event.stopImmediatePropagation(); event.preventDefault(); }
        };
        el.addEventListener('keydown', probe, true);
        el.__xhsEnterProbe = probe;
        return { installed: true };
      })()
    `, { selector: target.selector, nth: target.nth, block });
    return result?.installed === true;
}

async function removeEnterProbe(page, target) {
    try {
        await page.evaluateWithArgs(`
          (() => {
            const el = document.querySelectorAll(selector)[nth];
            if (el && el.__xhsEnterProbe) {
              el.removeEventListener('keydown', el.__xhsEnterProbe, true);
              delete el.__xhsEnterProbe;
            }
            return true;
          })()
        `, { selector: target.selector, nth: target.nth });
    } catch {}
}

async function readEnterProbe(page) {
    let hits;
    try {
        hits = await page.evaluate('(() => window.__xhsEnterProbeHits)()');
    } catch {
        return { landed: null, trusted: false, events: [] };
    }
    if (!Array.isArray(hits)) return { landed: null, trusted: false, events: [] };
    const events = hits;
    return {
        landed: events.some(event => Number(event.keyCode) === 13),
        trusted: events.some(event => Number(event.keyCode) === 13 && event.trusted === true),
        events,
    };
}

/**
 * Focus the input and press Enter. Prefers a real CDP key event (trusted, keyCode 13);
 * if the page did not see keyCode 13, dispatches a synthetic KeyboardEvent instead.
 * Never sends both when the first one landed, so a comment cannot go out twice.
 * Caller must have installed the probe first.
 */
async function dispatchEnter(page, target, { deadline = Infinity } = {}) {
    if (typeof page.focus === 'function') {
        const focused = await page.focus(target.selector, { nth: target.nth });
        if (!focused?.focused) throw new Error('Could not focus comment input before pressing Enter.');
    }
    let mode = 'cdp';
    if (Date.now() >= deadline) return { landed: false, trusted: false, mode: 'expired', events: [], expired: true };
    if (typeof page.cdp === 'function') {
        try {
            await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER_KEY_EVENT });
            await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER_KEY_EVENT });
        } catch {} // The RPC may fail after keyDown has reached the page; read the probe first.
    } else {
        mode = 'synthetic';
    }
    let probe = await readEnterProbe(page);
    if (mode === 'cdp' && probe.landed === false) mode = 'synthetic';
    if (mode === 'synthetic' && probe.landed === false) {
        if (Date.now() >= deadline) return { ...probe, mode: 'expired', expired: true };
        try {
            await page.evaluateWithArgs(`
          (() => {
            const el = document.querySelectorAll(selector)[nth];
            if (!el) return false;
            const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
            el.dispatchEvent(new KeyboardEvent('keydown', init));
            el.dispatchEvent(new KeyboardEvent('keyup', init));
            return true;
          })()
            `, { selector: target.selector, nth: target.nth });
        } catch {} // Likewise, an evaluate error cannot prove the synthetic event was lost.
        probe = await readEnterProbe(page);
    }
    return { ...probe, mode };
}

/**
 * Click and prove it landed. opencli reports `clicked: true` as soon as the CDP call
 * returns, even when the coordinates hit a different node, so the button itself has to
 * confirm receipt.
 */
async function clickAndConfirm(page, target, { deadline = Infinity } = {}) {
    await page.evaluateWithArgs(`
      (() => {
        const el = document.querySelectorAll(selector)[nth];
        if (!el) return { installed: false };
        if (!el.__xhsClickProbeInstalled) {
          const record = (event) => {
            try { window.__xhsClickProbe.push({ type: event.type, trusted: event.isTrusted }); } catch {}
          };
          ['mousedown', 'click'].forEach(type => el.addEventListener(type, record, true));
          el.__xhsClickProbeInstalled = true;
        }
        window.__xhsClickProbe = [];
        return { installed: true };
      })()
    `, { selector: target.selector, nth: target.nth });

    if (Date.now() >= deadline) return { landed: false, trusted: false, events: [], expired: true };
    await page.click(target.selector, { nth: target.nth });

    const hits = await page.evaluate('(() => window.__xhsClickProbe || [])()');
    const events = Array.isArray(hits) ? hits : [];
    return {
        landed: events.some(event => event.type === 'click'),
        trusted: events.some(event => event.type === 'click' && event.trusted === true),
        events,
    };
}

/**
 * Dry-run tail: clear the text, prove Enter reaches the input without sending, close the editor.
 * Returns a note on the Enter probe.
 */
async function finishDryRun(page) {
    await page.screenshot({ path: '/tmp/xhs_comment_dryrun.png' });
    // Clear through real key events before closing the editor so XHS cannot
    // preserve the probe as a draft for the next comment command.
    await clearCommentInput(page);
    // Enter delivery probe on the now-empty input. The blocking capture listener
    // swallows the keydown before 小红书's handler sees it, so nothing is sent.
    let enterNote = '回车探针未跑（输入框不见了）';
    const probeTarget = await locateVisibleTarget(page, INPUT_SELECTORS);
    if (probeTarget && await installEnterProbe(page, probeTarget, { block: true })) {
        try {
            const enter = await dispatchEnter(page, probeTarget);
            enterNote = enter.landed
                ? `回车键码 13 已送达（${enter.mode}${enter.trusted ? '' : '·非真实按键'}）`
                : `回车键码未送达（${enter.mode}，页面看到 ${JSON.stringify(enter.events)}）`;
        } finally {
            await removeEnterProbe(page, probeTarget);
        }
    }
    const cancel = await locateVisibleTarget(page, CANCEL_SELECTORS, { text: '取消', enabled: true });
    if (cancel) {
        const reach = await hitTest(page, cancel);
        if (reach?.hit) await page.click(cancel.selector, { nth: cancel.nth });
    }
    return enterNote;
}

async function armReplyGuard(page, expectedTarget) {
    await page.evaluateWithArgs(`
      (() => {
        try { Object.defineProperty(window, '__xhsReplyExpectedTarget', { value: expected, writable: true, enumerable: false, configurable: true }); }
        catch { window.__xhsReplyExpectedTarget = expected; }
        return true;
      })()
    `, { expected: expectedTarget });
}

/**
 * 每轮开头、打字之前调（顶层评论 expectedTarget 不传，回复传这轮要回的评论 ID）。常驻页在命令之间不刷新，上一轮留在
 * 页面里的两样这轮必须清掉：回复防护读的 __xhsReplyExpectedTarget——顶层评论这轮必须是没设（不清的话上一轮的回复对象会把
 * 这条顶层评论拦下），回复这轮一开头就设成这轮的目标（发送前 armReplyGuard 再设一次同样的值）；没被取走的回执
 * __xhsCommentCaptures——清空，不然会被这轮读成自己的。装好的钩子不动（installCommentCapture 每张页只装一次）。
 * 读回来不是这轮该有的样子就抛错：这时还什么都没打、没发。
 */
async function resetCommentRound(page, expectedTarget = null) {
    const want = expectedTarget || null;
    // 这一轮的编号：钩子在请求发出那一刻把它记进这条请求，读回执只认它（readCommentCaptures），上一轮晚到的回执就进不来。
    const round = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const state = await page.evaluateWithArgs(`
      (() => {
        // 页面里就是 window（钩子读的也是它）；没有 window 的只有测试沙箱（notice-typing 测试），退回当前全局对象。
        const root = typeof window !== 'undefined' ? window : globalThis;
        const hide = (key, value) => {
          try { Object.defineProperty(root, key, { value, writable: true, enumerable: false, configurable: true }); }
          catch { root[key] = value; }
        };
        hide('__xhsCommentCaptures', []);
        hide('__xhsCommentRound', round);
        if (expected) {
          hide('__xhsReplyExpectedTarget', expected);
        } else {
          try { delete root.__xhsReplyExpectedTarget; } catch {}
          if (root.__xhsReplyExpectedTarget) hide('__xhsReplyExpectedTarget', null);
        }
        return {
          target: root.__xhsReplyExpectedTarget || null,
          captures: Array.isArray(root.__xhsCommentCaptures) ? root.__xhsCommentCaptures.length : null,
          round: root.__xhsCommentRound || null,
        };
      })()
    `, { expected: want, round });
    if (!state || state.target !== want || state.captures !== 0 || state.round !== round) {
        throw new Error(`没清掉上一轮留在页面里的回复对象 / 回执（读回 ${JSON.stringify(state)}），没打字、没发送`);
    }
}

/**
 * 在常驻页里页内打开要评论的帖子（resident-helpers.js 的 openNoteInPage：回干净首页 → 路由跳 → 核对 currentNoteId 和内容 →
 * 清场再跳一次 → 还不成才整页打开、经手机出口），打开后往 stderr 报这轮常驻页的情况（reportResident）。target 是
 * { noteId, xsecToken, xsecSource }。没打开（ok:false）时页面停在哪不确定，绝不在上面打字或点发送：先跑原来的访问检查
 * （inspectNoteAccess，和 waitForCommentInput 一样），安全限制 / 要登录照原来那样报错，检查不出就报「帖子没打开」带上原因。
 */
async function openNoteForComment(page, target) {
    const opened = await openNoteInPage(page, target);
    await reportResident(page, opened.resident);
    if (opened.ok) return opened;
    let access = null;
    try {
        access = await page.evaluate(`(${inspectNoteAccess.toString()})()`);
    } catch {
        access = null;
    }
    if (access?.securityBlock) {
        throw new CliError('SECURITY_BLOCK', 'Xiaohongshu security block on the note detail page.', 'The page may be temporarily restricted. Try a different note URL or retry later.');
    }
    if (access?.loginWall) {
        throw new AuthRequiredError('www.xiaohongshu.com', 'Posting comments requires login');
    }
    throw new CliError('NOTE_NOT_OPENED',
        `帖子没打开（${opened.reason ?? '原因不明'}${access?.notFound ? ' · 页面像是笔记不存在' : ''}），没打字、没发送`,
        '常驻页页内两次、整页一次都没核对上这条帖子；先只读看一眼帖子还在不在、链接里的 xsec_token 是不是过期了，再重跑');
}

/**
 * Steps 4–6: press Enter and prove keyCode 13 landed, prefer the real POST status, fall back to
 * the 发送 button only when nothing can have left the box. `expectedTarget` arms the reply
 * guard; `beforeButtonFallback` may veto the fallback click by returning a reason.
 */
async function submitWithEnter(page, text, inputTarget, { expectedTarget = null, beforeButtonFallback = null, deadline = Infinity } = {}) {
    const expired = () => ({
        outcome: { ok: false, reason: '离发送时限太近，未发送', ui: { inputText: text, inputCleared: false }, source: 'deadline' },
        pathNote: '发送时限已到',
    });
    // ── Step 4: Press Enter, and prove the input received keyCode 13 ──────────
    if (expectedTarget) await armReplyGuard(page, expectedTarget);
    const captureReady = await installCommentCapture(page);
    const waitOptions = expectedTarget ? { expectedTarget } : {};
    let enter = { landed: false, trusted: false, mode: 'none', events: [] };
    if (await installEnterProbe(page, inputTarget)) {
        try {
            enter = await dispatchEnter(page, inputTarget, { deadline });
        } finally {
            await removeEnterProbe(page, inputTarget);
        }
    }
    if (enter.expired) return expired();

    // ── Step 5: Prefer the real POST status; use UI state as fallback ─────────
    const unknownOutcome = {
        ok: null, reason: '提交结果不明，先只读核验，勿重发',
        ui: { inputText: null, inputCleared: false }, source: 'unknown',
    };
    // Callers read outcome.ok and outcome.ui directly, including on unreadable probes/receipts.
    const readOutcome = async () => {
        try {
            return await waitForSubmitOutcome(page, text, captureReady, waitOptions) || unknownOutcome;
        } catch (error) {
            return { ...unknownOutcome, reason: `提交后读取回执失败：${error.message}；先只读核验，勿重发` };
        }
    };
    let outcome = unknownOutcome;
    let pathNote = `回车发送（${enter.mode}${enter.trusted ? '' : '·非真实按键'}）`;
    if (enter.landed !== false) {
        if (enter.landed === null) pathNote += ' · 回车送达探针不明，未补发';
        outcome = await readOutcome();
    }

    // ── Step 6: Button fallback — only when nothing can have left the box ─────
    //    An unknown receipt or unreadable probe cannot prove the first POST did not leave.
    //    Only a readable negative probe (or no event attempted) permits another submission.
    if (enter.landed === false) {
        if (Date.now() >= deadline) return expired();
        const why = `回车键码未送达（${enter.mode}）`;
        const veto = beforeButtonFallback ? await beforeButtonFallback() : null;
        if (veto) {
            await clearCommentInput(page).catch(() => {});
            return {
                outcome: { ok: false, reason: `${why}；${veto}；已清空，未发送`, ui: await readCommentUi(page, text), source: 'guard' },
                pathNote: `按钮兜底已取消（${why}）`,
            };
        }
        pathNote = `按钮兜底（${why}）`;
        try {
            await activateEditor(page);
        } catch (error) {
            throw new Error(`${why}；按钮兜底也失败：${error.message}`);
        }
        const submit = await locateVisibleTarget(page, SUBMIT_SELECTORS, { text: '发送', enabled: true });
        if (!submit) {
            await page.screenshot({ path: '/tmp/xhs_comment_submit_debug.png' });
            throw new Error(`${why}；按钮兜底也失败：找不到可用的发送按钮。` +
                '截图: /tmp/xhs_comment_submit_debug.png');
        }
        let reach = await hitTest(page, submit);
        if (!reach?.hit) reach = await hitTest(page, submit, { scrollIntoView: true });
        if (!reach?.hit) {
            await page.screenshot({ path: '/tmp/xhs_comment_blocked_debug.png' });
            throw new Error(`${why}；按钮兜底也失败：发送按钮不可点击，该坐标上的元素是 ` +
                `${reach?.blockedBy ?? '未知'}（按钮 ${reach?.rect?.y}–${reach?.rect?.bottom}, 视口高 ${reach?.viewport?.h}）。` +
                '截图: /tmp/xhs_comment_blocked_debug.png');
        }
        const click = await clickAndConfirm(page, submit, { deadline });
        if (click.expired) return expired();
        if (!click.landed) {
            await page.screenshot({ path: '/tmp/xhs_comment_click_lost_debug.png' });
            throw new Error(`${why}；按钮兜底也失败：点击没有落到发送按钮上，评论未发送。` +
                '截图: /tmp/xhs_comment_click_lost_debug.png');
        }
        if (!click.trusted) pathNote += ' · ⚠️ 点击非真实鼠标事件';
        outcome = await readOutcome();
    }
    return { outcome, pathNote };
}

// ── Reply mode ─────────────────────────────────────────────────────────────────

function submitTimeLeft(ctx) {
    return Date.now() - ctx.startedAt < (ctx.timeoutS - SUBMIT_MARGIN_S) * 1_000;
}

/** The latest moment a send may start: the instant submitTimeLeft(ctx) turns false. */
function sendDeadline(ctx) {
    return ctx.startedAt + (ctx.timeoutS - SUBMIT_MARGIN_S) * 1_000;
}

function timeUpRow(ctx) {
    return {
        status: '⚠️ 回复未发布',
        detail: `找评论用掉了 ${Math.round((Date.now() - ctx.startedAt) / 1_000)}s，离超时（${ctx.timeoutS}s）不到 ${SUBMIT_MARGIN_S}s，没敢发 · 未发送`,
    };
}

/** pinia `note.commentTarget`: the comment the bottom editor is replying to ({} when none). */
async function readCommentTarget(page) {
    const result = await page.evaluate(`
      (() => {
        try {
          const target = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.note.commentTarget;
          if (!target || !target.id) return { id: null };
          return {
            id: String(target.id),
            nickname: String((target.userInfo && target.userInfo.nickname) || ''),
            content: String(target.content || '').slice(0, 120),
          };
        } catch (error) {
          return { id: null, error: String(error) };
        }
      })()
    `);
    return result && typeof result === 'object' ? result : { id: null };
}

async function waitForCommentTarget(page, commentId) {
    const deadline = Date.now() + REPLY_ARM_WAIT_MS;
    let last = { id: null };
    while (Date.now() < deadline) {
        last = await readCommentTarget(page);
        if (last.id === commentId) return { ok: true, ...last };
        await page.wait({ time: REPLY_ARM_POLL_MS / 1_000 });
    }
    return { ok: false, ...last };
}

/** Leave note-page reply mode (取消 resets commentTarget to {}). Best effort. */
async function cancelNoteReply(page) {
    try {
        const cancel = await locateVisibleTarget(page, CANCEL_SELECTORS, { text: '取消', enabled: true });
        if (!cancel) return false;
        const reach = await hitTest(page, cancel, { scrollIntoView: true });
        if (reach?.hit) await page.click(cancel.selector, { nth: cancel.nth });
        return Boolean(reach?.hit);
    } catch {
        return false;
    }
}

/** A real mouse-wheel tick over a scroll container — lazy loaders listen for these. */
async function wheelOver(page, point, deltaY) {
    if (!point || typeof page.cdp !== 'function') return false;
    try {
        await page.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY });
        return true;
    } catch {
        return false;
    }
}

// One search step on the note page: found? → open up to `maxExpand` collapsed reply threads →
// at the end? → otherwise scroll to pull the next batch of top-level comments.
const NOTE_SEARCH_STEP_JS = `
  (() => {
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const scope = document.querySelector('#noteContainer') || document;
    const parents = scope.querySelectorAll('.parent-comment').length;
    const total = clean((scope.querySelector('.comments-container .total') || {}).textContent);
    const target = document.getElementById('comment-' + commentId);
    if (target) {
      target.scrollIntoView({ behavior: 'instant', block: 'center' });
      return { found: true, parents, total, isSub: target.classList.contains('comment-item-sub') };
    }
    const threadOpener = new RegExp(expandRe);
    const openers = Array.from(scope.querySelectorAll('.comments-container .show-more'))
      .filter(node => threadOpener.test(clean(node.textContent)))
      .slice(0, maxExpand);
    openers.forEach(node => node.click());
    if (openers.length) return { found: false, parents, total, expanded: openers.length };
    const end = scope.querySelector('.end-container');
    const atEnd = !!end && /THE\\s*END/i.test(end.textContent || '');
    const scroller = scope.querySelector('.note-scroller');
    const items = scope.querySelectorAll('.comments-container .comment-item');
    const last = items[items.length - 1];
    if (last) last.scrollIntoView({ block: 'end' });
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    const rect = scroller ? scroller.getBoundingClientRect() : null;
    const scrollPoint = rect && rect.width > 0 && rect.height > 0
      ? { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
      : null;
    return { found: false, parents, total, expanded: 0, atEnd, scrollPoint };
  })()
`;

/**
 * Find `#comment-<id>` on the note page: look, open collapsed reply threads, pull the next batch
 * of top-level comments — until found, the list ends, nothing grows, or the budget runs out.
 */
async function locateCommentOnNote(page, commentId) {
    const startedAt = Date.now();
    const tally = { rounds: 0, expanded: 0, scrolls: 0, parents: 0, total: '', atEnd: false };
    let stall = 0;
    let bestParents = -1;
    while (tally.rounds < NOTE_SEARCH_MAX_ROUNDS && Date.now() - startedAt < NOTE_SEARCH_MAX_MS) {
        tally.rounds += 1;
        const step = await page.evaluateWithArgs(NOTE_SEARCH_STEP_JS, {
            commentId,
            expandRe: EXPAND_REPLIES_RE,
            maxExpand: NOTE_SEARCH_MAX_EXPAND,
        });
        tally.parents = step?.parents ?? tally.parents;
        tally.total = step?.total || tally.total;
        if (step?.found) return { found: true, isSub: Boolean(step.isSub), ...tally };
        if (step?.expanded) {
            tally.expanded += step.expanded;
            stall = 0;
            await page.wait({ time: 0.8 + Math.random() * 0.6 });
            continue;
        }
        tally.atEnd = Boolean(step?.atEnd);
        if (tally.atEnd) break;
        await wheelOver(page, step?.scrollPoint, 600 + Math.round(Math.random() * 400));
        tally.scrolls += 1;
        await page.wait({ time: 1 + Math.random() * 0.8 });
        if (tally.parents <= bestParents) {
            stall += 1;
            if (stall >= NOTE_SEARCH_STALL_ROUNDS) break;
        } else {
            stall = 0;
            bestParents = tally.parents;
        }
    }
    return { found: false, ...tally };
}

/** After a confirmed send: did the new reply render inside the target's thread? */
async function readbackOnNote(page, targetId, newId) {
    if (!newId) return 'no_id';
    const deadline = Date.now() + REPLY_READBACK_WAIT_MS;
    while (Date.now() < deadline) {
        const seen = await page.evaluateWithArgs(`
          (() => {
            const fresh = document.getElementById('comment-' + newId);
            if (!fresh) return { state: 'not_rendered' };
            const target = document.getElementById('comment-' + targetId);
            const thread = target ? (target.closest('.parent-comment') || target) : null;
            return { state: thread && thread.contains(fresh) ? 'in_thread' : 'elsewhere' };
          })()
        `, { targetId, newId: String(newId) });
        if (seen?.state === 'in_thread' || seen?.state === 'elsewhere') return seen.state;
        await page.wait({ time: 0.5 });
    }
    return 'not_rendered';
}

// Find the notice whose commentInfo.id is the target and mark its item. The store and the
// rendered list share an order, but the item's nickname + text must agree before it is trusted.
const NOTICE_FIND_JS = `
  (() => {
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const matches = (${noticeTextMatches.toString()});
    let state = null;
    try { state = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.notification; } catch {}
    if (!state) return { error: 'store_not_found', href: location.href };
    const tab = (state.notificationMap || {}).mentions || {};
    const list = Array.isArray(tab.messageList) ? tab.messageList : [];
    const base = { listLen: list.length, hasMore: Boolean(tab.hasMore) };
    const index = list.findIndex(entry => entry && entry.commentInfo && entry.commentInfo.id === commentId);
    if (index < 0) return { ...base, found: false };
    const entry = list[index];
    const want = {
      nickname: String((entry.userInfo && entry.userInfo.nickname) || ''),
      noteId: String((entry.itemInfo && entry.itemInfo.id) || ''),
      content: String((entry.commentInfo && entry.commentInfo.content) || ''),
      // 帖子页那条路用它在常驻页里页内打开（xsec_source=pc_notice，实测）。只拿来开页，不进任何输出。
      xsecToken: String((entry.itemInfo && entry.itemInfo.xsecToken) || ''),
    };
    document.querySelectorAll('[' + attr + ']').forEach(node => node.removeAttribute(attr));
    const items = Array.from(document.querySelectorAll(itemSelector));
    const fits = (node) => Boolean(node)
      && clean((node.querySelector('.user-info a') || {}).textContent) === clean(want.nickname)
      && matches(want.content, (node.querySelector('.interaction-content') || {}).textContent);
    let picked = fits(items[index]) ? items[index] : null;
    let how = picked ? 'index' : '';
    if (!picked) {
      const candidates = items.filter(fits);
      if (candidates.length !== 1) {
        return { ...base, found: true, index, domCount: items.length, marked: false, candidates: candidates.length, want };
      }
      picked = candidates[0];
      how = 'text';
    }
    picked.setAttribute(attr, '1');
    picked.scrollIntoView({ behavior: 'instant', block: 'center' });
    return { ...base, found: true, index, domCount: items.length, marked: true, how, want };
  })()
`;

const NOTICE_SCROLL_JS = `
  (() => {
    const items = document.querySelectorAll(itemSelector);
    const last = items[items.length - 1];
    if (last) last.scrollIntoView({ block: 'end' });
    window.scrollTo(0, document.documentElement.scrollHeight);
    return { count: items.length };
  })()
`;

// The marked notice's inline reply box, plus toasts. Only toast-like nodes count: on this page
// `[class*="message"]` would also match the notices themselves.
const NOTICE_BOX_JS = `
  (() => {
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const isVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const item = document.querySelector('[' + attr + '="1"]');
    const box = item ? item.querySelector('textarea.comment-input') : null;
    const toasts = Array.from(document.querySelectorAll('[role="alert"], [class*="toast"]'))
      .filter(isVisible).map(el => clean(el.innerText || el.textContent)).filter(text => text && text.length <= 240);
    return {
      itemFound: Boolean(item),
      open: Boolean(box) && isVisible(box),
      placeholder: box ? clean(box.getAttribute('placeholder')) : '',
      value: box ? String(box.value || '') : '',
      blockedText: toasts.find(text => /(评论失败|回复失败|发送失败|包含敏感|违规|发送过快|操作频繁|请求失败)/.test(text)) || '',
      successText: toasts.find(text => /(评论成功|回复成功|发送成功|发布成功)/.test(text)) || '',
    };
  })()
`;

async function readNoticeBox(page) {
    const box = await page.evaluateWithArgs(NOTICE_BOX_JS, { attr: NOTICE_TARGET_ATTR });
    return box && typeof box === 'object'
        ? box
        : { itemFound: false, open: false, placeholder: '', value: '', blockedText: '', successText: '' };
}

/** readCommentUi's shape for the notice route; `matched` stays false (no comment list here). */
async function readNoticeReplyUi(page) {
    const box = await readNoticeBox(page);
    return {
        inputFound: box.open,
        inputText: box.value,
        inputCleared: !box.open || normalizeText(box.value).length === 0,
        matched: false,
        blockedText: box.blockedText,
        successText: box.successText,
    };
}

async function waitForNoticeReplyBox(page, nickname) {
    const want = `回复${String(nickname || '').replace(/\s+/g, '')}`;
    const deadline = Date.now() + REPLY_ARM_WAIT_MS;
    let box = null;
    while (Date.now() < deadline) {
        box = await readNoticeBox(page);
        if (box.open) return { ok: box.placeholder.replace(/\s+/g, '') === want, placeholder: box.placeholder };
        await page.wait({ time: REPLY_ARM_POLL_MS / 1_000 });
    }
    return { ok: false, placeholder: box?.placeholder || '' };
}

async function fillNoticeReply(page, text) {
    // Textarea line endings normalize to LF; spaces and line breaks otherwise remain significant.
    const exact = value => String(value ?? '').replace(/\r\n?/g, '\n');
    const selector = `[${NOTICE_TARGET_ATTR}="1"] textarea.comment-input`;
    const fill = async () => {
        if (typeof page.fillText === 'function') return page.fillText(selector, text, { nth: 0 });
        await page.typeText(selector, text, { nth: 0 });
        return null;
    };
    await fill();
    let box = await readNoticeBox(page);
    if (!box.open || exact(box.value) !== exact(text)) {
        if (typeof page.focus === 'function') await page.focus(selector, { nth: 0 });
        await page.pressKey('Control+a');
        await page.pressKey('Backspace');
        await page.wait({ time: 0.15 });
        await fill();
        box = await readNoticeBox(page);
    }
    return { ok: box.open && exact(box.value) === exact(text), value: box.value };
}

async function typeNoticeReplyLikeHuman(page, text, { deadline = Infinity } = {}) {
    const exact = value => String(value ?? '').replace(/\r\n?/g, '\n');
    const state = await typeCommentLikeHuman(page, {
        selector: `[${NOTICE_TARGET_ATTR}="1"] textarea.comment-input`, nth: 0,
    }, text, {
        deadline,
        editor: {
            readUi: readNoticeReplyUi,
            // Selecting the entire textarea below replaces its stale draft with the first burst.
            clearInput: async () => {},
            matches: (actual, expected) => exact(actual) === exact(expected),
            fillExactly: async (page, text) => {
                const result = await fillNoticeReply(page, text);
                return { inputFound: result.ok, inputText: result.value };
            },
        },
    });
    return { ...state, ok: state.inputFound === true && exact(state.inputText) === exact(text), value: state.inputText };
}

/** Empty the inline box and fold it (取消). Best effort; reports what is left. */
async function closeNoticeReply(page) {
    const selector = `[${NOTICE_TARGET_ATTR}="1"] textarea.comment-input`;
    const cancel = { selector: `[${NOTICE_TARGET_ATTR}="1"] .action-cancel`, nth: 0 };
    try {
        if (typeof page.fillText === 'function') {
            await page.fillText(selector, '', { nth: 0 });
        } else if (typeof page.focus === 'function' && (await page.focus(selector, { nth: 0 }))?.focused) {
            await page.pressKey('Control+a');
            await page.pressKey('Backspace');
        }
    } catch {}
    try {
        const reach = await hitTest(page, cancel, { scrollIntoView: true });
        if (reach?.found && reach.hit) await page.click(cancel.selector, { nth: 0 });
        await page.wait({ time: 0.4 });
    } catch {}
    let box = await readNoticeBox(page);
    if (box.open) {
        // The coordinate click can miss this small text button; the in-page click folds it (probed).
        await page.evaluateWithArgs(`
          (() => { const node = document.querySelector(selector); if (node) node.click(); return { clicked: Boolean(node) }; })()
        `, { selector: cancel.selector });
        await page.wait({ time: 0.4 });
        box = await readNoticeBox(page);
    }
    return { closed: !box.open, leftover: box.value };
}

async function waitForNoticeSubmit(page) {
    const submit = { selector: `[${NOTICE_TARGET_ATTR}="1"] button.submit`, nth: 0 };
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
        const reach = await hitTest(page, submit, { scrollIntoView: true });
        if (reach?.found && reach.hit && !reach.disabled) return submit;
        await page.wait({ time: 0.3 });
    }
    return null;
}

/** Turn a reply outcome into the result row (screenshots for the unclear cases). */
async function finishReply(page, outcome, info) {
    if (outcome.verification) {
        await page.screenshot({ path: '/tmp/xhs_comment_verify_qr.png' });
        return {
            status: '🔐 需要扫码验证',
            detail: `${preview(outcome.reason, 80)} · ${info.label} · 用手机小红书扫码（二维码 1 分钟过期）· 截图: /tmp/xhs_comment_verify_qr.png · 回复未发出、未自动重试`,
        };
    }
    if (outcome.blocked) {
        return { status: '⛔ 回复被拦下', detail: `${outcome.reason} · ${info.label} · 没发出去` };
    }
    if (outcome.mismatch) {
        return { status: '⚠️ 回复挂错了地方', detail: `${outcome.reason} · ${info.label} · 已经发出去了，告诉主人` };
    }
    if (outcome.ok === false) {
        return {
            status: '⚠️ 回复未发布',
            detail: `${outcome.reason} · ${info.label} · 输入框${outcome.ui?.inputCleared ? '已清空' : '保留原文'} · 未自动重试`,
        };
    }
    if (outcome.ok === true && outcome.source === 'api') {
        const seen = info.readback ? ` · ${READBACK_NOTES[info.readback] ?? info.readback}` : '';
        return {
            status: '✅ 回复成功',
            detail: `${info.label} · "${preview(info.text)}" · 服务器已确认${outcome.newCommentId ? `（新回复 ${outcome.newCommentId}）` : ''}${seen} · ${info.pathNote}`,
        };
    }
    if (outcome.ok === true) {
        return {
            status: '⚠️ 回复大概已发出',
            detail: `${info.label} · "${preview(info.text)}" · ${outcome.reason}，没截到服务器回执，挂没挂对没核实 · ${info.pathNote} · 别重发，先只读看一眼`,
        };
    }
    await page.screenshot({ path: '/tmp/xhs_comment_unknown_debug.png' });
    return {
        status: '⚠️ 提交状态不明',
        detail: `${info.label} · "${preview(info.text)}" · ${info.pathNote} · ${SUBMIT_WAIT_MS / 1_000}s 内无回执 · 输入框残留: "${preview(outcome.ui?.inputText, 50)}" · 未自动重试 · 截图: /tmp/xhs_comment_unknown_debug.png`,
    };
}

/** Route 1 — reply from 「评论和@」. `{ row }` = final answer; `{ why }` = not here, nothing sent. */
async function replyViaNotice(page, ctx) {
    // Never goto /notification: overseas IPs get sent to www.rednote.com, where our login does not apply.
    const hop = await openNotificationPage(page);
    if (hop.error === 'login_required') {
        throw new AuthRequiredError('www.xiaohongshu.com', 'Replying requires login');
    }
    if (hop.error) return { why: `通知页没打开（${hop.error}）` };
    await resetCommentRound(page, ctx.replyTo);
    await page.wait({ time: 1.5 + Math.random() });
    const tab = await ensureMentionsTab(page);
    let found = null;
    let lastLen = -1;
    for (let pageNo = 0; pageNo <= NOTICE_MAX_PAGES; pageNo++) {
        found = await page.evaluateWithArgs(NOTICE_FIND_JS, {
            commentId: ctx.replyTo,
            itemSelector: NOTICE_ITEM_SELECTOR,
            attr: NOTICE_TARGET_ATTR,
        });
        if (!found || found.error) {
            return { why: `通知页读不到列表（${found?.error ?? '无返回'}${tab.error ? ` · ${tab.error}` : ''}）` };
        }
        if (found.found || !found.hasMore || found.listLen <= lastLen) break;
        lastLen = found.listLen;
        await page.evaluateWithArgs(NOTICE_SCROLL_JS, { itemSelector: NOTICE_ITEM_SELECTOR });
        await page.wait({ time: 1.2 + Math.random() * 0.8 });
    }
    if (!found.found) return { why: `通知里没有（看了 ${found.listLen} 条${found.hasMore ? '，没翻到底' : '，已到底'}）` };
    // 通知里有这条、帖子也对得上：记下通知里的帖子编号 + 通行码，这里回不成时帖子页那条路直接拿它页内打开。
    const fromNotice = found.want || {};
    if (fromNotice.noteId && fromNotice.xsecToken && (!ctx.noteId || fromNotice.noteId === ctx.noteId)) {
        ctx.noticeTarget = { noteId: fromNotice.noteId, xsecToken: fromNotice.xsecToken, xsecSource: 'pc_notice' };
    }
    if (!found.marked) return { why: `通知里有，但页面上认不准是哪一条（${found.candidates} 条候选）` };
    const { want } = found;
    if (ctx.noteId && want.noteId && want.noteId !== ctx.noteId) {
        return { row: { status: '⚠️ 评论和帖子对不上', detail: `评论 ${ctx.replyTo} 在帖子 ${want.noteId} 底下，不是给的 ${ctx.noteId} · 未发送` } };
    }

    const replyButton = { selector: `[${NOTICE_TARGET_ATTR}="1"] .action-reply`, nth: 0 };
    let reach = await hitTest(page, replyButton, { scrollIntoView: true });
    if (!reach?.found) return { why: '通知里这一条没有「回复」按钮' };
    if (!reach.hit) {
        await page.wait({ time: 0.6 });
        reach = await hitTest(page, replyButton, { scrollIntoView: true });
    }
    if (!reach?.hit) return { why: `通知页「回复」按钮被挡住（那个位置是 ${reach?.blockedBy ?? '未知'}）` };
    const click = await clickAndConfirm(page, replyButton);
    if (!click.landed) return { why: '通知页点「回复」没点上' };
    const box = await waitForNoticeReplyBox(page, want.nickname);
    if (!box.ok) {
        await closeNoticeReply(page);
        return { why: box.placeholder ? `通知页回复框写的是「${box.placeholder}」，不是「回复 ${want.nickname}」` : '通知页点了「回复」但没出回复框' };
    }
    const filled = await typeNoticeReplyLikeHuman(page, ctx.text, { deadline: sendDeadline(ctx) });
    if (!filled.ok) {
        await closeNoticeReply(page);
        return { why: `通知页填字没填准（框里是「${preview(filled.value, 40)}」）` };
    }
    const label = `通知页 · 回 ${want.nickname} 那条「${preview(want.content, 30)}」`;
    const submit = await waitForNoticeSubmit(page);
    if (ctx.dryRun) {
        await page.screenshot({ path: '/tmp/xhs_comment_dryrun.png' });
        const closed = await closeNoticeReply(page);
        return {
            row: {
                status: '🔍 dry-run',
                detail: `${label}（回复框写着「${box.placeholder}」）· 已精确填入，未发送 · ${filled.note} · 发送按钮${submit ? '可点' : '没找到'} · 收尾${closed.closed ? '已清空收起' : `没收起（残留「${preview(closed.leftover, 20)}」）`} · "${preview(ctx.text)}" · 截图: /tmp/xhs_comment_dryrun.png`,
            },
        };
    }
    if (!submit) {
        await closeNoticeReply(page);
        return { why: '通知页填好了，但找不到能点的「发送」' };
    }
    if (!submitTimeLeft(ctx)) {
        await closeNoticeReply(page);
        return { row: timeUpRow(ctx) };
    }
    await armReplyGuard(page, ctx.replyTo);
    const captureReady = await installCommentCapture(page);
    const sent = await clickAndConfirm(page, submit, { deadline: sendDeadline(ctx) });
    if (sent.expired) {
        await closeNoticeReply(page);
        return { row: timeUpRow(ctx) };
    }
    if (!sent.landed) {
        await page.screenshot({ path: '/tmp/xhs_comment_click_lost_debug.png' });
        return {
            row: {
                status: '⚠️ 回复未发布',
                detail: `${label} · 「发送」没点上，应该没发出去 · 未自动重试，重跑前先只读看一眼 · 截图: /tmp/xhs_comment_click_lost_debug.png`,
            },
        };
    }
    const outcome = await waitForSubmitOutcome(page, ctx.text, captureReady, { readUi: readNoticeReplyUi, expectedTarget: ctx.replyTo });
    const pathNote = `${filled.note} · 点「发送」${sent.trusted ? '' : ' · ⚠️ 点击非真实鼠标事件'}`;
    return { row: await finishReply(page, outcome, { label, text: ctx.text, pathNote, readback: null }) };
}

/** Route 2 — reply on the note page. `{ row }` = final answer; `{ why }` = not found, nothing sent. */
async function replyViaNote(page, ctx) {
    // 通知页那条路找到过这条通知就用通知里的帖子编号 + 通行码（pc_notice），没有就从给的帖子网址里取。
    const target = ctx.noticeTarget ?? noteTargetFromUrl(ctx.noteUrl);
    if (!target) return { why: '帖子网址里认不出帖子编号或通行码，帖子页没打开' };
    await openNoteForComment(page, target);
    await resetCommentRound(page, ctx.replyTo);
    await page.wait({ time: 2 + Math.random() * 2 });
    await waitForCommentInput(page);
    const gate = await detectVerificationGate(page);
    if (gate.present) {
        await page.screenshot({ path: '/tmp/xhs_comment_verify_qr.png' });
        return {
            row: {
                status: '🔐 需要扫码验证',
                detail: `打开笔记时就弹了验证：${preview(gate.text, 80)} · 用手机小红书扫码（二维码 1 分钟过期）· 截图: /tmp/xhs_comment_verify_qr.png · 未发送`,
            },
        };
    }
    const search = await locateCommentOnNote(page, ctx.replyTo);
    if (!search.found) {
        return {
            why: `帖子页没找到（${search.total ? `${search.total}，` : ''}加载了 ${search.parents} 条主楼、展开 ${search.expanded} 处楼中楼${search.atEnd ? '，已到底' : ''}）`,
        };
    }
    const replyButton = { selector: `#comment-${ctx.replyTo} .interactions .reply`, nth: 0 };
    let reach = await hitTest(page, replyButton, { scrollIntoView: true });
    if (!reach?.found) return { why: '帖子页找到了这条评论，但它没有「回复」按钮' };
    if (!reach.hit) {
        await page.wait({ time: 0.6 });
        reach = await hitTest(page, replyButton, { scrollIntoView: true });
    }
    if (!reach?.hit) return { why: `帖子页「回复」按钮被挡住（那个位置是 ${reach?.blockedBy ?? '未知'}）` };
    const click = await clickAndConfirm(page, replyButton);
    if (!click.landed) return { why: '帖子页点「回复」没点上' };
    const armed = await waitForCommentTarget(page, ctx.replyTo);
    if (!armed.ok) {
        await cancelNoteReply(page);
        return { why: `帖子页点了「回复」，页面对准的却是 ${armed.id || '空'}` };
    }
    const label = `帖子页 · 回 ${armed.nickname || '对方'} 那条「${preview(armed.content, 30)}」`;
    const typed = await typeCommentLikeHuman(page, await locateVisibleTarget(page, INPUT_SELECTORS), ctx.text, {
        deadline: sendDeadline(ctx),
    });
    await page.wait({ time: 0.5 });
    const held = await readCommentTarget(page);
    if (held.id !== ctx.replyTo) {
        await clearCommentInput(page);
        await cancelNoteReply(page);
        return { row: { status: '⚠️ 回复未发布', detail: `${label} · 填字时回复对象变成了 ${held.id || '空'}，已清空 · 未发送` } };
    }
    const inputTarget = await locateVisibleTarget(page, INPUT_SELECTORS);
    if (!inputTarget) throw new Error('Comment input disappeared after filling text.');
    if (ctx.dryRun) {
        const enterNote = await finishDryRun(page);
        const after = await readCommentTarget(page);
        return {
            row: {
                status: '🔍 dry-run',
                detail: `${label}（填字前后 commentTarget 都对得上）· 已精确填入并清空，未发送 · ${typed.note} · ${enterNote} · 收尾后回复态${after.id ? `还在（${after.id}）` : '已退出'} · "${preview(ctx.text)}" · 截图: /tmp/xhs_comment_dryrun.png`,
            },
        };
    }
    if (!submitTimeLeft(ctx)) {
        await clearCommentInput(page);
        await cancelNoteReply(page);
        return { row: timeUpRow(ctx) };
    }
    const { outcome, pathNote } = await submitWithEnter(page, ctx.text, inputTarget, {
        expectedTarget: ctx.replyTo,
        deadline: sendDeadline(ctx),
        beforeButtonFallback: async () => {
            const now = await readCommentTarget(page);
            return now.id === ctx.replyTo ? null : `回复对象变成了 ${now.id || '空'}，不点发送`;
        },
    });
    const readback = outcome.ok === true && outcome.source === 'api'
        ? await readbackOnNote(page, ctx.replyTo, outcome.newCommentId)
        : null;
    return { row: await finishReply(page, outcome, { label, text: ctx.text, pathNote: `${typed.note} · ${pathNote}`, readback }) };
}

async function replyToComment(page, ctx) {
    const misses = [];
    if (ctx.via !== 'note') {
        const viaNotice = await replyViaNotice(page, ctx);
        if (viaNotice.row) return [viaNotice.row];
        misses.push(viaNotice.why);
    }
    if (ctx.via !== 'notice') {
        const viaNote = await replyViaNote(page, ctx);
        if (viaNote.row) return [viaNote.row];
        misses.push(viaNote.why);
    }
    return [{
        status: '⚠️ 没能回在这条底下',
        detail: `评论 ${ctx.replyTo} · ${misses.join(' · ')} · 未发送，可以改发一条顶层评论`,
    }];
}

cli({
    site: 'xiaohongshu',
    name: 'comment',
    access: 'write',
    description: '小红书发布评论 (note detail page UI automation)',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    // 跑在常驻页（opencli 常驻会话 site:xiaohongshu）里，不再一次性开新页——为什么见文件头「常驻页」。
    siteSession: 'persistent',
    args: [
        { name: 'note-id', required: true, positional: true, help: 'Full Xiaohongshu note URL with xsec_token' },
        { name: 'text', required: true, positional: true, help: '评论正文 (最多300字)' },
        { name: 'dry-run', type: 'boolean', default: false, help: '准备好评论但不点击发送 (用于验证 selector + cancel)' },
        { name: 'reply-to', help: '回复某一条评论：评论 ID（24 位字母数字，不是通知编号）。先在通知页找、再去帖子页找，都找不到就不发' },
        { name: 'reply-via', default: 'auto', help: '回复走哪条路：auto（先通知页、再帖子页）/ notice / note' },
        { name: 'timeout', type: 'int', required: false, default: COMMAND_TIMEOUT_S, help: `整条命令最多跑多少秒（默认 ${COMMAND_TIMEOUT_S}）` },
    ],
    columns: ['status', 'detail'],
    func: async (page, kwargs) => {
        if (!page) throw new Error('Browser page required');
        const startedAt = Date.now();
        const raw = String(kwargs['note-id'] ?? '').trim();
        const text = String(kwargs.text ?? '').trim();

        if (!text) throw new Error('Positional argument <text> is required');
        if (text.length > MAX_COMMENT_LEN) {
            throw new Error(`Comment is ${text.length} chars — must be ≤ ${MAX_COMMENT_LEN}`);
        }
        const noteUrl = buildNoteUrl(raw, { commandName: 'xiaohongshu comment' });

        const reply = parseReplyTarget(kwargs['reply-to']);
        if (reply.error) throw new ArgumentError(reply.error);
        if (reply.id) {
            const via = String(kwargs['reply-via'] ?? 'auto').trim() || 'auto';
            if (!REPLY_ROUTES.includes(via)) {
                throw new ArgumentError(`--reply-via 只能是 ${REPLY_ROUTES.join(' / ')}，收到「${via}」`);
            }
            return replyToComment(page, {
                replyTo: reply.id,
                via,
                text,
                dryRun: Boolean(kwargs['dry-run']),
                noteUrl,
                noteId: parseNoteId(raw),
                startedAt,
                timeoutS: Number(kwargs.timeout) || COMMAND_TIMEOUT_S,
            });
        }

        // ── Step 1: Open the note in the resident tab, clear what the last round left ──
        const target = noteTargetFromUrl(noteUrl);
        if (!target) throw new ArgumentError('帖子网址里认不出帖子编号或通行码（xsec_token），没打开帖子 · 未发送');
        await openNoteForComment(page, target);
        await resetCommentRound(page);
        await page.wait({ time: 2 + Math.random() * 2 });

        // ── Step 2: Wait for the lazily-rendered editor, while checking gates ─────
        const editor = await waitForCommentInput(page);
        const preGate = await detectVerificationGate(page);
        if (preGate.present) {
            await page.screenshot({ path: '/tmp/xhs_comment_verify_qr.png' });
            return [{
                status: '🔐 需要扫码验证',
                detail: `打开笔记时就弹了验证：${preview(preGate.text, 80)} · 用手机小红书扫码（二维码 1 分钟过期）· 截图: /tmp/xhs_comment_verify_qr.png · 未发送`,
            }];
        }

        // ── Step 3: Read a moment, type the text in bursts, verify it exactly ─────
        //    (typeCommentLikeHuman — stale draft replaced, one-shot exact fill as fallback.)
        //    No longer waits for the 取消/发送 row to expand: in the modal layout it
        //    never does (2026-09-06), and Enter does not need it.
        const typed = await typeCommentLikeHuman(page, editor, text, {
            deadline: sendDeadline({ startedAt, timeoutS: Number(kwargs.timeout) || COMMAND_TIMEOUT_S }),
        });
        await page.wait({ time: 0.5 });
        const inputTarget = await locateVisibleTarget(page, INPUT_SELECTORS);
        if (!inputTarget) throw new Error('Comment input disappeared after filling text.');

        if (kwargs['dry-run']) {
            const enterNote = await finishDryRun(page);
            return [{
                status: '🔍 dry-run',
                detail: `已精确填入并清空，未发送 · ${typed.note} · ${enterNote} · "${preview(text)}" · 截图: /tmp/xhs_comment_dryrun.png`,
            }];
        }

        // ── Steps 4–6: Enter → real POST status → button fallback (see submitWithEnter) ──
        const { outcome, pathNote: enterPath } = await submitWithEnter(page, text, inputTarget, {
            deadline: sendDeadline({ startedAt, timeoutS: Number(kwargs.timeout) || COMMAND_TIMEOUT_S }),
        });
        const pathNote = `${typed.note} · ${enterPath}`;

        if (outcome.verification) {
            await page.screenshot({ path: '/tmp/xhs_comment_verify_qr.png' });
            return [{
                status: '🔐 需要扫码验证',
                detail: `${preview(outcome.reason, 80)} · 用手机小红书扫码（二维码 1 分钟过期）· 截图: /tmp/xhs_comment_verify_qr.png · 评论未发出、未自动重试`,
            }];
        }
        if (outcome.blocked) {
            // 发送那一刻拦下了（顶层评论带着回复对象）：没发出去，按失败退出，不能当成「状态不明」或成功。
            throw new CliError('COMMENT_BLOCKED',
                `${outcome.reason} · 输入框${outcome.ui?.inputCleared ? '已清空' : '保留原文'} · 未自动重试`,
                '网站把这条顶层评论当成了回复（页面上可能还挂着上一轮的回复对象）；先只读看一眼帖子确认没发出去，再重跑');
        }
        if (outcome.ok === false) {
            return [{
                status: '⚠️ 评论未发布',
                detail: `${outcome.reason} · 输入框${outcome.ui.inputCleared ? '已清空' : '保留原文'} · 未自动重试`,
            }];
        }
        if (outcome.ok === true) {
            return [{
                status: '✅ 评论成功',
                detail: `"${preview(text)}" · ${outcome.reason} · ${pathNote}`,
            }];
        }
        await page.screenshot({ path: '/tmp/xhs_comment_unknown_debug.png' });
        return [{
            status: '⚠️ 提交状态不明',
            detail: `"${preview(text)}" · ${pathNote} · ${SUBMIT_WAIT_MS / 1_000}s 内无回执 · 输入框残留: "${preview(outcome.ui.inputText, 50)}" · 未自动重试 · 截图: /tmp/xhs_comment_unknown_debug.png`,
        }];
    },
});
