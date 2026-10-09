import type {VideoModel} from './model.js';
export function declaredCapabilities(raw:Record<string,unknown>):VideoModel['capabilities'] | undefined {
  const nested=(raw.capabilities && typeof raw.capabilities==='object' ? raw.capabilities : raw) as Record<string,unknown>;
  const duration=(nested.duration && typeof nested.duration==='object' ? nested.duration : {}) as Record<string,unknown>;
  const references=(nested.references && typeof nested.references==='object' ? nested.references : {}) as Record<string,unknown>;
  const prompt=(nested.prompt && typeof nested.prompt==='object' ? nested.prompt : {}) as Record<string,unknown>;
  const caps:NonNullable<VideoModel['capabilities']>={};
  const numeric:Record<string,unknown>={minDurationSec:nested.minDurationSec ?? nested.min_duration_seconds ?? nested.min_duration_sec ?? duration.min_seconds,
    maxDurationSec:nested.maxDurationSec ?? nested.max_duration_seconds ?? nested.max_duration_sec ?? duration.max_seconds,
    fixedDurationSec:nested.fixedDurationSec ?? nested.fixed_duration_seconds ?? nested.fixed_duration_sec ?? duration.fixed_seconds,
    maxReferences:nested.maxReferences ?? nested.max_reference_images ?? nested.max_references ?? references.max_image_urls,
    maxPromptChars:nested.maxPromptChars ?? nested.max_prompt_chars ?? prompt.max_unicode_code_points};
  for(const [key,value] of Object.entries(numeric)) if(typeof value==='number' && Number.isFinite(value) && value>0 && (!['maxReferences','maxPromptChars'].includes(key) || Number.isInteger(value)) && (key!=='maxPromptChars' || value>=100) && value<= (key==='maxPromptChars'?1000000:key==='maxReferences'?100:1800)) Object.assign(caps,{[key]:value});
  for(const [key,value] of Object.entries({nativeAudio:nested.nativeAudio ?? nested.native_audio ?? nested.supports_native_audio,
    referenceVideo:nested.referenceVideo ?? nested.reference_video ?? references.supports_video,
    referenceAudio:nested.referenceAudio ?? nested.reference_audio ?? references.supports_audio})) if(typeof value==='boolean') Object.assign(caps,{[key]:value});
  const ratio=(nested.aspect_ratio && typeof nested.aspect_ratio==='object' ? nested.aspect_ratio : {}) as Record<string,unknown>;
  const aspects=nested.aspectRatios ?? nested.aspect_ratios ?? ratio.allowed;
  if(Array.isArray(aspects)) {const values=aspects.filter((value):value is '16:9'|'9:16'|'1:1'=>['16:9','9:16','1:1'].includes(String(value)));if(values.length)caps.aspectRatios=[...new Set(values)];}
  const resolutions=nested.resolutions ?? nested.supported_resolutions;
  if(Array.isArray(resolutions)) {const values=resolutions.filter((value):value is string=>typeof value==='string' && /^\d{2,5}x\d{2,5}$/.test(value));if(values.length)caps.resolutions=[...new Set(values)];}
  if(typeof nested.outputResolution==='string' && /^\d{2,5}x\d{2,5}$/.test(nested.outputResolution)) caps.outputResolution=nested.outputResolution;
  if((caps.minDurationSec && caps.maxDurationSec && caps.minDurationSec>caps.maxDurationSec) || (caps.fixedDurationSec && caps.maxDurationSec && caps.fixedDurationSec>caps.maxDurationSec) || (caps.fixedDurationSec && caps.minDurationSec && caps.fixedDurationSec<caps.minDurationSec)) throw new Error('目录声明的时长范围互相矛盾');
  return Object.keys(caps).length ? caps : undefined;
}
