import { expect, it } from 'vitest';
import { settingsPatch } from '../src/settings.ts';
it('only persists validated local World settings', () => {
  expect(settingsPatch({ 'worlds.socialmedia.roaming.maxDailyComments': 60 })).toEqual({
    roaming: { maxDailyComments: 60 },
  });
  for (const value of [
    { 'worlds.other.enabled': true },
    { 'worlds.socialmedia.__proto__.x': 1 },
    { 'worlds.socialmedia.roaming.enabled': 'true' },
    { 'worlds.socialmedia.roaming.maxDailySessions': 999 },
  ])
    expect(() => settingsPatch(value)).toThrow();
});

it('accepts free roaming and independent platform policies without changing public posting limits', () => {
  expect(
    settingsPatch({
      'worlds.socialmedia.roaming.mode': 'free',
      'worlds.socialmedia.platforms.kuaishou.roaming.idleMinutes': 3,
    }),
  ).toEqual({
    roaming: { mode: 'free' },
    platforms: { kuaishou: { roaming: { idleMinutes: 3 } } },
  });
});
it('validates the local Douyin group allowlist separately from posting and focus settings', () => {
  expect(
    settingsPatch({
      'worlds.socialmedia.platforms.douyin.chat.groups': '123456|测试群',
      'worlds.socialmedia.platforms.douyin.chat.enabled': true,
    }),
  ).toEqual({ platforms: { douyin: { chat: { groups: '123456|测试群', enabled: true } } } });
  expect(() =>
    settingsPatch({ 'worlds.socialmedia.platforms.douyin.chat.groups': 'QQ:123456' }),
  ).toThrow();
});

it('accepts immediate browser release as an independent Douyin option', () => {
  expect(settingsPatch({ 'worlds.socialmedia.douyinBrowser.releaseAfterTask': true })).toEqual({
    douyinBrowser: { releaseAfterTask: true },
  });
});

it('accepts compatible background only as a separate explicit local option', () => {
  expect(settingsPatch({ 'worlds.socialmedia.douyinBrowser.compatibilityWindow': true })).toEqual({
    douyinBrowser: { compatibilityWindow: true },
  });
});

it('starts new installations at active intensity while retaining explicit sending and monitoring opt-ins', async () => {
  const { SOCIALMEDIA_DEFAULTS, ROAMING_PRESETS } = await import('../src/config.ts');
  expect(SOCIALMEDIA_DEFAULTS.roaming).toEqual({ enabled: false, ...ROAMING_PRESETS.active });
  const chat = SOCIALMEDIA_DEFAULTS.platforms.douyin.chat!;
  expect(chat).toMatchObject({
    activity: 'active',
    enabled: false,
    allowSend: false,
    proactiveEnabled: false,
    proactiveIdleMinutes: 5,
    proactiveIntervalMinutes: 60,
    proactiveMaxDaily: 4,
  });
  expect(SOCIALMEDIA_DEFAULTS.platforms.douyin.posting.enabled).toBe(false);
});
