// 改自 OpenCLI 1.8.7 的 clis/xiaohongshu/note.js（Apache-2.0），改动见 NOTICE.md
/**
 * Xiaohongshu note — read full note content from a public note page.
 *
 * Extracts title, author, description text, and engagement metrics
 * (likes, collects, comment count) via DOM extraction.
 *
 * Requires a full Xiaohongshu note URL with xsec_token.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CliError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { parseNoteId, buildNoteUrl, inspectNoteAccess } from './note-helpers.js';
import { noteTargetFromUrl, openNoteInPage, reportResident } from './resident-helpers.js';

/** 安全限制 / 登录墙 / 不存在：取数结果和「页内打开没成」时只跑的访问检查（inspectNoteAccess）共用这几条报错。 */
function throwNoteAccessError(state, raw, noteId) {
    if (state?.securityBlock) {
        throw new CliError('SECURITY_BLOCK', 'Xiaohongshu security block: the note detail page was blocked by risk control.', /^https?:\/\//.test(raw)
            ? 'The page may be temporarily restricted. Try again later or from a different session.'
            : 'Try using a full URL from search results (with xsec_token) instead of a bare note ID.');
    }
    if (state?.loginWall) {
        throw new AuthRequiredError('www.xiaohongshu.com', 'Note content requires login');
    }
    if (state?.notFound) {
        throw new EmptyResultError('xiaohongshu/note', `Note ${noteId} not found or unavailable — it may have been deleted or restricted`);
    }
}

/**
 * 在常驻页里页内打开这条帖子（openNoteInPage，做法见 resident-helpers.js 文件头），往 stderr 报常驻页情况（reportResident）。
 * 没打开（ok:false）时页面停在哪不确定（安全限制页 / 登录页 / 别的帖子都可能），绝不取数：只跑访问检查，认出安全限制 /
 * 登录墙 / 不存在照旧报原来的错，都不是就报打开失败（带 openNoteInPage 的原因）。
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
    throwNoteAccessError(access, raw, noteId);
    throw new CommandExecutionError(`xiaohongshu note: could not open note ${noteId} in the resident page (${opened.reason})`,
        'Opening the note inside the resident Xiaohongshu page failed. Try again later.');
}
/**
 * Host-agnostic IIFE that scrapes note title / author / counts / tags from a
 * rendered note detail page. Exported so the rednote adapter can reuse the
 * exact same selector set without copying it.
 */
export const NOTE_EXTRACT_JS = `
      (() => {
        const { securityBlock, loginWall, notFound } = (${inspectNoteAccess.toString()})()

        const clean = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim()

        // Scope the note's own fields to #noteContainer — the detail panel.
        // The page also renders a recommendation feed next to the note, and
        // every card in that feed carries a .title. querySelector returns the
        // FIRST match in document order, so for a note that has no title of
        // its own (#detail-title absent) the unscoped selector fell through to
        // .title and reported an unrelated recommendation card's title as this
        // note's title. Same class of bug as the .interact-container scoping
        // below.
        const scope = document.querySelector('#noteContainer')
        const title = scope
          ? clean(scope.querySelector('#detail-title, .title'))
          : clean(document.querySelector('#detail-title'))
        const desc = scope
          ? clean(scope.querySelector('#detail-desc, .desc, .note-text'))
          : clean(document.querySelector('#detail-desc, .note-text'))
        const author = scope
          ? clean(scope.querySelector('.username, .author-wrapper .name'))
          : clean(document.querySelector('.username, .author-wrapper .name'))
        // Scope to .interact-container — the post's main interaction bar.
        // Without scoping, .like-wrapper / .chat-wrapper also match each
        // comment's like/reply buttons in the comment section, and
        // querySelector returns the FIRST match (a comment's count, not the
        // post's). The post's true counts live inside .interact-container.
        const likes = clean(document.querySelector('.interact-container .like-wrapper .count'))
        const collects = clean(document.querySelector('.interact-container .collect-wrapper .count'))
        const comments = clean(document.querySelector('.interact-container .chat-wrapper .count'))

        // Try to extract tags/topics
        const tags = []
        document.querySelectorAll('#detail-desc a.tag, #detail-desc a[href*="search_result"]').forEach(el => {
          const t = (el.textContent || '').trim()
          if (t) tags.push(t)
        })

        return { pageUrl: location.href, securityBlock, loginWall, notFound, title, desc, author, likes, collects, comments, tags }
      })()
    `;
export const command = cli({
    site: 'xiaohongshu',
    name: 'note',
    access: 'read',
    description: '获取小红书笔记正文和互动数据',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    // 走常驻页（opencli 常驻会话 site:xiaohongshu）：帖子在常驻页里页内打开，不整页打开主站（为什么见 resident-helpers.js 文件头）。
    siteSession: 'persistent',
    args: [
        { name: 'note-id', required: true, positional: true, help: 'Full Xiaohongshu note URL with xsec_token' },
        // opencli 只认名叫 timeout 的参数来定整条命令的上限（= timeout + 30 秒）；不写是 60 秒，装不下页内打开最坏约 85 秒。
        { name: 'timeout', type: 'int', required: false, default: 120, help: 'Max seconds for the overall command (default: 120)' },
    ],
    columns: ['field', 'value'],
    func: async (page, kwargs) => {
        const raw = String(kwargs['note-id']);
        const noteId = parseNoteId(raw);
        const url = buildNoteUrl(raw, { commandName: 'xiaohongshu note' });
        const target = noteTargetFromUrl(url);
        if (target) {
            await openInResidentPage(page, target, raw, noteId);
        }
        else {
            await page.goto(url);
        }
        await page.wait({ time: 2 + Math.random() * 3 });
        const data = await page.evaluate(NOTE_EXTRACT_JS);
        if (!data || typeof data !== 'object') {
            throw new EmptyResultError('xiaohongshu/note', 'Unexpected evaluate response');
        }
        throwNoteAccessError(data, raw, noteId);
        const d = data;
        // XHS renders placeholder text like "赞"/"收藏"/"评论" when count is 0;
        // normalize to '0' unless the value looks numeric.
        const numOrZero = (v) => /^\d+/.test(v) ? v : '0';
        // A note may legitimately have no title, but a real note page always
        // renders an author. If both are missing, the page failed to load.
        if (!d.title && !d.author) {
            throw new EmptyResultError('xiaohongshu/note', 'The note page loaded without visible content. The note may be deleted or restricted.');
        }
        const rows = [
            { field: 'title', value: d.title || '' },
            { field: 'author', value: d.author || '' },
            { field: 'content', value: d.desc || '' },
            { field: 'likes', value: numOrZero(d.likes || '') },
            { field: 'collects', value: numOrZero(d.collects || '') },
            { field: 'comments', value: numOrZero(d.comments || '') },
        ];
        if (d.tags?.length) {
            rows.push({ field: 'tags', value: d.tags.join(', ') });
        }
        return rows;
    },
});
