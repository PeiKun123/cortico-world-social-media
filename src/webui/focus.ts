import { safeBiliLink } from '../interactions.ts';
import type { OwnerFocus } from '../focus.ts';
export type FocusSnapshot = ReturnType<OwnerFocus['status']>;
const el = (tag: string, text?: string, cls?: string) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
export function focusStatus(state?: FocusSnapshot, platformEnabled = true) {
  const count = state?.works?.length ?? 0;
  let label = '尚未设置特别关注',
    tone = 'quiet';
  if (state?.input) {
    if (!platformEnabled) label = '平台未启用 · 关注设置已保留';
    else if (!state.enabled) label = '特别关注未开启';
    else if (state.identity?.state === 'awaiting-account') label = '等待核对当前登录账号';
    else if (!state.binding) {
      label = '主人账号待核对';
      tone = state.check?.error ? 'warning' : 'quiet';
    } else if (state.check?.error) {
      label = count ? '最近检查未完成 · 保留 ' + count + ' 条作品' : '账号已识别 · 暂未读到作品';
      tone = 'warning';
    } else if (!state.check) label = '账号已识别 · 等待首次检查';
    else {
      label =
        '最近检查完成 · ' +
        count +
        ' 条作品' +
        (state.autoReplyNewComments ? ' · 自动回应已开启' : '');
      tone = 'good';
    }
  }
  const detail = [
    state?.binding ? '关注 ' + state.binding.name : '',
    !platformEnabled || !state?.enabled
      ? '当前未启用检查；填写的账号与已发现作品会保留。'
      : state?.autoReplyNewComments
        ? state.replyExistingComments
          ? '已开启补看：在已读取的主人作品范围内，也考虑已有未回复评论；正常评论逐条处理，已有发送位置不重复发。'
          : '仅检查已发现作品的新评论；首次扫描不补旧评论，正常交流进入待回应队列，不计普通日配额，保留间隔、防重及安全判断。'
        : '可开启新评论自动回应；未开启时由Bot按兴趣选择参与。',
    state?.check?.error
      ? '本次原因：' + state.check.error + ' 这不代表没有新评论；稍后再检查。'
      : '',
    state?.check?.at ? '上次检查：' + new Date(state.check.at).toLocaleString() : '',
  ]
    .filter(Boolean)
    .join('\n');
  return { label, detail, tone };
}
export function focusView(
  refresh: () => Promise<void>,
  signal: AbortSignal,
  label = 'B站特别关注',
  platform = 'bilibili',
) {
  const section = document.createElement('details');
  section.className = 'sm-focus-card';
  section.dataset.platform = platform;
  const summary = el('summary', label);
  const body = el('div', undefined, 'sm-focus-body');
  section.append(summary, body);
  section.hidden = true;
  let digest = '';
  return {
    element: section,
    render(state?: FocusSnapshot, platformEnabled = true) {
      section.hidden = !state || (!state.enabled && !state.input);
      if (!state) return;
      const next = JSON.stringify([state, platformEnabled]);
      if (next === digest) return;
      digest = next;
      const status = focusStatus(state, platformEnabled);
      summary.textContent = label + ' · ' + status.label;
      summary.dataset.state = status.tone;
      body.replaceChildren();
      body.append(el('p', status.detail, 'sm-muted sm-focus-status'));
      if (!state.binding)
        body.append(
          el(
            'p',
            state.input
              ? label.startsWith('抖音') || label.startsWith('快手')
                ? '请填写准确的平台账号或完整用户主页，核实后固定身份。'
                : '昵称将按最早主动联系记录识别；也可以在配置中填写UID或主页链接立即确定。'
              : '请先在配置中填写主人账号。',
            'sm-muted',
          ),
        );
      else {
        body.append(
          el(
            'p',
            '已固定 UID ' +
              state.binding.ownerId +
              (state.binding.method === 'first-contact'
                ? ' · 按最早联系记录识别'
                : ' · 由本地设置指定'),
            'sm-muted',
          ),
        );
        body.append(
          el(
            'p',
            '显示最近 ' + state.limit + ' 条作品范围；未显示的历史作品不代表已经参与。',
            'sm-muted',
          ),
        );
        for (const work of state.works) {
          const row = el('article', undefined, 'sm-focus-work');
          const labels: Record<string, string> = {
            unseen: '尚未参与',
            public: '已参与 · 访客可见',
            limited: '已发送 · 仅自己可见',
            accepted: '已发送 · 公开待确认',
            unknown: '发送结果待核对',
          };
          const href = safeBiliLink(work.url);
          if (href) {
            const a = document.createElement('a');
            a.href = href;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = work.title;
            row.append(a);
          } else row.append(el('strong', work.title));
          row.append(
            el(
              'span',
              labels[work.participation] + ' · ' + work.comments + ' 条已发送',
              'sm-muted',
            ),
          );
          body.append(row);
        }
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '检查关注作品';
      button.disabled = !state.enabled || !platformEnabled;
      button.addEventListener(
        'click',
        async () => {
          button.disabled = true;
          try {
            await refresh();
          } finally {
            if (!signal.aborted) button.disabled = !state.enabled || !platformEnabled;
          }
        },
        { signal },
      );
      body.append(button);
    },
  };
}
