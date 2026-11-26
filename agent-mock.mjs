import { interpret } from './mock.mjs';

// Offline mode exercises the same tools and confirmation flow without calling an AI service.
// Semantic planning in live mode is provided by DeepSeek/Doubao, not this simulation adapter.
export function mockAgentPlanner(message, command) {
  return async ({ observations }) => {
    if (observations.length) {
      const last = observations.at(-1);
      if (last.ok && last.tool === 'prepare_automation') {
        const text = last.result?.kind === 'draft' && !last.result.ready
          ? '请继续补充草稿中列出的信息。'
          : '请检查任务卡片并确认设置。';
        return { calls: [{ tool: 'respond', arguments: { text } }] };
      }
      return {calls:[{tool:'respond',arguments:{text:last.ok ? last.result?.requiresConfirmation ? '草稿已准备，请检查参数、附件和报价后确认。' : '已查询演示数据。' : last.error}}]};
    }
    if (command) return {calls:[command]};
    const intent = interpret(message);
    if (intent.generate || intent.generateImage) return {calls:[{tool:'prepare_generation',arguments:{kind:intent.generateImage?'image':'video',changes:{prompt:message,...(intent.model?{model:intent.model}:{}),...(intent.generateImage?{n:intent.n}: {ratio:intent.ratio,duration:intent.duration})}}}]};
    if (intent.query) return {calls:[{tool:'list_accounts',arguments:{...(intent.targetId?{id:intent.targetId}:{}),...(intent.platform?{platform:intent.platform}:{}),...(intent.country?{country:intent.country}:{})}}]};
    if (intent.imageQuery || intent.taskQuery) return {calls:[{tool:'list_tasks',arguments:{kind:intent.imageQuery?'image':'publication',scope:'workspace'}}]};
    return {calls:[{tool:'respond',arguments:{text:'离线模拟可体验查询、草稿和确认流程；也可以点击生成结果上的“调整参数”复用已有创作。自由表达的多轮理解请配置对话 AI 并使用真实模式。'}}]};
  };
}
