export interface GroupConfig {
  activity?: 'quiet' | 'balanced' | 'active';
  proactiveEnabled?: boolean;
  proactiveIntervalMinutes?: number;
  proactiveMaxDaily?: number;
  proactiveIdleMinutes?: number;
  enabled: boolean;
  allowSend: boolean;
  groups: string;
  intervalSec: number;
  minIntervalSec: number;
  maxDailyMessages: number;
}
export const GROUP_DEFAULTS: GroupConfig = {
  activity: 'active',
  proactiveEnabled: false,
  proactiveIntervalMinutes: 60,
  proactiveMaxDaily: 4,
  proactiveIdleMinutes: 5,
  enabled: false,
  allowSend: false,
  groups: '',
  intervalSec: 60,
  minIntervalSec: 30,
  maxDailyMessages: 100,
};
export function parseGroupList(raw: string): Array<{ id: string; name: string }> {
  const lines = raw
    .split(/[\r\n;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length > 10) throw Error('最多监听十个群');
  const seen = new Set<string>();
  return lines.map((line) => {
    const [id, name, ...extra] = line.split(/[|｜]/).map((s) => s.trim());
    if (!/^\d{6,30}$/.test(id) || extra.length || !name || name.length > 80 || seen.has(id))
      throw Error('每行填写 群号|准确群名，群号不可重复');
    seen.add(id);
    return { id, name };
  });
}

export function groupActivityGuidance(activity: GroupConfig['activity']) {
  return activity === 'active'
    ? '本群为活跃档：更愿意接普通接话、提问、分享和轻松玩笑，不必等别人@。结合本批原话给一条自然回应即可，连续碎片合成一句；有人刚说过同样意思就不重复，不强行插话或连续自言自语。'
    : activity === 'quiet'
      ? '本群为安静档：优先回应明确@、直接提问或你已参与的对话，其他闲聊可以只听。'
      : '本群为均衡档：可以接感兴趣的话题或回应提问，不必每条回复。';
}
