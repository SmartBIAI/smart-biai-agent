import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { runConversationAgent } from '../agent.mjs';
import { planAgent } from '../integrations.mjs';
import { imageModels, models, imageParameters, videoParameters } from '../generation-models.js';

const call=(tool,args)=>({tool,arguments:args});
const respond=()=>({calls:[call('respond',{text:'请检查草稿并确认。',memory:'保留原参考素材及用户要求。'})]});
function harness() {
  const now=Date.UTC(2026,10,18,6),image=imageModels.find(model=>model.id==='smartbiai-gpt-img-2-6-sunburst');
  const targetImage=imageModels.find(model=>model.id==='smartbiai-gpt-img-2');
  const file={id:randomUUID(),name:'reference.jpg',size:128,type:'image'};
  const source={id:randomUUID(),mode:'live',status:'failed',credits:99,error:'生成失败',parameters:{model:image.id,prompt:'原始产品使用场景描述，保留参考图片中的外观。',n:2,size:image.sizes[0],quality:image.qualities[0],references:[],fileIds:[file.id],maskFileId:null},results:[]};
  const video={id:randomUUID(),mode:'live',status:'completed',url:'https://example.com/result.mp4',expiresAt:now+7*86400000,parameters:{model:models[0].id,prompt:'原始产品短片描述',ratio:'9:16',resolution:'720p',duration:6,audio:false,fileIds:[],references:[]}};
  const conversation={id:randomUUID(),revision:1,chat:[{type:'user',text:'之前的创作',files:[file]},{type:'text',text:'旧回复可能不准确'},{type:'image-result',id:source.id},{type:'user',text:'继续处理当前创作'}],drafts:[]};
  const resources=new Map([[`image:${source.id}`,source],[`video:${video.id}`,video]]),fileMap=new Map([[file.id,file]]);
  const quotes=[],accesses=[],contexts=[];let steps=[];
  const dependencies={
    uuid:randomUUID,models:async kind=>kind==='image'?imageModels:models,
    task:async(kind,id,refresh)=>{accesses.push({kind,id,refresh});const item=resources.get(`${kind}:${id}`);if(!item)throw Error('任务不存在');return structuredClone(item);},
    list:async kind=>[...resources].filter(([key])=>key.startsWith(kind+':')).map(([,item])=>structuredClone(item)),
    file:async id=>fileMap.get(id),accounts:async({id}={})=>({accounts:[{id:'101',name:'授权账号',authStatus:20,canPublish:true},{id:'102',name:'未授权账号',authStatus:10}].filter(item=>!id||item.id===id)}),
    quote:async(kind,body)=>{quotes.push(structuredClone(body));return {parameters:kind==='image'?imageParameters(body,imageModels):videoParameters(body,models,true),credits:kind==='image'?body.n*7:13};},
    plan:async state=>{contexts.push(structuredClone(state));return steps.length?typeof steps[0]==='function'?steps.shift()(state):steps.shift():respond();}
  };
  return {now,image,targetImage,file,fileMap,source,video,conversation,resources,quotes,accesses,contexts,dependencies,setSteps:value=>{steps=value;},
    run:()=>runConversationAgent({conversation,message:conversation.chat.at(-1).text,mode:'live',now,zone:'UTC'},dependencies)};
}

test('a failed image can branch to another model while retaining prompt, count and original attachment IDs',async()=>{
  const h=harness(),before=structuredClone(h.source);
  h.setSteps([{calls:[call('get_task',{target:{kind:'image',id:h.source.id},refresh:true})]},
    {calls:[call('prepare_generation',{kind:'image',source:{kind:'image',id:h.source.id},changes:{model:h.targetImage.id}})]}]);
  const result=await h.run(),draft=result.drafts[0];
  assert.notEqual(draft.id,h.source.id);assert.equal(draft.parameters.model,h.targetImage.id);
  assert.equal(draft.parameters.prompt,before.parameters.prompt);assert.equal(draft.parameters.n,2);
  assert.deepEqual(draft.parameters.fileIds,[h.file.id]);assert.equal(draft.files[0].id,h.file.id);
  assert.equal(draft.credits,14);assert.equal(h.quotes.length,1);assert.deepEqual(h.source,before);
  assert.deepEqual(draft.source,{kind:'image',id:h.source.id});assert.ok(result.observations.find(step=>step.tool==='prepare_generation').result.requiresConfirmation);
  assert.ok(result.chat.findIndex(entry => entry.agent && entry.type === 'text') < result.chat.findIndex(entry => entry.type === 'image-generation' && entry.id === draft.id));
  assert.ok(h.contexts[1].observations[0].result.status==='failed');
  assert.ok(h.contexts[0].context.history.some(entry=>entry.role==='assistant'));
});

