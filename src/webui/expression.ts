import { CHAT_SCENES } from '../expression-scenes.ts';
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { ExpressionPractice, ExpressionSample } from '../expression.ts';
import type { SocialPlatformConfig } from '../config.ts';
import { PUBLIC_POST_NAMES, tiebaForumNames, type PublicPostPlatform } from '../public-post-policy.ts';

export type PublicPlatformSettings = Partial<Record<PublicPostPlatform, SocialPlatformConfig & { bound: boolean; loginOpen?: boolean; paused?: string; account?: { name: string }; focusStatus?: { binding?: { name: string }; check?: { error?: string }; reading?: { cachedWorks: number } } }>>;

type Snapshot = {
  settings: { corpus?: boolean; practice?: boolean; training?: boolean; tieba?: boolean; xiaohongshu?: boolean };
  bound?: boolean;
  trainingBlocked?: string;
  running?: boolean;
  invited?: boolean;
  samples: ExpressionSample[];
  practices: ExpressionPractice[];
  practicePage: number;
  practicePages: number;
  practiceTotal: number;
  activeTotal: number;
  archivedTotal: number;
  archivable: number;
  handbookTotal: number;
  handbook: Array<{ id: string; chatUse?: ExpressionPractice['chatUse']; lesson: string; choice: string; source?: string }>;
};
function textPreview(text: string) {
  if (!text) return '练习记录';
  return text.length > 78 ? text.slice(0, 78) + '…' : text;
}
export function expressionSettings(ctx: WebUiPanelContext, refreshPublic: () => Promise<void>) {
  function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '') {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    return node;
  }
  const section = el('details');
  section.className = 'sm-subsection sm-experiments';
  const status = el('p');
  status.setAttribute('role', 'status');
  const body = el('div');
  const list = el('div');
  let queryValue = '';
  let practicePage = 1;
  let archived = false;
  let lastRendered = '';
  let revision = 0;
  function action(title: string, fn: () => Promise<void>) {
    const button = el('button', title);
    button.type = 'button';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await fn(); }
      catch (error) { status.textContent = error instanceof Error ? error.message : '操作失败。'; }
      finally {
        button.disabled = ctx.signal.aborted;
      }
    }, { signal: ctx.signal });
    return button;
  }
  function toggle(label: string, checked: boolean, fn?: (value: boolean) => Promise<void>, feedback: HTMLElement = status) {
    const row = el('label');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    row.append(input, document.createTextNode(' ' + label));
    if (fn) input.addEventListener('change', async () => {
      const value = input.checked;
      input.disabled = true;
      try { await fn(value); }
      catch (error) { input.checked = !value; feedback.textContent = error instanceof Error ? error.message : '保存失败。'; }
      finally { input.disabled = false; }
    }, { signal: ctx.signal });
    return { row, input };
  }
  function chatUsage(row: Pick<ExpressionPractice, 'id'|'chatUse'>, lesson: string, query: string) {
    const use = el('details');
    use.append(el('summary', row.chatUse ? '日常聊天 · 已采用' : '用于日常聊天'),
      el('p', '选择场景，留一句愿意让小K采用的表达建议。同一场景采用一条建议，新的选择会替换旧建议。停用后保留原练习。'));
    const scene = el('select'); scene.setAttribute('aria-label', '适用场景');
    for (const [key, label] of Object.entries(CHAT_SCENES)) { const opt = el('option', label); opt.value = key; scene.append(opt); }
    const advice = el('textarea'); advice.maxLength = 120; advice.setAttribute('aria-label','日常表达提示');
    advice.value = row.chatUse?.advice ?? (lesson.length <= 120 ? lesson : '');
    advice.placeholder = '用自己的话写一句可迁移的技巧，最多120字。';
    if (row.chatUse) scene.value = row.chatUse.scene;
    use.append(scene, advice, action('采用到日常聊天', async () => {
      await ctx.invoke('expressionChatUse', [row.id, scene.value, advice.value]); await refresh(query);
    }));
    if (row.chatUse) use.append(action('停用日常提示', async () => {
      await ctx.invoke('expressionChatUse', [row.id, null]); await refresh(query);
    }));
    return use;
  }
  async function refresh(query = queryValue, requestedPage = practicePage) {
    queryValue = query;
    const ticket = ++revision;
    const next = await ctx.invoke<Snapshot>('expressionList', [query, requestedPage, archived]);
    if (ctx.signal.aborted || ticket !== revision) return;
    practice.input.checked = next.settings.practice === true;
    controls.hidden = !practice.input.checked;
    training.input.checked = next.settings.training === true;
    openBound.hidden = !next.bound;
    resume.hidden = !next.bound || !next.trainingBlocked;
    connection.textContent = next.trainingBlocked ? '训练已暂停 · ' + next.trainingBlocked :
      next.running ? '正在和 Gemini 聊天' : next.invited ? '等小K选话题' :
      next.bound ? training.input.checked ? '训练已开启，空闲后继续' : '已绑定教学会话' : '尚未绑定教学会话';
    const previousPage = practicePage;
    practicePage = next.practicePage;
    const rendered = JSON.stringify([query, archived, next.archivedTotal, next.archivable, next.handbookTotal, next.samples, next.practicePage, next.practiceTotal, next.practices, next.handbook]);
    if (rendered === lastRendered) return;
    lastRendered = rendered;
    const opened = [...list.querySelectorAll<HTMLDetailsElement>(':scope > details')].map(details => details.open);
    const openedPractices = new Set(previousPage === practicePage
      ? [...list.querySelectorAll<HTMLElement>('.sm-practice-item[open]')].map(node => node.dataset.practiceId)
      : []);
    list.replaceChildren();
    const materials = el('details');
    materials.append(el('summary', '表达素材 · ' + next.samples.length), el('p', '小K收藏的公开短句。可看原帖，或移除不合适的例子。'));
    for (const entry of next.samples) {
      const row = el('p', entry.platform + ' · ' + entry.topic + '：' + entry.quote + (entry.note ? ' · ' + entry.note : ''));
      const link = el('a', ' 查看原帖');
      link.href = entry.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      row.append(link, action('移除', async () => {
        await ctx.invoke('expressionRemove', [entry.id]);
        await refresh(query);
      }));
      materials.append(row);
    }
    list.append(materials);
    const records = el('details');
    records.className = 'sm-practice-history';
    records.append(el('summary', (archived ? '已归档练习 · ' : '最近练习 · ') + next.practiceTotal));
    const guide = el('p', '每页最多 3 条。点开一条，即可查看对话和复盘。');
    guide.className = 'sm-practice-guide';
    records.append(guide, el('p', '当前练习 ' + (next.activeTotal ?? next.practiceTotal) + '/300 · 已归档 ' + (next.archivedTotal ?? 0) + '。满额后新练习自动归档最早一条已评估记录，保留原文及采纳状态。'));
    if (next.archivable) records.append(action('归档已评估练习（' + next.archivable + '）', async () => {
      const count = await ctx.invoke<number>('expressionArchiveReviewed', []);
      status.textContent = '已归档 ' + count + ' 条，可在归档中查看。';
      await refresh(query, 1);
    }));
    if (next.archivedTotal || archived) records.append(action(archived ? '返回当前练习' : '查看已归档练习', async () => {
      archived = !archived;
      await refresh(query, 1);
    }));
    if (!next.practiceTotal) records.append(el('p', '还没有练习记录。'));
    if (next.practicePages > 1) {
      const navigation = el('nav');
      navigation.className = 'sm-practice-navigation';
      navigation.setAttribute('aria-label', '练习记录分页');
      const counter = el('span', `第 ${practicePage} / ${next.practicePages} 页`);
      counter.tabIndex = -1;
      const go = (offset: number) => async () => {
        await refresh(query, practicePage + offset);
        list.querySelector<HTMLElement>('.sm-practice-navigation span')?.focus({ preventScroll: true });
      };
      const previous = action('上一页', go(-1));
      const following = action('下一页', go(1));
      previous.disabled = practicePage === 1;
      following.disabled = practicePage >= next.practicePages;
      navigation.append(previous, counter, following);
      records.append(navigation);
    }
    for (const row of next.practices) {
      const item = el('details');
      item.className = 'sm-practice-item';
      item.dataset.practiceId = row.id;
      item.open = openedPractices.has(row.id);
      const summary = el('summary');
      const topic = row.original.replace(/\s+/g, ' ').trim();
      summary.append(el('span', textPreview(topic)), el('time', new Date(row.at).toLocaleString()));
      const card = el('div');
      card.className = 'sm-practice-content';
      const message = (label: string, body: string, from: 'student' | 'teacher') => {
        const block = el('div');
        block.className = 'sm-practice-message sm-practice-' + from;
        block.append(el('h4', label), el('p', body));
        card.append(block);
      };
      message('小K · 发问', row.original, 'student');
      if (row.sample) card.append(el('p', '素材来源：' + row.sample.platform + ' · ' + row.sample.url));
      for (const [i, feedback] of row.feedback.entries()) {
        const followup = row.followups?.[i - 1];
        if (followup) message('小K · 追问', followup.message, 'student');
        message('Gemini · 回复 ' + (i + 1), feedback, 'teacher');
      }
      if ((row.followups?.length ?? 0) >= row.feedback.length && row.followups?.length)
        message('小K · 追问（未保存回复）', row.followups.at(-1)!.message, 'student');
      if (row.reason) card.append(el('p', row.reason));
      const inHandbook = row.adopted ?? row.assessment?.verdict === 'keep';
      if (row.reflection) {
        const r = row.reflection;
        const review = el('div');
        review.className = 'sm-practice-message sm-practice-review';
        review.append(el('h4', '小K · 复盘'), el('p', '小K的取舍：' + r.choice), el('p', '可复用经验：' + r.lesson),
          el('p', '新题：' + r.newQuestion), el('p', '小K的回答：' + r.newAnswer),
          el('p', row.adopted === false ? '已手动撤回' : row.assessment ? '小K评估：' +
            (row.assessment.verdict === 'keep' ? '已收录 · ' : '已跳过 · ') + row.assessment.reason :
            row.adopted ? '已手动收录' : '等待交接时由小K评估，训练可继续。'),
          action(inHandbook ? '撤回手册条目' : '手动收录', async () => {
            await ctx.invoke('expressionAdopt', [row.id, !inHandbook]);
            await refresh(query);
          }));
        review.append(chatUsage(row, r.lesson, query));
        card.append(review);
      } else if (row.status === 'review') card.append(el('p', '点评已收到，等小K记录取舍与新题。'));
      if (row.status !== 'running' && !inHandbook) card.append(action('移除练习记录', async () => {
        await ctx.invoke('expressionRemovePractice', [row.id]);
        await refresh(query);
      }));
      item.append(summary, card);
      records.append(item);
    }
    list.append(records);
    const handbook = el('details');
    handbook.append(el('summary', '说话手册 · ' + (next.handbookTotal ?? next.handbook.length)), el('p', '按话题找练习，展开「用于日常聊天」采纳或停用一条建议。启用人格化练习后，配套 QQ 与陪伴会按当前场景取用，无需启动 Gemini 训练。'));
    const search = el('input');
    search.type = 'search';
    search.value = query;
    search.placeholder = '按话题或表达技巧检索';
    handbook.append(search, action('检索', async () => {
      await refresh(search.value.trim());
      const rendered = list.lastElementChild as HTMLDetailsElement | null;
      if (rendered) rendered.open = true;
    }));
    for (const row of next.handbook) handbook.append(el('p', row.lesson + (row.source ? ' · ' + row.source : '')), chatUsage(row, row.lesson, query));
    if (!next.handbook.length) handbook.append(el('p', '没有匹配的已收录经验。'));
    list.append(handbook);
    [materials, records, handbook].forEach((details, i) => { details.open = opened[i] ?? false; });
  }
  const save = (key: keyof Snapshot['settings']) => async (value: boolean) => {
    await ctx.invoke('settings', [{ ['worlds.socialmedia.experiments.' + key]: value }]);
    await refresh();
  };
  const practice = toggle('人格化练习', false, save('practice'));
  const training = toggle('开始训练', false, save('training'));
  const publicFields = (['xiaohongshu', 'tieba'] as const).map(key => {
    const label = PUBLIC_POST_NAMES[key];
    const result = el('pre');
    result.setAttribute('role', 'status');
    result.className = 'sm-public-result';
    const savePlatform = async (values: Record<string, boolean | string | number>) => {
      await ctx.invoke('settings', [Object.fromEntries(Object.entries(values).map(([name, value]) =>
        ['worlds.socialmedia.platforms.' + key + '.' + name, value]))]);
      await refreshPublic();
    };
    const field = toggle('启用' + label + (key === 'tieba' ? '（实验）' : ''), false, value => savePlatform({ enabled: value }), result);
    field.row.className = 'sm-lab-enable';
    const posting = toggle('允许公开发言', false, value => savePlatform({ 'posting.enabled': value }), result);
    const standalone = key === 'xiaohongshu'
      ? toggle('允许在主人作品下新发评论', false, value => savePlatform({ 'posting.allowTopLevelComments': value }), result)
      : undefined;
    const focus = toggle('优先看主人作品', false, value => savePlatform({ 'focus.enabled': value }), result);
    const reply = toggle(key === 'xiaohongshu' ? '逐条考虑主人作品的新评论' : '自动回应主人作品的新评论',
      false, value => savePlatform({ 'focus.autoReplyNewComments': value }), result);
    const existingReplies = key === 'xiaohongshu'
      ? toggle('也考虑已有的评论', false, value => savePlatform({ 'focus.replyExistingComments': value }), result)
      : undefined;
    const interval = el('input');
    interval.type = 'number';
    interval.min = '2';
    interval.max = '60';
    interval.step = '1';
    const intervalRow = el('label', '新评论检查间隔（分钟） ');
    intervalRow.append(interval);
    interval.addEventListener('change', () => {
      if (!interval.value || !interval.reportValidity()) return;
      void savePlatform({ 'focus.autoReplyIntervalMinutes': interval.valueAsNumber }).catch(error => {
        result.textContent = error instanceof Error ? error.message : String(error);
      });
    });
    const owner = el('input');
    owner.type = 'url';
    owner.placeholder = label + '主人个人主页完整链接';
    owner.setAttribute('aria-label', owner.placeholder);
    owner.maxLength = 1500;
    const visual = el('select');
    const visualLabel = el('label', '画面档位 ');
    visual.setAttribute('aria-label', '画面档位');
    visualLabel.append(visual);
    visualLabel.className = 'sm-platform-visual-control';
    visualLabel.append(el('small', '实际张数取决于原帖和画面预算。'));
    for (const [value, caption] of [
      ['low', '低 · 省额度 · 1 张图 / 2 帧'],
      ['medium', '中 · 日常 · 3 张图 / 5 帧'],
      ['high', '高 · 看细节 · 6 张图 / 9 帧'],
    ]) {
      const option = el('option', caption);
      option.value = value;
      visual.append(option);
    }
    const accountState = el('p');
    accountState.setAttribute('aria-live', 'polite');
    visual.value = 'medium';
    visual.addEventListener('change', () => {
      void savePlatform({ postVisual: visual.value }).catch(error => {
        result.textContent = error instanceof Error ? error.message : '画面档位未保存。';
        void refreshPublic().catch(() => {});
      });
    }, { signal: ctx.signal });
    const url = el('input');
    url.type = 'url';
    url.placeholder = label + '原帖链接';
    url.setAttribute('aria-label', url.placeholder);
    url.maxLength = 1500;
    const query = el('input');
    query.type = 'search';
    query.maxLength = 80;
    query.placeholder = '话题，例如「我的世界」';
    query.setAttribute('aria-label', label + '搜索话题');
    const matches = el('ul');
    matches.className = 'sm-public-matches';
    matches.setAttribute('aria-label', label + '搜索结果');
    const card = el('section');
    card.className = 'sm-config-section sm-platform-card sm-public-posts';
    card.dataset.platform = key;
    card.tabIndex = -1;
    const readStatus = key === 'tieba' ? el('p') : result;
    readStatus.setAttribute('role', 'status');
    const article = el('article');
    article.className = 'sm-tieba-preview';
    article.hidden = true;
    let busy = false;
    const run = async (message: string, fn: () => Promise<void>, feedback: HTMLElement = result) => {
      if (busy) return;
      if (!field.input.checked) {
        feedback.textContent = '请先启用' + label + '。';
        return;
      }
      busy = true;
      feedback.textContent = message;
      try { await fn(); }
      catch (error) { feedback.textContent = error instanceof Error ? error.message : '操作失败。'; }
      finally { busy = false; }
    };
    const readPost = () => run('正在读取原帖…', async () => {
      const address = url.value.trim();
      if (!address) throw Error('先粘贴完整原帖链接，或从搜索结果选一条。');
      const post = await ctx.invoke<{ title: string; text: string; comments: string[]; url: string; detail: string; latestReplies?: boolean }>('expressionReadPost', [key, address]);
      if (key !== 'tieba') {
        result.textContent = [post.title, post.url, post.text, ...post.comments, post.detail].join('\n\n');
        return;
      }
      const header = el('div');
      header.append(el('h4', post.title));
      if (/^https:\/\/tieba\.baidu\.com\/p\/\d+$/.test(post.url)) {
        const link = el('a', '打开原帖 ↗');
        link.href = post.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        header.append(link);
      }
      const comments = el('ol');
      comments.className = 'sm-tieba-comments';
      for (const line of post.comments) comments.append(el('li', line));
      article.replaceChildren(header, el('p', post.text), el('h5', post.latestReplies ? '最新评论' : '官网显示的评论'),
        post.comments.length ? comments : el('p', '这页暂无可读评论。'));
      article.hidden = false;
      article.scrollIntoView({ block: 'nearest' });
      readStatus.textContent = post.latestReplies ? '已按官网倒序读取。' : post.detail;
    }, readStatus);
    const searchRow = el('div');
    searchRow.className = 'sm-public-search';
    const searchButton = action('搜索' + label, () => run('正在搜索…', async () => {
      matches.replaceChildren();
      const topic = query.value.trim();
      if (!topic) throw Error('先输入想搜的话题。');
      const data = await ctx.invoke<{ items: Array<{ title: string; url: string }>; detail: string }>('expressionSearchPosts', [key, topic]);
      for (const post of data.items) {
        const row = el('li');
        row.append(action(post.title, async () => {
          if (busy) return;
          url.value = post.url;
          await readPost();
        }));
        matches.append(row);
      }
      readStatus.textContent = data.items.length ? '找到 ' + data.items.length + ' 条。点标题读取。' : data.detail;
    }, readStatus));
    query.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      searchButton.click();
    }, { signal: ctx.signal });
    searchRow.append(query, searchButton);
    const forumChips = el('div');
    forumChips.className = 'sm-tieba-forum-chips';
    const forumInput = el('input');
    forumInput.type = 'text';
    forumInput.maxLength = 300;
    forumInput.setAttribute('aria-label', '要进的吧');
    forumInput.placeholder = '输入吧名，例如弱智吧';
    const forumList = el('ul');
    forumList.className = 'sm-public-matches sm-tieba-latest';
    forumList.setAttribute('aria-label', '最新帖子');
    const openForum = (name: string) => run('正在读取吧里的最新帖子…', async () => {
      if (!name) throw Error('先填一个吧名。');
      forumInput.value = name;
      forumList.replaceChildren();
      article.hidden = true;
      const data = await ctx.invoke<{ forum: string; items: Array<{ title: string; url: string; replies?: number }> }>(
        'expressionTiebaLatest', ['tieba', name]);
      for (const item of data.items) {
        const row = el('li');
        const button = action(item.title, async () => {
          url.value = item.url;
          await readPost();
        });
        if (item.replies !== undefined) button.append(el('small', item.replies + ' 条回复'));
        row.append(button);
        forumList.append(row);
      }
      readStatus.textContent = data.forum + (data.items.length ? ' · 最新 ' + data.items.length + ' 帖，点标题看回复。' : ' · 暂无可读取的新帖。');
    }, readStatus);
    const forumForm = el('form');
    forumForm.className = 'sm-public-search';
    const go = el('button', '进吧');
    go.type = 'submit';
    forumForm.append(forumInput, go);
    forumForm.addEventListener('submit', event => {
      event.preventDefault();
      void openForum(forumInput.value.trim());
    }, { signal: ctx.signal });
    let shownForums: string | undefined;
    const focusSection = el('details');
    focusSection.className = 'sm-subsection sm-platform-focus';
    const readSection = el('details');
    readSection.className = 'sm-subsection';
    const focusState = el('p');
    focusState.setAttribute('role', 'status');
    const closeLogin = action('关闭专用窗口', async () => {
      const closed = await ctx.invoke<{ message: string }>('expressionPublicClose', [key]);
      result.textContent = closed.message;
      await refreshPublic();
    });
    closeLogin.hidden = true;
    card.append(el('h3', label + ' · 账号与交流'));
    if (key === 'xiaohongshu') {
      const risk = el('p');
      risk.id = 'sm-xiaohongshu-posting-risk';
      risk.className = 'sm-posting-risk';
      risk.append(el('strong', '易风控'), document.createTextNode('已有用户反馈账号被限制发言。只看笔记时可关闭公开发言。'));
      card.append(risk);
      for (const control of [field, posting, standalone, reply]) control?.input.setAttribute('aria-describedby', risk.id);
    }
    card.append(field.row, accountState,
      el('p', (key === 'tieba' ? '若贴吧弹出验证，请先在专用窗口处理。' : '小红书通常需要先在专用窗口登录。') +
        '登录后保留专用窗口，回到这里点「核对并绑定登录账号」。绑定成功后专用窗口会关闭。'),
      action('打开' + label + '专用登录窗口', () => run('正在打开专用窗口…', async () => {
        const opened = await ctx.invoke<{ message: string }>('expressionPublicLogin', [key]);
        result.textContent = opened.message;
        await refreshPublic();
      })),
      action('核对并绑定登录账号', () => run('正在核对登录账号…', async () => {
        const connected = await ctx.invoke<{ message: string }>('expressionPublicConnect', [key]);
        result.textContent = connected.message;
        await refreshPublic();
      })),
      closeLogin,
      posting.row, visualLabel,
      focusSection, readSection, result);
    focusSection.append(el('summary', '特别关注'),
      el('p', '粘贴主人在本站的个人主页，优先看主人新发的图文或视频。请用小K的账号登录，主人主页填写你自己的账号。'),
      focusState, focus.row, owner,
      action('保存主人主页', () => run('正在核对主人主页…', async () => {
        const address = owner.value.trim();
        if (!address) throw Error('请粘贴平台官方网站的主人个人主页。');
        await savePlatform({ 'focus.account': address, 'focus.enabled': true });
        const checked = await ctx.invoke<{ binding?: { name: string }; check?: { error?: string } }>('expressionPublicFocus', [key]);
        result.textContent = checked.check?.error ?? (checked.binding ? '已绑定特别关注：' + checked.binding.name : '主页未能核实。');
        await refreshPublic();
      })),
      reply.row,
      ...(key === 'xiaohongshu' ? [intervalRow] : []),
      ...(existingReplies ? [existingReplies.row] : []),
      ...(standalone ? [standalone.row] : []),
      el('p', key === 'xiaohongshu'
        ? '按官网能加载的评论分批判断。有话才回，带图先看图。主人评论区独立检查，闲逛关闭也能回复；还受模型当前任务和平台发送间隔影响。开启新发评论后，每条主人作品最多一条独立评论。'
        : '主要用于看帖和收集语料。公开回复按原楼层核对并计入额度。'),
    );
    const readLink = el('div');
    readLink.className = 'sm-public-search';
    readLink.append(url, action('读取原帖', readPost));
    const recommendation = action('检查推荐流', () => run('正在试读推荐帖…', async () => {
      const tested = await ctx.invoke<{ title: string; url: string; detail: string }>('expressionPublicFeedCheck', [key]);
      readStatus.textContent = [tested.title, tested.url, tested.detail].join('\n');
    }, readStatus));
    if (key === 'tieba') {
      const more = el('details');
      more.className = 'sm-tieba-more';
      more.append(el('summary', '按关键词或链接找帖'), searchRow, matches, readLink);
      readSection.open = true;
      readSection.append(el('summary', '进吧看帖'), forumChips, forumForm, readStatus, forumList, article, more);
    } else {
      readSection.append(el('summary', '搜索与读取检查'),
        el('p', '按话题搜索或粘贴原帖链接，检查读到的正文和评论。'), recommendation, searchRow, matches, readLink);
    }
    return [key, { card, render(state: PublicPlatformSettings[PublicPostPlatform], ownerCount?: number | null) {
      if (!state) return;
      field.input.checked = state.enabled;
      if (key === 'tieba' && shownForums !== (state.roaming?.forums ?? '')) {
        shownForums = state.roaming?.forums ?? '';
        let forums: string[] = [];
        try { forums = tiebaForumNames(shownForums); } catch { /* malformed local settings */ }
        forumChips.replaceChildren(...forums.map(name => action(name + '吧', () => openForum(name + '吧'))));
        forumChips.hidden = !forums.length;
      }
      closeLogin.hidden = !state.loginOpen;
      focus.input.checked = state.focus?.enabled === true;
      posting.input.checked = state.posting.enabled;
      if (standalone) standalone.input.checked = state.posting.allowTopLevelComments === true;
      reply.input.checked = state.focus?.autoReplyNewComments === true;
      if (existingReplies) existingReplies.input.checked = state.focus?.replyExistingComments === true;
      if (key === 'xiaohongshu' && document.activeElement !== interval)
        interval.value = String(state.focus?.autoReplyIntervalMinutes ?? 5);
      visual.value = state.postVisual ?? 'medium';
      if (document.activeElement !== owner && !owner.value) owner.value = state.focus?.account ?? '';
      focusState.textContent = state.focusStatus?.check?.error ?? (state.focusStatus?.binding
        ? '已确认主人：' + state.focusStatus.binding.name +
          (key === 'xiaohongshu' && state.enabled && state.focus?.enabled && ownerCount != null
            ? ' · 主人评论区今日发言 ' + ownerCount + ' 条 · 独立计数' : '')
        : '尚未核对主人主页');
      accountState.textContent = (state.account ? '已核对登录账号：' + state.account.name : state.bound ? '已绑定，等待本次核对' : '未绑定登录账号') +
        (state.focusStatus?.binding ? ' · 主人：' + state.focusStatus.binding.name : '') +
        (state.loginOpen ? ' · 专用窗口已打开，等待绑定' : '') +
        (state.paused ? ' · 已暂停：' + state.paused : '');
    } }] as const;
  });
  function renderPublic(states?: PublicPlatformSettings, xiaohongshuOwnerCount?: number | null) {
    for (const [key, platform] of publicFields)
      platform.render(states?.[key], key === 'xiaohongshu' ? xiaohongshuOwnerCount : undefined);
  }
  const controls = el('div');
  controls.className = 'sm-experiment-controls';
  controls.hidden = true;
  const connection = el('p', '正在检查教学会话…');
  const openBound = action('在专用 Edge 查看已绑定会话', async () => {
    const result = await ctx.invoke<{ message: string }>('expressionOpenBound', []);
    status.textContent = result.message;
  });
  openBound.hidden = true;
  const resume = action('检查并恢复训练', async () => {
    status.textContent = '正在检查已绑定会话…';
    const result = await ctx.invoke<{ message: string }>('expressionResume', []);
    status.textContent = result.message;
    await refresh();
  });
  resume.hidden = true;
  const teachingUrl = el('input');
  teachingUrl.type = 'url';
  teachingUrl.placeholder = '粘贴 Gemini 教学会话网址';
  teachingUrl.setAttribute('aria-label', teachingUrl.placeholder);
  teachingUrl.maxLength = 1500;
  const buttons = el('div');
  buttons.className = 'sm-experiment-buttons';
  buttons.append(action('用 Edge 打开 Gemini', async () => {
    const result = await ctx.invoke<{ message: string }>('expressionLogin', []);
    status.textContent = result.message;
  }), teachingUrl, action('验证并绑定会话', async () => {
    const url = teachingUrl.value.trim();
    if (!url) throw Error('请先粘贴地址栏里的教学会话网址。');
    status.textContent = '正在检查登录和教学会话…';
    const result = await ctx.invoke<{ message: string }>('expressionBind', [url]);
    teachingUrl.value = '';
    status.textContent = result.message;
    await refresh();
  }));
  const trainingCost = el('p', '持续训练 · 高消耗。发问、追问和复盘会多次调用小K的模型，Gemini 的回复另占网页额度。空闲时会接着练，目前没有每日练习轮数设置。建议先短时试用，练完关闭「开始训练」。');
  trainingCost.className = 'sm-platform-boundary';
  controls.append(
    training.row, trainingCost,
    el('p', '开启后，小K空闲时会优先和 Gemini 练口语，自动发问和追问。私聊、控制台消息、主人作品下待回复的评论和到期计划优先，忙完会继续。每轮最多收四条回复，轮与轮之间约等半分钟。'),
    el('p', '发问、追问和复盘会自动继续。上下文交接后由小K评估经验，值得复用的会收进说话手册。暂停后先点「在专用 Edge 查看已绑定会话」，检查是否需要登录或验证，也可核对上条消息是否发出。关掉专用窗口，再点「检查并恢复训练」，原地址无需重贴。网页明确提示会话太长时，再换一条教学会话；普通超时先核对发问是否已送达。'),
    el('p', '首次用专用 Edge 登录 Gemini 后，打开已经聊过至少一轮的教学会话，复制地址栏网址。关闭专用窗口后粘贴并绑定。地址会保存，只有换教学会话时才需要重新粘贴。平时验证和训练都在后台。连续训练复用同一条会话，页面跳到别处会暂停。每次发问自带小K的 AI 学员身份和点评要求。'),
    buttons, connection, openBound, resume,
  );
  const cards = el('div');
  cards.className = 'sm-experiment-cards';
  const practiceCard = el('article');
  const practiceRisk = el('span', '易风控');
  practiceRisk.className = 'sm-risk-badge';
  practiceRisk.setAttribute('aria-hidden', 'true');
  practice.row.append(practiceRisk);
  practiceCard.append(practice.row,
    el('p', '实验性网页陪练。小K自己选话题和 Gemini 聊，再试试学到的表达。网页版限额、登录失效或页面变动都可能暂停练习。'),
    el('p', '开启「开始训练」后消耗较高，建议按需开启。'),
    el('p', '账号风险提示：自动连续访问 Gemini 网页可能触发 Google 人工验证、限流或账号使用限制。遇到提示请关闭训练，在专用窗口查看账号状态。'), controls);
  const ownerPractice = el('article');
  ownerPractice.append(el('h4', '和主人练一句'), el('p',
    '在私聊或本地控制台里直接说「陪我练一句」。小K先找出一句明显像套话的表达，再只问一句「这句听着奇怪吗？」也可以告诉它你会怎么说。需要时才练，沿用当前聊天的模型，不另外打开 Gemini。'));
  cards.append(practiceCard, ownerPractice);
  body.className = 'sm-experiment-body';
  body.append(el('p', '实验平台和练习每次启动 World 时关闭。手动开启后仅本次运行有效。'), cards, action('刷新练习与素材', () => refresh()), status, list);
  section.append(el('summary', '实验功能'), body);
  section.addEventListener('toggle', () => {
    if (section.open) void refresh().catch(error => { status.textContent = error.message; });
  }, { signal: ctx.signal });
  ctx.interval(() => {
    if (section.open && !list.contains(document.activeElement))
      void refresh().catch(error => { status.textContent = error.message; });
  }, 12000);
  return {
    element: section,
    publicPanels: publicFields.map(([key, platform]) => [key, PUBLIC_POST_NAMES[key], platform.card] as const),
    renderPublic,
  };
}
