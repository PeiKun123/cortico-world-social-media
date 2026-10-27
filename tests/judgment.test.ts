import { expect, it } from 'vitest';
import { judgeParticipation } from '../src/judgment.ts';
it('does not turn a simulated moss tank or the owner experience into real-life credentials', () => {
  for (const text of [
    '我自己也在照料一小缸苔藓，想交流经验',
    '我家养的鱼也是这样',
    '我试过这个药，亲测有效',
    '我也有一缸苔藓',
    '我作为一名医生建议用药',
  ])
    expect(judgeParticipation('苔藓养护与照度', text).needsRevision, text).toBe(true);
  expect(judgeParticipation('苔藓养护与照度', '我觉得这段微距镜头很漂亮').mode).toBe('discuss');
});
it('keeps interests readable and permits clearly virtual discussion in simulation topics', () => {
  expect(judgeParticipation('如何正确养苔藓', '想跟大家交流养护经验').mode).toBe('observe');
  expect(
    judgeParticipation('生态模拟游戏开发日志', '在虚拟生态箱里，我养过苔藓，模拟规则很有趣')
      .needsRevision,
  ).toBe(false);
  expect(judgeParticipation('动画制作花絮', '这个小动作好可爱').mode).toBe('discuss');
});
