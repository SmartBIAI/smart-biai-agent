const ratios = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'];

export function explicitMediaIntent(message) {
  const text = String(message || '').split(/[，,。；;\n]/).filter(part => !/^\s*(?:请)?(?:不要|不用|不必|无需|别|不想|不需要)/.test(part)).join('，');
  if (!text.trim()) return null;
  if (/^(?:请|帮我|给我|麻烦)*(?:查看|查询|打开|找出).*(?:图片|图像|生图|海报)/.test(text) &&
      !/[，,。；;](?:请|帮我)?(?:生成|制作|画)/.test(text)) return 'image-query';
  const target = text.replace(/视频(?:的)?封面(?:图片|图)?/g, '封面图');
  const action = '(?:生成|制作|创作|设计|绘制|画|做|生|转成|转为|转换成|转换为)';
  const image = /文生图|(?:^|[^视])生图/.test(target) || new RegExp(action + '[^，,。；;\\n]{0,80}?(?:图片|图像|海报|封面|插画|头像|产品图|商品图|宣传图|张图|幅图)').test(target);
  let video = /图生视频|文生视频/.test(target) || new RegExp(action + '[^，,。；;\\n]{0,80}?(?:视频|短片|影片|动画)').test(target);
  if (image && /(?:[一二两三四五六七八1-8]|几)[张幅]/.test(target) &&
      /(?:用于|用作|作为)[^，,。；;\n]*视频/.test(target) && !/(?:同时|再生成|并生成|一段视频|一条视频)/.test(target)) video = false;
  return image === video ? null : image ? 'image' : 'video';
}

export function normalizeGenerationIntent(message, intent) {
  const target = explicitMediaIntent(message);
  if (!target) return intent;
  if (target === 'image-query') return { ...intent, generate: false, generateImage: false, imageQuery: true, publish: false, taskQuery: false, query: false };
  const image = target === 'image';
  const wrongFlow = image ? intent.generate === true || intent.generateImage !== true : intent.generateImage === true || intent.generate !== true;
  return { ...intent, generate: !image, generateImage: image, imageQuery: false,
    ...(wrongFlow ? { prompt: message.trim(), taskQuery: false, query: false, ...(image ? { publish: false } : {}) } : {}) };
}

const standard = {
  resolutions: ['480p', '720p'], aspect_ratios: ratios, min_duration: 4, max_duration: 15,
  supports_audio: true, supports_text_only: true, supports_auto_duration: true, supports_last_frame: true,
  reference_types: ['image', 'video', 'audio'], reference_roles: ['first_frame', 'last_frame', 'reference_image', 'reference_video', 'reference_audio'],
  max_references: 15, max_images: 9, max_videos: 3, max_audios: 3, min_prompt_length: 1, max_prompt_length: 20000
};
const discrete = {
  ...standard, resolutions: ['720p'], aspect_ratios: ['9:16'], min_duration: 5,
  durations: Array.from({ length: 11 }, (_, i) => i + 5), supports_auto_duration: false, supports_last_frame: false,
  supports_audio_only: true, reference_roles: [], max_references: 12, max_video_audio_combined: 3, min_prompt_length: 10
};

const list = value => Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.length) : [];

// Real catalogs come from /v1/models; this snapshot is for offline simulation only.
export function normalizeModel(item, mediaType = item.media_type || 'video') {
  if (typeof item.id !== 'string' || !item.id || item.media_type && item.media_type !== mediaType) return null;
  const cap = item.capabilities || {};
  const common = {
    id: item.id, name: typeof item.name === 'string' ? item.name : item.id, mediaType,
    ratios: list(cap.aspect_ratios), resolutions: list(cap.resolutions),
    minPrompt: cap.min_prompt_length ?? 1, maxPrompt: Math.min(cap.max_prompt_length ?? 20000, 20000),
    maxReferences: Math.min(cap.max_references ?? 0, mediaType === 'image' ? 16 : 50),
    referenceTypes: list(cap.reference_types), capabilities: cap
  };
  if (mediaType === 'image') {
    const spec = cap.protocol === 'gemini' || /^smartbiai-banana(?:-|$)/.test(item.id) ? 'ratio' : 'size';
    const result = { ...common, spec, sizes: list(cap.sizes), qualities: list(cap.qualities),
      reference: Boolean(cap.supports_reference), mask: Boolean(cap.supports_mask), maxCount: 8 };
    return (spec === 'size' ? result.sizes.length && result.qualities.length : result.ratios.length && result.resolutions.length) ? result : null;
  }
  const min = cap.min_duration;
  const max = cap.max_duration;
  if (!common.ratios.length || !common.resolutions.length || !Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 600) return null;
  return { ...common, min, max, durations: Array.isArray(cap.durations) ? cap.durations.filter(Number.isInteger) : [],
    audio: Boolean(cap.supports_audio), lastFrame: Boolean(cap.supports_last_frame), autoDuration: Boolean(cap.supports_auto_duration),
    textOnly: cap.supports_text_only !== false, audioOnly: Boolean(cap.supports_audio_only), referenceRoles: list(cap.reference_roles) };
}

