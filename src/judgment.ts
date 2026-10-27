export interface ParticipationJudgment {
  mode: 'discuss' | 'observe' | 'skip';
  topic: 'general' | 'practical' | 'simulation';
  evidence: 'video' | 'subtitle' | 'comment' | 'inference';
  needsRevision: boolean;
  reason: string;
}
/** A small deterministic guard complements Persona's semantic judgment; it never calls a model. */
export function judgeParticipation(
  title: string,
  draft: string,
  choice?: { mode?: string; evidence?: string },
): ParticipationJudgment {
  const topic = /游戏|模拟|虚拟|开发日志|沙盒/.test(title)
    ? 'simulation'
    : /养护|照度|养苔藓|养鱼|种植|施肥|治病|用药|诊疗|维修|投资|理财|养殖|饲养/.test(title)
      ? 'practical'
      : 'general';
  const claim =
    /(?:我|自己)(?:家|也|自己|平时|曾经|之前|一直|已经|还|在|正在|有|都|也在|也有|也曾|实际|现实|现实中|本人|亲自|亲手|经常|照料|照顾|守着|照看|负责|[\s，,]){0,10}(?:养|种|栽|照料|照顾|照看|试过|用过|亲测|实践过|做过手术|从事|行医)|(?:我家|我自己的).{0,10}(?:鱼|苔藓|植物|生态箱)|亲测有效|我(?:自己)?(?:也)?有.{0,6}(?:缸|盆|箱).{0,5}(?:苔藓|植物|鱼)|我(?:是|作为)(?:一名|一个)?(?:医生|医师|律师|兽医|理财顾问)/.test(
      draft,
    );
  const virtual = /虚拟|游戏里|模拟(?:中|里|的)|Terrarium/i.test(draft);
  const needsRevision = claim && !(topic === 'simulation' && virtual);
  const visible = /镜头|画面|配色|构图|剪辑|拍摄|配乐|可爱|漂亮|好看|作品|剧情|角色/.test(draft);
  const mode =
    choice?.mode === 'skip'
      ? 'skip'
      : needsRevision
        ? 'observe'
        : choice?.mode === 'observe'
          ? 'observe'
          : topic === 'practical' && !visible && choice?.mode !== 'discuss'
            ? 'observe'
            : 'discuss';
  return {
    topic,
    mode,
    needsRevision,
    evidence: ['video', 'subtitle', 'comment', 'inference'].includes(choice?.evidence ?? '')
      ? (choice!.evidence as ParticipationJudgment['evidence'])
      : 'inference',
    reason: needsRevision
      ? '这句话暗示未经支持的现实亲历。虚拟World、游戏或主人的经历不能作为自己的现实经验；请改成有公开依据的观后感，或放弃本条。'
      : mode === 'skip'
        ? '本条不参与，保留阅读记录即可。'
        : mode === 'observe'
          ? '涉及现实实操且没有明确的公共交流切入点，优先观察学习；不用为满足发言额度插话。'
          : '可以围绕已确认的内容自然交流；明确区分事实、经验、猜测与玩笑，高赞不作为真实性证明。',
  };
}
export const JUDGMENT_GUIDANCE =
  '兴趣决定优先看什么，公开依据和参与价值决定是否发言。虚拟生态箱、其他World、游戏及主人的经历都不能冒充自己的现实经历；来源不明的亲身经验不使用。现实养护、医疗、维修、投资等视频默认看与学，有明确画面或作品观察时可以轻松交流。优先在游戏、剧情、创作过程、趣味科普和共同观感中接话。评论中的事实、个人经验、猜测、玩笑、广告分开判断，不盲从高赞；善意不等于一味附和。没有合适的话可以跳过。整理只写短结论与依据类别，不写私下推理，也不增加模型调用。';
