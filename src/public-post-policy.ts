export const POST_PLATFORMS = ['tieba', 'xiaohongshu'] as const;
export type PublicPostPlatform = typeof POST_PLATFORMS[number];
export const PUBLIC_POST_NAMES = { tieba: '百度贴吧', xiaohongshu: '小红书' } as const;
export const PUBLIC_POST_TYPES = { tieba: 4, xiaohongshu: 5 } as const;
export const POST_ORIGINS = { tieba: 'https://tieba.baidu.com', xiaohongshu: 'https://www.xiaohongshu.com' } as const;
export const POST_VISUAL_LEVELS = {
  low: { images: 1, video: 2 },
  medium: { images: 3, video: 5 },
  high: { images: 6, video: 9 },
} as const;
export type PostVisualLevel = keyof typeof POST_VISUAL_LEVELS;
export const isPublicPostPlatform = (value: unknown): value is PublicPostPlatform =>
  value === 'tieba' || value === 'xiaohongshu';

export function tiebaForumUrl(input: string) {
  const candidate = input.trim();
  const link = URL.parse(candidate);
  if (link && (link.origin !== POST_ORIGINS.tieba || link.pathname !== '/f' || link.username || link.password))
    throw Error('请填写贴吧吧名或 tieba.baidu.com 的吧首页链接。');
  const name = (link ? link.searchParams.get('kw') ?? '' : candidate.replace(/吧$/, '')).trim();
  if (!name || name.length > 60 || /[\u0000-\u001f/\\?#:]/u.test(name))
    throw Error('请填写有效的贴吧吧名或官网吧首页链接。');
  const url = new URL('/f', POST_ORIGINS.tieba);
  url.searchParams.set('kw', name);
  return { name, url };
}

export function tiebaForumNames(input: string) {
  const names = [...new Set(input.split(/[,，、;；\r\n]+/).map(part => part.trim()).filter(Boolean)
    .map(part => tiebaForumUrl(part).name))];
  if (names.length > 12) throw Error('最多填写 12 个常逛的吧。');
  return names;
}

export function profileUrl(platform: PublicPostPlatform, id: string) {
  const url = new URL(platform === 'tieba' ? '/home/main' : '/user/profile/' + id, POST_ORIGINS[platform]);
  if (platform === 'tieba') url.searchParams.set('id', id);
  return url;
}

export function profileId(platform: PublicPostPlatform, input: string, keepQuery = false) {
  const url = URL.parse(input);
  const id = platform === 'tieba'
    ? url?.pathname === '/home/main' && (url.searchParams.get('id') || url.searchParams.get('un'))
    : url?.pathname.match(/^\/user\/profile\/([a-f0-9]{24})\/?$/i)?.[1];
  if (!url || url.origin !== POST_ORIGINS[platform] || url.username || url.password ||
      typeof id !== 'string' || !id.trim() || id.length > 96 || /[\x00-\x1f]/.test(id)) return;
  // Retain the user-supplied profile selector, never a routing token, in saved settings.
  const clean = profileUrl(platform, id);
  if (platform === 'tieba' && !url.searchParams.has('id')) {
    clean.searchParams.delete('id');
    clean.searchParams.set('un', id);
  }
  if (keepQuery && platform === 'xiaohongshu') clean.search = url.search;
  return { id, url: clean };
}