export const models = [
  ['smartbiai-sd-2-0-mini-260619', 'Seedance2.0 Mini', standard],
  ['smartbiai-sd-2-0-lite-260722', 'Seedance2.0 Lite', discrete],
  ['smartbiai-sd-2-0-260329', 'Seedance2.0', { ...standard, resolutions: ['480p', '720p', '1080p', '4k'] }],
  ['smartbiai-sd-2-0-fast-260329', 'Seedance2.0 Fast', standard],
  ['smartbiai-sd-2-0-character-260722', 'Seedance2.0 Character', discrete],
  ['smartbiai-sd-2-0-mono-260722', 'Seedance2.0 Mono', discrete],
  ['smartbiai-sd-2-5-260719', 'Seedance2.5', { ...standard, resolutions: ['480p', '720p', '1080p'], max_duration: 30,
    max_references: 50, max_images: 30, max_videos: 10, max_audios: 10, supports_audio_only: true, framed_requires_adaptive: true }],
  ['smartbiai-sd-2-5-flash-261115', 'Seedance2.5 Flash', { ...standard, max_duration: 30,
    max_references: 20, max_images: 10, max_videos: 5, max_audios: 5, supports_audio_only: true,
    framed_requires_adaptive: true, prompt_optional_with_references: true }]
].map(([id, name, capabilities]) => normalizeModel({ id, name, media_type: 'video', capabilities }));

const imageCapabilities = {
  sizes: ['1024x1024'], qualities: ['auto'], aspect_ratios: ['1:1'], resolutions: ['1K'],
  supports_reference: true, supports_mask: true, max_references: 8, max_prompt_length: 20000,
  image_max_mb: 50, input_formats: ['png', 'jpeg', 'webp'], output_formats: ['png', 'jpeg', 'webp']
};
const imageCatalog = [['smartbiai-gpt-img-2', 'GPT Img 2']];
for (const token of ['image', 'img']) for (const version of ['2.5', '2.6']) for (const variant of ['flare', 'sunburst']) {
  imageCatalog.push([`smartbiai-gpt-${token}-${version.replace('.', '-')}-${variant}`, `GPT ${token === 'img' ? 'Img' : 'Image'} ${version} ${variant === 'flare' ? 'Flare' : 'Sunburst'}`]);
}
imageCatalog.push(['smartbiai-banana', 'Banana'], ['smartbiai-banana-pro', 'Banana Pro'], ['smartbiai-banana-2', 'Banana 2']);
export const imageModels = imageCatalog.map(([id, name]) => normalizeModel({ id, name, media_type: 'image',
  capabilities: { ...imageCapabilities, supports_mask: !id.startsWith('smartbiai-banana') } }));

export function validationError(message, status = 400) { throw Object.assign(new Error(message), { status }); }
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
function referenceUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && url.hostname.includes('.') && !/^(?:\d+\.|localhost|.*\.local$)/i.test(url.hostname) ? url.href : null; }
  catch { return null; }
}
function promptValue(value, model) {
  const prompt = typeof value === 'string' ? value.trim() : '';
  const length = [...prompt].length;
  if (length < model.minPrompt || length > model.maxPrompt) validationError(`所选模型的提示词需要 ${model.minPrompt}～${model.maxPrompt} 个字符。`);
  return prompt;
}

