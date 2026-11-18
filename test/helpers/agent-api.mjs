import { runConversationAgent, agentProtocol } from '../../agent.mjs';
import { mockAgentPlanner } from '../../agent-mock.mjs';
import { accounts, models, imageModels } from '../../mock.mjs';
import { imageParameters, videoParameters, mockVideoCredits } from '../../generation-models.js';

// Browser-compatible persistence adapter for the same Agent tools used by UI tests.
export async function mockAgentTurn(data, body, { now=Date.now, planner, current=()=>data }={}) {
  const fail=message=>{throw Object.assign(new Error(message),{status:409});};
  const signature=JSON.stringify({conversationId:body.conversationId,message:body.message,fileIds:body.fileIds||[],command:body.command||null});
  const previous=(data.agentTurns||[]).find(turn=>turn.id===body.turnId);
  const findConversation=value=>value.conversations.find(item=>item.id===body.conversationId);
  if(previous){if(previous.signature!==signature)fail('该轮编号已用于另一项请求。');return {data,response:{protocol:agentProtocol,conversation:findConversation(data),updates:previous.updates}};}
  const snapshot=findConversation(data);
  if(!snapshot||snapshot.revision!==body.revision)fail('对话已有更新，请重新操作。');
  if(snapshot.chat.at(-1)?.type!=='user'||snapshot.chat.at(-1).text!==body.message)fail('请先保存本条消息。');
  const resource=async(kind,id)=>{
    const item=data[kind==='image'?'images':kind==='video'?'generations':'publications'].find(item=>item.id===id);
    if(!item)throw new Error('找不到这条记录。');
    return {...item,source:data.agentLineage?.[id]||null};
  };
  const result=await runConversationAgent({conversation:snapshot,message:body.message,fileIds:body.fileIds||[],mode:'mock',now:now(),
    memory:(data.agentTurns||[]).filter(turn=>turn.conversationId===body.conversationId).at(-1)?.memory||''}, {
    models:async kind=>kind==='image'?imageModels:models,
    task:resource,list:async kind=>data[kind==='image'?'images':kind==='video'?'generations':'publications'],
    file:async id=>{
      const files=data.conversations.flatMap(conversation=>[...conversation.chat.flatMap(entry=>entry.files||[]),...conversation.drafts.flatMap(draft=>draft.files||[])]);
      const file=files.find(file=>file.id===id);
      return file?{...file,type:/\.(jpg|jpeg|png|webp)$/i.test(file.name)?'image':/\.(mp4|mov)$/i.test(file.name)?'video':'audio'}:null;
    },
    accounts:async filters=>({accounts:accounts.filter(account=>(!filters.id||account.id===filters.id)&&(!filters.platform||account.platform===filters.platform)&&(!filters.country||account.country===({US:'美国',GB:'英国'}[filters.country]||filters.country))&&(!filters.keyword||`${account.name} ${account.alias}`.includes(filters.keyword))),limited:false}),
    quote:async(kind,parameters)=>({parameters:kind==='image'?imageParameters(parameters,imageModels):videoParameters(parameters,models,true),credits:kind==='image'?parameters.n*5:mockVideoCredits(parameters)}),
    outputUrl:url=>new URL(url,'https://demo.invalid/').href,
    plan:planner||mockAgentPlanner(body.message,body.command)
  });
  const latest=current();
  if(findConversation(latest)?.revision!==body.revision)fail('对话已有更新，请基于最新记录继续。');
  for(const id of result.changedIds)if(['images','generations','publications'].some(group=>latest[group].some(item=>item.id===id)))fail('该草稿已确认，请先刷新记录。');
  const updated={...snapshot,chat:result.chat,drafts:result.drafts,revision:snapshot.revision+1,updated:now()};
  latest.conversations=latest.conversations.map(item=>item.id===updated.id?updated:item);
  latest.agentLineage ||= {};
  for(const id of result.changedIds)latest.agentLineage[id]=result.drafts.find(item=>item.id===id)?.source||null;
  latest.agentTurns=[...(latest.agentTurns||[]),{id:body.turnId,conversationId:updated.id,signature,memory:result.memory,updates:result.updates}].slice(-24);
  return {data:latest,response:{protocol:agentProtocol,conversation:updated,updates:result.updates,turnId:body.turnId}};
}
