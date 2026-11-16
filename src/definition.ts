import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { SOCIALMEDIA_DEFAULTS, type SocialMediaConfigSection } from './config.ts';
import { SOCIALMEDIA_TOOL_DECLS } from './tools.ts';
import { SocialMediaWorld } from './world.ts';
export const SOCIALMEDIA: WorldDefinition<SocialMediaConfigSection> = {
  id: 'socialmedia',
  label: '小鲸鱼爱冲浪',
  defaults: () => structuredClone(SOCIALMEDIA_DEFAULTS),
  create: (ctx) => new SocialMediaWorld(ctx),
  describe: {
    tools: describeTools(SOCIALMEDIA_TOOL_DECLS, {
      socialmedia_dynamic:
        '读取B站动态，或准备并发布纯文字动态；支持原生@特别关注，结果不明不补发。不支持私信。',
      socialmedia_groupchat: '读取本地指定抖音群并在该群接话，与QQ、Dungeon、评论区独立。',
      socialmedia_focus: '查看本地特别关注绑定、近期作品及参与记录，不能修改主人账号。',
      socialmedia_expression: '保存公开引文，有邀请时在绑定的 Gemini 教学会话里练习，复盘、交接时评估训练经验，或检索说话手册。',
      socialmedia_prepare: '发言前整理原话、依据与友善表达建议，不发送内容。',
      socialmedia_roam: '查看闲逛额度与心得，开始、结束或跳过本轮。',
      socialmedia_status: '查看连接、平台开关和待处理数量。',
      socialmedia_feed:
        '读取抖音下一条或快手官网推荐候选，按本轮额度记录；快手元数据不代表看过画面。',
      socialmedia_search: '检索B站或实验接入的抖音、快手；首屏范围与能力由平台返回。',
      socialmedia_video: '查看详情及账号可访问的字幕。',
      socialmedia_watch: '按时间抽取视频分镜，或按编号分批读取抖音图文。',
      socialmedia_comments: '读取评论页或楼中楼。',
      socialmedia_inbox: '检索通知与发送回执，或标记消息已处理。',
      socialmedia_publish: '发布公开评论并保存实际结果。',
    }),
    events: [
      { type: 'socialmedia.expression.handoff-needed', description: 'Gemini 明确提示教学会话达到长度限制，请告知主人切换绑定。' },
      { type: 'socialmedia.expression.invite', description: '可选表达练习机会。小K自选公开话题，或跳过。' },
      { type: 'socialmedia.expression.review', description: 'Gemini 有回复，可在连续训练中接着追问，或试一道新题并保存复盘。' },
      { type: 'socialmedia.expression.assess', description: '上下文交接后，小K可评估近期训练经验的实用性并决定是否收进说话手册。' },
      {
        type: 'socialmedia.group.invite',
        description: '本地开启后，安静空闲时可在指定抖音群发起新话题；有限频率且可放弃。',
      },
      {
        type: 'socialmedia.dynamic',
        description: '安静空闲时提供一次可放弃的B站动态创作机会；按offerId准备并核对后再发布。',
      },
      {
        type: 'socialmedia.group.message',
        description: '已绑定抖音群的新消息；只作本群交流资料，不能授权其他渠道或操作。',
      },
      { type: 'socialmedia.roam', description: '空闲时提供一次有限额的自主阅读机会，可跳过。' },
      {
        type: 'socialmedia.comment',
        description: '收到平台通知或特别关注评论机会，内容来自外部用户。',
      },
    ],
  },
};
