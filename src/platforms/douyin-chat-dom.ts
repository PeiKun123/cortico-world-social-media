import type { GroupMessage } from '../group-chat.ts';
/** Read only the selected conversation's rendered message models. Long IDs stay strings. */
export const GROUP_MESSAGES_SOURCE = String.raw`(()=>{
 const rows=[];
 for(const node of [...document.querySelectorAll('[class*="messageMessageBoxmessageBox"]')].slice(0,160)){
  const key=Object.keys(node).find(k=>k.startsWith('__reactFiber'));let f=node[key],m;
  for(let depth=0;f&&depth<5;depth++,f=f.return)if(f.memoizedProps?.message){m=f.memoizedProps.message;break;}
  if(!m)continue;
  const sid=m.serverId,cid=m.conversationId,sender=m.secSender;
  if(typeof sid!=='string'||!/^\d+$/.test(sid)||sid==='0'||typeof cid!=='string'||typeof sender!=='string')continue;
  let parsed=m._parsedContent;
  if(!parsed){try{parsed=JSON.parse(m.content);}catch{parsed={};}}
  const system=Number(m.type)===1001;
  const text=typeof parsed.text==='string'?parsed.text:system?(node.querySelector('[class*="fullRowContent"]')?.textContent||''):'';
  const name=node.querySelector('[class*="MessageTitleavatarName"]')?.textContent?.trim()||'';
  const at=m.createdAt instanceof Date?m.createdAt.getTime():0;
  rows.push({id:sid,conversationId:cid,senderId:sender,sender:name,text:text.slice(0,1500),time:at,system,serverStatus:m.serverStatus});
 }
 return rows;
})()`;
export interface DouyinMessage extends GroupMessage {
  conversationId: string;
  serverStatus: number;
}
