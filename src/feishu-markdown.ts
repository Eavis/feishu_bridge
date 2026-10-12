/**
 * Feishu-specific Markdown processing.
 *
 * Rendering strategy:
 * - Code blocks / tables → interactive card (schema 2.0 markdown)
 * - Other text → post (msg_type: 'post') with md tag
 */

import type { ToolCallInfo } from './types.js';

export function hasComplexMarkdown(text: string): boolean {
  if (/```[\s\S]*?```/.test(text)) return true;
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) return true;
  return false;
}

export function preprocessFeishuMarkdown(text: string): string {
  return text.replace(/([^\n])```/g, '$1\n```');
}

export function buildCardContent(text: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      elements: [{ tag: 'markdown', content: text }],
    },
  });
}

export function buildPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text }]],
    },
  });
}

export function htmlToFeishuMarkdown(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildToolProgressMarkdown(tools: ToolCallInfo[]): string {
  if (tools.length === 0) return '';
  const lines = tools.map((tc) => {
    const icon = tc.status === 'running' ? '🔄' : tc.status === 'complete' ? '✅' : '❌';
    const hint = tc.hint ? ` — ${tc.hint}` : '';
    return `${icon} \`${tc.name}\`${hint}`;
  });
  return lines.join('\n');
}

/**
 * One-line summary used on the FINAL card (after stream ends) when the user
 * didn't ask for verbose output. Avoids dumping 50+ tool rows into chat.
 */
export function buildToolSummaryMarkdown(tools: ToolCallInfo[]): string {
  if (tools.length === 0) return '';
  const total = tools.length;
  const errors = tools.filter((t) => t.status === 'error').length;
  const parts = [`🛠 ${total} ops`];
  if (errors > 0) parts.push(`${errors} errors`);
  return parts.join(' · ');
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.floor(sec % 60);
  return `${min}m ${remSec}s`;
}

export function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}K`;
  return `${Math.round(count / 1000)}K`;
}

export function buildStreamingContent(text: string, tools: ToolCallInfo[]): string {
  let content = text || '';
  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) {
    content = content ? `${content}\n\n${toolMd}` : toolMd;
  }
  return content || '💭 Thinking...';
}

export function buildFinalCardJson(
  text: string,
  tools: ToolCallInfo[],
  footer: { status: string; elapsed: string; tokens?: string; cost?: string; context?: string } | null,
  options?: { verboseTools?: boolean },
): string {
  const elements: Array<Record<string, unknown>> = [];

  let content = preprocessFeishuMarkdown(text);
  const verbose = options?.verboseTools ?? false;
  const toolMd = verbose ? buildToolProgressMarkdown(tools) : buildToolSummaryMarkdown(tools);
  if (toolMd) {
    content = content ? `${content}\n\n${toolMd}` : toolMd;
  }

  if (content) {
    elements.push({
      tag: 'markdown',
      content,
      text_align: 'left',
      text_size: 'normal',
    });
  }

  if (footer) {
    const parts: string[] = [];
    if (footer.status) parts.push(footer.status);
    if (footer.elapsed) parts.push(footer.elapsed);
    if (footer.tokens) parts.push(footer.tokens);
    if (footer.cost) parts.push(footer.cost);
    if (footer.context) parts.push(`ctx ${footer.context}`);
    if (parts.length > 0) {
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'markdown',
        content: parts.join(' · '),
        text_size: 'notation',
      });
    }
  }

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: { elements },
  });
}

export function buildPermissionButtonCard(
  text: string,
  permissionRequestId: string,
  chatId?: string,
): string {
  const buttons = [
    { label: 'Allow', type: 'primary', action: 'allow' },
    { label: 'Allow Session', type: 'default', action: 'allow_session' },
    { label: 'Deny', type: 'danger', action: 'deny' },
  ];

  const buttonColumns = buttons.map((btn) => ({
    tag: 'column',
    width: 'auto',
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: btn.label },
      type: btn.type,
      size: 'medium',
      value: { callback_data: `perm:${btn.action}:${permissionRequestId}`, ...(chatId ? { chatId } : {}) },
    }],
  }));

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Permission Required' },
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'lock-chat_filled' },
      padding: '12px 12px 12px 12px',
    },
    body: {
      elements: [
        { tag: 'markdown', content: text, text_size: 'normal' },
        { tag: 'markdown', content: '⏱ This request will expire in 5 minutes', text_size: 'notation' },
        { tag: 'hr' },
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_align: 'left',
          columns: buttonColumns,
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: 'Or reply: `1` Allow · `2` Allow Session · `3` Deny',
          text_size: 'notation',
        },
      ],
    },
  });
}

export function buildCronConfirmCard(opts: {
  pendingId: string;
  cron: string;
  prompt: string;
  targetChatId: string;
  nextFireAt: number;
  sameAsOrigin: boolean;
}): string {
  const lines = [
    '**新建定时任务（待确认）**',
    `- cron: \`${opts.cron}\``,
    `- 目标 chat: ${opts.sameAsOrigin ? '此聊天' : `\`${opts.targetChatId}\``}`,
    `- 首次触发: ${new Date(opts.nextFireAt).toLocaleString('sv-SE')}`,
    '',
    `**Prompt:**`,
    '> ' + (opts.prompt.length > 200 ? opts.prompt.slice(0, 200) + '…' : opts.prompt).replace(/\n/g, '\n> '),
  ].join('\n');

  const buttons = [
    { label: '✅ 确认', type: 'primary', action: 'confirm' },
    { label: '❌ 取消', type: 'danger', action: 'cancel' },
  ];

  const buttonColumns = buttons.map((btn) => ({
    tag: 'column',
    width: 'auto',
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: btn.label },
      type: btn.type,
      size: 'medium',
      // schema 2.0: behaviors is the canonical place; value alone is legacy.
      behaviors: [{
        type: 'callback',
        value: { callback_data: `cron-${btn.action}:${opts.pendingId}` },
      }],
    }],
  }));

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '⏰ 定时任务确认' },
      template: 'turquoise',
    },
    body: {
      elements: [
        { tag: 'markdown', content: lines, text_size: 'normal' },
        { tag: 'hr' },
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_align: 'left',
          columns: buttonColumns,
        },
      ],
    },
  });
}

/**
 * Initial JSON for a streaming reply card with an inline Stop button.
 * Body elements: [stop-button action_set, streaming markdown placeholder].
 * The markdown element keeps element_id='streaming_content' so subsequent
 * cardElement.content updates target only it — the button is untouched.
 *
 * When the task finalizes, finalizeCard rewrites the whole card via
 * buildFinalCardJson (no button), so the stop button vanishes naturally.
 */
export function buildStreamingCardInitJson(sessionId: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: {
      streaming_mode: true,
      wide_screen_mode: true,
      summary: { content: '思考中...' },
    },
    body: {
      elements: [
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_align: 'left',
          columns: [{
            tag: 'column',
            width: 'auto',
            elements: [{
              tag: 'button',
              text: { tag: 'plain_text', content: '🛑 停止' },
              type: 'danger',
              size: 'small',
              behaviors: [{
                type: 'callback',
                value: { callback_data: `stop:${sessionId}` },
              }],
            }],
          }],
        },
        {
          tag: 'markdown',
          content: '💭 Thinking...',
          text_align: 'left',
          text_size: 'normal',
          element_id: 'streaming_content',
        },
      ],
    },
  });
}