export function validateVideoReferences(references, model, ratio) {
  if (references.length > model.maxReferences) validationError(`所选模型最多支持 ${model.maxReferences} 个参考素材。`);
  if (!references.length && !model.textOnly) validationError('所选模型需要添加参考素材。');
  for (const reference of references) {
    if (!model.referenceTypes.includes(reference.type)) validationError('所选模型不支持这种参考素材类型。');
    if (reference.role && !model.referenceRoles.includes(reference.role)) validationError('所选模型不支持这个参考素材角色。');
  }
  const count = type => references.filter(reference => reference.type === type).length;
  for (const type of ['image', 'video', 'audio']) {
    const limit = model.capabilities[`max_${type === 'image' ? 'images' : type === 'video' ? 'videos' : 'audios'}`];
    if (Number.isInteger(limit) && count(type) > limit) validationError('参考素材数量超过所选模型的限制。');
  }
  const combined = model.capabilities.max_video_audio_combined;
  if (combined > 0 && count('video') + count('audio') > combined) validationError(`视频和音频合计最多 ${combined} 个。`);
  if (count('audio') && !count('image') && !count('video') && !model.audioOnly) validationError('所选模型的音频参考需要搭配图片或视频。');
  if (references.some(reference => /^(first|last)_frame$/.test(reference.role || ''))) {
    if (count('image') !== references.length || references.length > 2 || references.filter(reference => reference.role === 'first_frame').length !== 1 ||
        references.some(reference => !['first_frame', 'last_frame'].includes(reference.role))) validationError('首帧模式需要一张首帧，可另外添加一张尾帧。');
    if (model.capabilities.framed_requires_adaptive && ratio !== 'adaptive') validationError('所选模型的首帧模式需要自适应画幅。');
  }
}

export function videoParameters(body, catalog, live = false) {
  const model = catalog.find(item => item.id === body.model);
  if (!model || !model.ratios.includes(body.ratio) || !model.resolutions.includes(body.resolution) || !Number.isInteger(body.duration) ||
      !(body.duration === -1 && model.autoDuration) && (model.durations?.length ? !model.durations.includes(body.duration) : body.duration < model.min || body.duration > model.max)) validationError('请选择模型支持的比例、清晰度和时长。');
  if (typeof body.audio !== 'boolean' || body.audio && !model.audio) validationError('请选择所选模型支持的声音设置。');
  const parameters = { prompt: promptValue(body.prompt, model), model: model.id, ratio: body.ratio, resolution: body.resolution, duration: body.duration, audio: body.audio };
  if (!live) return parameters;
  if (body.references != null && !Array.isArray(body.references) || body.fileIds != null && !Array.isArray(body.fileIds)) validationError('请检查参考素材。');
  parameters.references = (body.references ?? []).map(reference => {
    const url = referenceUrl(reference?.url);
    if (!url || !['image', 'video', 'audio'].includes(reference.type)) validationError('请添加可识别类型的公网 HTTPS 参考链接。');
    return { type: reference.type, url, ...(reference.role ? { role: reference.role } : {}) };
  });
  parameters.fileIds = body.fileIds ?? [];
  if (parameters.fileIds.some(id => !uuid(id)) || parameters.references.length + parameters.fileIds.length > model.maxReferences) validationError('请检查参考素材数量和文件编号。');
  return parameters;
}

export function imageParameters(body, catalog) {
  const model = catalog.find(item => item.id === body.model);
  if (!model) validationError('请选择当前可用的生图模型。');
  if (!Number.isInteger(body.n) || body.n < 1 || body.n > model.maxCount) validationError(`每次可生成 1～${model.maxCount} 张图片。`);
  const parameters = { model: model.id, prompt: promptValue(body.prompt, model), n: body.n };
  const fields = model.spec === 'size' ? { size: model.sizes, quality: model.qualities } : { ratio: model.ratios, resolution: model.resolutions };
  for (const [field, options] of Object.entries(fields)) {
    if (!options.includes(body[field])) validationError('请选择模型支持的图片规格。');
    parameters[field] = body[field];
  }
  if (body.references != null && !Array.isArray(body.references) || body.fileIds != null && !Array.isArray(body.fileIds)) validationError('请检查参考图片。');
  parameters.references = (body.references ?? []).map(value => {
    const url = referenceUrl(value); if (!url) validationError('参考图片需要可公开访问的 HTTPS 链接。'); return url;
  });
  parameters.fileIds = body.fileIds ?? [];
  parameters.maskFileId = body.maskFileId || null;
  if (parameters.fileIds.some(id => !uuid(id)) || parameters.maskFileId && !uuid(parameters.maskFileId)) validationError('请检查参考图片文件编号。');
  if (parameters.maskFileId && (!model.mask || !parameters.fileIds.length && !parameters.references.length)) validationError('蒙版编辑需要参考图片及支持蒙版的模型。');
  if (parameters.references.length + parameters.fileIds.length > model.maxReferences || !model.reference && (parameters.references.length || parameters.fileIds.length)) validationError('参考图片数量超过所选模型的限制。');
  return parameters;
}

export function mockVideoCredits(body, catalog = models) {
  const model = catalog.find(item => item.id === body.model);
  const duration = body.duration === -1 ? model.max : body.duration;
  return duration * ({ '480p': 4, '720p': 6, '1080p': 12, '4k': 24 }[body.resolution] || 6);
}
