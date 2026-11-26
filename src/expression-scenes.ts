export const CHAT_SCENES = {
  selfJoke: '拿自己开玩笑',
  praise: '夸奖或道谢',
  sharing: '分享刚做好的东西',
  frustration: '倾诉烦心事',
} as const;
export type ChatScene = keyof typeof CHAT_SCENES;

const cues: Record<ChatScene, RegExp> = {
  selfJoke: /(?:我(?:可真是|可真|简直是|真是个|这手艺|这水平)|被自己).{0,18}(?:笑|丑|菜|离谱|翻车|天才)|(?:笑死|哈哈).{0,16}(?:手残|翻车|画歪|糊了)|(?:手残|翻车|画歪|糊了).{0,12}(?:哈哈|笑死)/u,
  praise: /(?:多亏(?:你|有你)|谢(?:谢|啦|了)[你呀啊啦～！!，。 ]|你(?:可真|也太|真|好|太)(?:靠谱|贴心|厉害|会说|细心|棒)|幸好有你)/u,
  sharing: /(?:给你(?:看|瞧)|快来看|晒一下|看看我|瞅瞅我).{0,35}(?:做|搭|画|剪|拍|拼|烤|织|捏|修)|(?:刚|终于).{0,9}(?:完工|做好|搭好|画完|剪完|拼好|织好)/u,
  frustration: /(?:好烦|烦死|有点难过|好委屈|心里堵|累坏了|心情很差|有点沮丧|气死我了)/u,
};
export function chatScene(text:string):ChatScene|undefined{
  if(!text||text.length>320||/(?:转述|(?:他|她|同事|朋友)说|翻译|写一段|帮我改|这句话|验证码|密码|执行命令)/u.test(text))return;
  const matches=(Object.keys(cues) as ChatScene[]).filter(key=>cues[key].test(text));
  if(matches.length===1)return matches[0];
}
