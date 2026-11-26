import { POST_PLATFORMS, profileId } from './public-post-policy.ts';
import { parseGroupList } from './group-policy.ts';
import { parseFocusAccount } from './focus.ts';
import { coerceGroupValues, setByPath } from 'cortico/core/config-schema.ts';
import { clockTime, SOCIALMEDIA_CONFIG_GROUP, type SocialMediaConfigSection } from './config.ts';
export function settingsPatch(input: unknown): Partial<SocialMediaConfigSection> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('设置格式无效');
  const raw = { ...input } as Record<string, unknown>,
    props = SOCIALMEDIA_CONFIG_GROUP.schema.properties;
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(props, key)) throw Error('不允许修改此设置：' + key);
    const p = props[key];
    if (key === 'worlds.socialmedia.focus.outsideReplyLimit' && !Number.isInteger(value))
      throw Error('主人通知回复额度须为 0–100 的整数，或 -1 表示不限次数。');
    if (['worlds.socialmedia.activeHours.start', 'worlds.socialmedia.activeHours.end'].includes(key) &&
        (typeof value !== 'string' || !clockTime.test(value))) throw Error('活跃时段请输入 24 小时制的 HH:mm');
    if (
      (p.type === 'boolean' && typeof value !== 'boolean') ||
      (p.type === 'string' && (typeof value !== 'string' || value.length > 2000))
    )
      throw Error(p.title + '格式无效');
  }
  const owner = raw['worlds.socialmedia.focus.account'];
  if (typeof owner === 'string' && owner.trim()) parseFocusAccount(owner);
  const douyinOwner = raw['worlds.socialmedia.platforms.douyin.focus.account'];
  if (typeof douyinOwner === 'string' && douyinOwner.trim())
    parseFocusAccount(douyinOwner, 'douyin');
  for (const platform of POST_PLATFORMS) {
    const field = 'worlds.socialmedia.platforms.' + platform + '.focus.account';
    const address = raw[field];
    if (typeof address === 'string' && address.trim()) {
      const profile = profileId(platform, address);
      if (!profile) throw Error('请贴平台官网的完整个人主页链接。');
      raw[field] = profile.url.href;
    }
  }
  const groups = raw['worlds.socialmedia.platforms.douyin.chat.groups'];
  if (typeof groups === 'string') parseGroupList(groups);
  const checked = coerceGroupValues(SOCIALMEDIA_CONFIG_GROUP, raw);
  if ('error' in checked) throw Error(checked.error);
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(checked.values))
    setByPath(patch, key.slice('worlds.socialmedia.'.length), value);
  return patch;
}