test('editing an unconfirmed draft updates that card and invalidates its previous quote',async()=>{
  const h=harness(),id=randomUUID();h.conversation.chat.splice(-1,0,{type:'image-generation',id});
  h.conversation.drafts.push({id,kind:'image',parameters:{...h.source.parameters,fileIds:undefined},links:[],files:[h.file],credits:99});
  h.setSteps([{calls:[call('prepare_generation',{kind:'image',source:{kind:'draft',id},changes:{n:3}})]}]);
  const result=await h.run();assert.equal(result.drafts.length,1);assert.equal(result.drafts[0].id,id);
  assert.equal(result.drafts[0].credits,21);assert.deepEqual(h.quotes[0].fileIds,[h.file.id]);
  assert.equal(result.chat.filter(entry=>entry.type==='image-generation'&&entry.id===id).length,1);
  assert.ok(result.chat.findIndex(entry=>entry.type==='image-generation'&&entry.id===id)>result.chat.findLastIndex(entry=>entry.type==='user'));
});

test('unknown and active tasks cannot be used to create a duplicate attempt',async()=>{
  for(const status of ['queued','submitting','generating','review','unknown']){
    const h=harness();h.source.status=status;
    h.setSteps([{calls:[call('prepare_generation',{kind:'image',source:{kind:'image',id:h.source.id},changes:{model:h.targetImage.id}})]}]);
    const result=await h.run();assert.equal(result.changedIds.length,0,status);assert.equal(h.quotes.length,0,status);
    assert.equal(result.observations[0].ok,false,status);
  }
});

test('missing original files fail without silently dropping references',async()=>{
  const h=harness();h.fileMap.clear();h.setSteps([{calls:[call('prepare_generation',{kind:'image',source:{kind:'image',id:h.source.id},changes:{}})]}]);
  const result=await h.run();assert.equal(result.changedIds.length,0);assert.equal(h.quotes.length,0);
  assert.ok(result.observations[0].error.includes('附件'));
});

test('reference replacement is explicit and preserves unrelated source parameters',async()=>{
  const h=harness(),file={id:randomUUID(),name:'new.png',type:'image',size:64};h.fileMap.set(file.id,file);h.conversation.chat.at(-1).files=[file];
  h.setSteps([{calls:[call('prepare_generation',{kind:'image',source:{kind:'image',id:h.source.id},changes:{prompt:'新的场景，其余参数保留。'},attachments:{mode:'replace',ids:[file.id]}})]}]);
  const result=await h.run();assert.deepEqual(result.drafts[0].parameters.fileIds,[file.id]);
  assert.equal(result.drafts[0].parameters.n,h.source.parameters.n);assert.deepEqual(h.source.parameters.fileIds,[h.file.id]);
});

test('incompatible masks require an explicit decision and cross-family image specs adapt to supported choices',async()=>{
  const h=harness(),mask={id:randomUUID(),name:'mask.png',type:'image',size:64},banana=imageModels.find(model=>model.id==='smartbiai-banana');
  h.fileMap.set(mask.id,mask);h.source.parameters.maskFileId=mask.id;
  h.setSteps([{calls:[call('prepare_generation',{kind:'image',source:{kind:'image',id:h.source.id},changes:{model:banana.id}})]},
    {calls:[call('prepare_generation',{kind:'image',source:{kind:'image',id:h.source.id},changes:{model:banana.id},attachments:{mode:'inherit',maskId:null}})]}]);
  const result=await h.run();assert.equal(result.observations[0].ok,false);
  assert.equal(result.drafts.length,1);assert.equal(result.drafts[0].parameters.maskFileId,null);
  assert.ok(banana.ratios.includes(result.drafts[0].parameters.ratio));assert.ok(result.drafts[0].notes.length);
  assert.ok(result.drafts[0].notes.some(note=>note.includes('蒙版')));
  assert.equal(h.source.parameters.maskFileId,mask.id);
});

