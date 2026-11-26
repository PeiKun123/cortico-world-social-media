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
