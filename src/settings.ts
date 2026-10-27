import { parseGroupList } from './group-policy.ts';
import { parseFocusAccount } from './focus.ts';
import { coerceGroupValues, setByPath } from 'cortico/core/config-schema.ts';
import { SOCIALMEDIA_CONFIG_GROUP, type SocialMediaConfigSection } from './config.ts';
export function settingsPatch(input: unknown): Partial<SocialMediaConfigSection> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('设置格式无效');
  const raw = input as Record<string, unknown>,
    props = SOCIALMEDIA_CONFIG_GROUP.schema.properties;
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(props, key)) throw Error('不允许修改此设置：' + key);
    const p = props[key];
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
  const kuaishouOwner = raw['worlds.socialmedia.platforms.kuaishou.focus.account'];
  if (typeof kuaishouOwner === 'string' && kuaishouOwner.trim())
    parseFocusAccount(kuaishouOwner, 'kuaishou');
  const groups = raw['worlds.socialmedia.platforms.douyin.chat.groups'];
  if (typeof groups === 'string') parseGroupList(groups);
  const checked = coerceGroupValues(SOCIALMEDIA_CONFIG_GROUP, raw);
  if ('error' in checked) throw Error(checked.error);
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(checked.values))
    setByPath(patch, key.slice('worlds.socialmedia.'.length), value);
  return patch;
}