test('cross-conversation tasks are unavailable until an explicit workspace lookup associates them',async()=>{
  const h=harness();
  h.setSteps([{calls:[call('get_task',{target:{kind:'video',id:h.video.id}})]},
    {calls:[call('list_tasks',{kind:'video',scope:'workspace'})]},
    {calls:[call('get_task',{target:{kind:'video',id:h.video.id},show:true})]}]);
  const result=await h.run();assert.equal(result.observations[0].ok,false);assert.equal(result.observations[2].ok,true);
  assert.equal(h.accesses.filter(entry=>entry.id===h.video.id).length,1);
  assert.ok(result.chat.some(entry=>entry.targets?.some(ref=>ref.id===h.video.id)));
  assert.ok(result.chat.some(entry=>entry.type==='result'&&entry.id===h.video.id));
});

test('publishing tools only prepare confirmation drafts and require an authorized account and valid schedule',async()=>{
  const h=harness();h.conversation.chat.splice(-1,0,{type:'result',id:h.video.id});
  h.setSteps([{calls:[call('prepare_publication',{source:{kind:'video',id:h.video.id},changes:{accountId:'102',title:'产品视频'}})]},
    {calls:[call('prepare_publication',{source:{kind:'video',id:h.video.id},changes:{accountId:'101',title:'产品视频',mode:'scheduled',zone:'UTC',planned:'2026-11-19T10:00'}})]}]);
  const result=await h.run();assert.equal(result.observations[0].ok,false);assert.equal(result.drafts.length,1);
  const draft=result.drafts[0];assert.equal(draft.generationId,h.video.id);assert.equal(draft.planned,'2026-11-19T10:00');
  assert.equal(result.chat.filter(entry=>entry.type==='confirmed').length,0);assert.equal(result.observations[1].result.requiresConfirmation,true);
  assert.equal(h.quotes.length,0);
});

test('expired publication inputs and already confirmed pending publication tasks cannot be duplicated',async()=>{
  const h=harness(),publication={id:randomUUID(),generationId:h.video.id,status:'scheduled',accountId:'101',title:'已有预约'};
  h.resources.set(`publication:${publication.id}`,publication);h.conversation.chat.splice(-1,0,{type:'confirmed',id:publication.id},{type:'result',id:h.video.id});
  h.setSteps([{calls:[call('prepare_publication',{source:{kind:'publication',id:publication.id},changes:{planned:'2026-11-19T10:00'}})]},
    {calls:[call('prepare_publication',{source:{kind:'video',id:h.video.id},changes:{mode:'scheduled',planned:'2026-11-17T10:00',zone:'UTC'}})]}]);
  const result=await h.run();assert.equal(result.changedIds.length,0);assert.ok(result.observations.every(step=>!step.ok));
});

test('a completed image result can be explicitly used as a video reference',async()=>{
  const h=harness();h.source.status='completed';h.source.results=[{url:'https://example.com/generated.png',status:'succeeded',expiresAt:h.now+86400000}];
  h.setSteps([{calls:[call('prepare_generation',{kind:'video',source:{kind:'image',id:h.source.id},changes:{model:models[0].id,prompt:'让已完成画面自然运动。'},outputs:[{target:{kind:'image',id:h.source.id},index:0,role:'first_frame'}]})]}]);
  const result=await h.run();assert.equal(result.drafts.length,1);
  assert.deepEqual(result.drafts[0].parameters.references,[{type:'image',url:'https://example.com/generated.png',role:'first_frame'}]);
});

