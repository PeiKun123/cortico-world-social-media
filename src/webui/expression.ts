import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { ExpressionPractice, ExpressionSample } from '../expression.ts';
import { PUBLIC_POST_TRIAL_ENABLED } from '../config.ts';

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
  handbook: Array<{ id: string; lesson: string; choice: string; source?: string }>;
};
function textPreview(text: string) {
  if (!text) return '练习记录';
  return text.length > 78 ? text.slice(0, 78) + '…' : text;
}
export function expressionSettings(ctx: WebUiPanelContext) {
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
  function toggle(label: string, checked: boolean, fn?: (value: boolean) => Promise<void>) {
    const row = el('label');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    row.append(input, document.createTextNode(' ' + label));
    if (fn) input.addEventListener('change', async () => {
      const value = input.checked;
      input.disabled = true;
      try { await fn(value); }
      catch (error) { input.checked = !value; status.textContent = error instanceof Error ? error.message : '保存失败。'; }
      finally { input.disabled = false; }
    }, { signal: ctx.signal });
    return { row, input };
  }
  async function refresh(query = queryValue, requestedPage = practicePage) {
    queryValue = query;
    const ticket = ++revision;
    const next = await ctx.invoke<Snapshot>('expressionList', [query, requestedPage]);
    if (ctx.signal.aborted || ticket !== revision) return;
    corpus.input.checked = next.settings.corpus === true;
    practice.input.checked = next.settings.practice === true;
    controls.hidden = !practice.input.checked;
    training.input.checked = next.settings.training === true;
    openBound.hidden = !next.bound;
    resume.hidden = !next.bound || !next.trainingBlocked;
    connection.textContent = next.trainingBlocked ? '训练已暂停 · ' + next.trainingBlocked :
      next.running ? '正在和 Gemini 聊天' : next.invited ? '等小K选话题' :
      next.bound ? training.input.checked ? '训练已开启，空闲后继续' : '已绑定教学会话' : '尚未绑定教学会话';
    for (const [key, field] of publicFields) field.input.checked = next.settings[key] === true;
    const previousPage = practicePage;
    practicePage = next.practicePage;
    const rendered = JSON.stringify([query, next.samples, next.practicePage, next.practiceTotal, next.practices, next.handbook]);
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
    records.append(el('summary', '最近练习 · ' + next.practiceTotal));
    const guide = el('p', '每页最多 3 条。点开一条，即可查看对话和复盘。');
    guide.className = 'sm-practice-guide';
    records.append(guide);
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
    handbook.append(el('summary', '说话手册'), el('p', '小K评估后留下的表达经验，可以按话题检索。你也可以手动收录或撤回。'));
    const search = el('input');
    search.type = 'search';
    search.value = query;
    search.placeholder = '按话题或表达技巧检索';
    handbook.append(search, action('检索', async () => {
      await refresh(search.value.trim());
      const rendered = list.lastElementChild as HTMLDetailsElement | null;
      if (rendered) rendered.open = true;
    }));
    for (const row of next.handbook) handbook.append(el('p', row.lesson + (row.source ? ' · ' + row.source : '')));
    if (!next.handbook.length) handbook.append(el('p', '没有匹配的已收录经验。'));
    list.append(handbook);
    [materials, records, handbook].forEach((details, i) => { details.open = opened[i] ?? false; });
  }
  const save = (key: keyof Snapshot['settings']) => async (value: boolean) => {
    await ctx.invoke('settings', [{ ['worlds.socialmedia.experiments.' + key]: value }]);
    await refresh();
  };
  const corpus = toggle('语料学习', false, save('corpus'));
  const practice = toggle('人格化练习', false, save('practice'));
  const training = toggle('开始训练', false, save('training'));
  const publicPosts = el('section');
  publicPosts.className = 'sm-public-posts';
  publicPosts.append(el('h3', '贴吧与小红书 · 公开帖试读（实验）'), el('p', '搜一个话题试试，或者直接粘贴原帖链接。小K也可以按你的话题搜帖，并在开启语料学习时收藏已读原文。试读仅查看官网当前展示的正文和评论，专用窗口登录或验证后的读取效果仍需实测。'));
  const publicCards = el('div');
  publicCards.className = 'sm-experiment-cards';
  publicPosts.append(publicCards);
  const publicFields = PUBLIC_POST_TRIAL_ENABLED ? (['tieba', 'xiaohongshu'] as const).map(key => {
    const label = key === 'tieba' ? '百度贴吧' : '小红书';
    const field = toggle('启用' + label + '（实验）', false, save(key));
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
    const result = el('pre');
    result.setAttribute('aria-live', 'polite');
    const matches = el('ul');
    matches.className = 'sm-public-matches';
    matches.setAttribute('aria-label', label + '搜索结果');
    const card = el('article');
    card.tabIndex = -1;
    let busy = false;
    const run = async (message: string, fn: () => Promise<void>) => {
      if (busy) return;
      if (!field.input.checked) {
        result.textContent = '请先启用' + label + '。';
        return;
      }
      busy = true;
      result.textContent = message;
      try { await fn(); }
      catch (error) { result.textContent = error instanceof Error ? error.message : '操作失败。'; }
      finally { busy = false; }
    };
    const readPost = () => run('正在读取原帖…', async () => {
      const address = url.value.trim();
      if (!address) throw Error('先粘贴完整原帖链接，或从搜索结果选一条。');
      const post = await ctx.invoke<{ title: string; text: string; comments: string[]; url: string; detail: string }>('expressionReadPost', [key, address]);
      result.textContent = [post.title, post.url, post.text, ...post.comments, post.detail].join('\n\n');
    });
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
      result.textContent = data.items.length ? '找到 ' + data.items.length + ' 条。点标题可试读。' : data.detail;
    }));
    query.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      searchButton.click();
    }, { signal: ctx.signal });
    searchRow.append(query, searchButton);
    card.append(el('h4', label), field.row,
      el('p', (key === 'tieba' ? '若贴吧弹出验证，请先在专用窗口处理。' : '小红书通常需要先在专用窗口登录。') +
        '完成后关闭窗口，再搜索或试读。'),
      action('打开' + label + '专用登录窗口', () => run('正在打开专用窗口…', async () => {
        const opened = await ctx.invoke<{ message: string }>('expressionPublicLogin', [key]);
        result.textContent = opened.message;
      })), searchRow, matches, url, action('读取' + label + '公开帖', readPost), result);
    publicCards.append(card);
    return [key, { ...field, card }] as const;
  }) : [];
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
  const learningCard = el('article');
  learningCard.append(corpus.row, el('p', '小K刷到有意思的公开帖子或评论时，可以摘一小段，学怎么接梗、说具体、表达不同意见。沿用闲逛阅读额度。小K筛选和整理时仍会用到当前模型。'));
  const practiceCard = el('article');
  practiceCard.append(practice.row,
    el('p', '实验性网页陪练。小K自己选话题和 Gemini 聊，再试试学到的表达。网页版限额、登录失效或页面变动都可能暂停练习。'),
    el('p', '开启「开始训练」后消耗较高，建议按需开启。'), controls);
  cards.append(learningCard, practiceCard);
  body.className = 'sm-experiment-body';
  if (PUBLIC_POST_TRIAL_ENABLED) body.append(publicPosts);
  body.append(cards, action('刷新练习与素材', () => refresh()), status, list);
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
    openPublic(platform: 'tieba' | 'xiaohongshu') {
      section.open = true;
      const card = publicFields.find(([key]) => key === platform)?.[1].card;
      card?.focus({ preventScroll: true });
      card?.scrollIntoView({ block: 'center' });
    },
  };
}