test('unsupported execution tools cannot submit media, publish, change credentials, or loop without a budget',async()=>{
  const h=harness();let invoked=0;h.dependencies.create=()=>{invoked++;};
  h.dependencies.plan=async()=>({calls:[call('create_generation',{}),call('publish',{}),call('change_settings',{})]});
  const result=await h.run();assert.equal(invoked,0);assert.equal(h.quotes.length,0);assert.equal(result.changedIds.length,0);
  assert.equal(result.observations.length,10);
});

test('DeepSeek and Doubao receive structured conversation state and return tool plans without keyword normalization',async()=>{
  const original=globalThis.fetch;
  try{
    for(const provider of ['deepseek','doubao']){
      let input;
      globalThis.fetch=async(url,options)=>{const body=JSON.parse(options.body);input=JSON.parse(provider==='deepseek'?body.messages[0].content:body.input[0].content);const text=JSON.stringify({calls:[call('get_task',{target:{kind:'image',id:'stored-task'},refresh:true})]});return new Response(JSON.stringify(provider==='deepseek'?{stop_reason:'end_turn',content:[{type:'text',text}]}:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]}));};
      const result=await planAgent({provider,key:'test-key',model:'test-model'},{context:{message:'保持其余设置，接着处理当前这项创作。',resources:[{kind:'image',id:'stored-task',status:'failed'}]},observations:[]});
      assert.equal(result.calls[0].tool,'get_task');assert.equal(input.context.resources[0].status,'failed');assert.ok(input.tools.some(tool=>tool.name==='prepare_generation'));
    }
  }finally{globalThis.fetch=original;}
});

test('the planner must observe a mutation failure before sending a final response',async()=>{
  const h=harness();
  h.setSteps([{calls:[call('prepare_generation',{kind:'image',source:{kind:'image',id:h.source.id},changes:{model:'not-authorized'}}),call('respond',{text:'提前声称完成'})]},
    state=>{assert.ok(state.observations.some(step=>!step.ok));return {calls:[call('respond',{text:'请选择已授权模型后继续。'})]};}]);
  const result=await h.run();assert.equal(result.drafts.length,0);assert.equal(result.message,'请选择已授权模型后继续。');
});

test('restoring a stale draft that was already confirmed makes it read-only and creates a separate attempt',async()=>{
  const h=harness();h.conversation.chat.splice(-1,0,{type:'image-generation',id:h.source.id});
  h.conversation.drafts.push({id:h.source.id,kind:'image',parameters:{...h.source.parameters},files:[h.file],links:[],credits:5});
  h.setSteps([state=>{
    assert.ok(!state.context.resources.some(item=>item.kind==='draft'&&item.id===h.source.id));
    return {calls:[call('prepare_generation',{kind:'image',source:{kind:'image',id:h.source.id},changes:{model:h.targetImage.id}})]};
  }]);
  const result=await h.run();assert.equal(result.drafts.length,1);assert.notEqual(result.drafts[0].id,h.source.id);
  assert.ok(result.chat.some(entry=>entry.type==='image-result'&&entry.id===h.source.id));
});

test('repeated preparatory plans reuse the same new draft and quote instead of multiplying attempts',async()=>{
  const h=harness();const action=call('prepare_generation',{kind:'image',source:{kind:'image',id:h.source.id},changes:{model:h.targetImage.id}});
  h.setSteps([{calls:[action]},{calls:[structuredClone(action)]},{calls:[structuredClone(action)]}]);
  const result=await h.run();assert.equal(result.drafts.length,1);assert.equal(h.quotes.length,1);assert.equal(result.changedIds.length,1);
});

test('elapsed-time limits preserve a prepared draft without invoking another planning request',async()=>{
  const h=harness();let elapsed=0,plans=0;h.dependencies.clock=()=>elapsed;
  h.dependencies.plan=async()=>{plans++;return {calls:[call('prepare_generation',{kind:'image',source:{kind:'image',id:h.source.id},changes:{}})]};};
  const quote=h.dependencies.quote;h.dependencies.quote=async(...args)=>{const result=await quote(...args);elapsed=91000;return result;};
  const result=await h.run();assert.equal(plans,1);assert.equal(result.drafts.length,1);assert.equal(result.drafts[0].credits,14);
});
