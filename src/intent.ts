import { CHAT_MODEL, INTENT_MODEL } from './config';
import { clip } from './normalize';
import type { ChatMessage, Env } from './types';

/**
 * 对话意图识别：先规则、后 AI、最后兜底。
 *
 * 设计取舍：导购对话里大部分输入是「问候 / 感谢 / 明确找货 / 多轮追问」，
 * 这些用确定性规则零成本、零延迟就能判准；只有规则无法定论的模糊句才多花
 * 一次 Workers AI 调用。AI 不可用时退回「按商品推荐处理」，保持旧行为可用。
 */

export type ChatIntent =
  | 'recommend'
  | 'product_query'
  | 'follow_up'
  | 'general'
  | 'support'
  | 'unclear';

export interface IntentDecision {
  intent: ChatIntent;
  /** 是否需要走 SKU/知识库召回并附上商品卡片。 */
  shouldRecommend: boolean;
  /** rule=确定性规则，ai=模型分类，fallback=识别失败后的保守默认。 */
  source: 'rule' | 'ai' | 'fallback';
  reason: string;
}

export const INTENTS: ChatIntent[] = [
  'recommend',
  'product_query',
  'follow_up',
  'general',
  'support',
  'unclear',
];

export const INTENT_LABELS: Record<ChatIntent, string> = {
  recommend: '商品推荐',
  product_query: '商品咨询',
  follow_up: '追问上一轮推荐',
  general: '一般对话',
  support: '平台服务咨询',
  unclear: '需求待明确',
};

/** 这三类意图都需要检索商品库；其余直接走通用对话。 */
export function shouldRecommend(intent: ChatIntent): boolean {
  return intent === 'recommend' || intent === 'product_query' || intent === 'follow_up';
}

const INTENT_SYSTEM_PROMPT = `你是商品导购对话的意图分类器。只输出一行 JSON，不要解释、不要 Markdown。
可选 intent：
- recommend：想找商品、求推荐、比价、选购、按预算/用途挑设备
- product_query：询问商品库里的类目、价格、规格、参数、供应商、库存等事实
- follow_up：承接上一轮商品推荐的追问或调整（更便宜、第二台、那个有货吗）
- general：问候、感谢、闲聊、询问助手能力、与商品无关的开放式聊天
- support：账号、登录、订单、支付、发票、退款、人工客服等平台服务问题
- unclear：信息太少、无法判断，需要用户补充
输出格式：{"intent":"recommend","reason":"不超过20字的判断依据"}
不要输出 intent 以外的字段，不要编造内容。`;

function clean(value: string): string {
  return String(value ?? '').trim().replace(/[\s\u3000]+/g, ' ');
}

/** 高置信的纯寒暄，整句匹配，避免把「你好，帮我找台机器」误判成闲聊。 */
const EXACT_GREETING = /^(你好|您好|哈喽|嗨|hi|hello|hey|早上好|下午好|晚上好|在吗|在么|有人吗)[\s!！?？。,.，~～、]*$/i;
const EXACT_ACK = /^(谢谢|多谢|感谢|thanks?|thank you|thx|好的|好嘞|收到|明白|知道了|ok|okay|嗯+|哦|拜拜|再见|辛苦了|没问题|可以)[\s!！?？。,.，~～、]*$/i;

/** 询问助手能力；仅在没有商品信号时生效。 */
const CAPABILITY = /(你是谁|你叫什么|你能做什么|你能帮我什么|可以做什么|怎么用|怎么使用|使用说明|功能介绍|介绍一下你自己|你能干什么|帮助|help)/i;

/** 平台服务类问题；与具体商品词同时出现时仍按商品问题处理。 */
const SUPPORT_WORDS = /(发票|开票|退款|退货|订单|下单|付款|支付|密码|登录|注册|账号|账户|客服|人工|投诉|快递单号|物流单号|维权|改地址)/i;
const CONCRETE_PRODUCT = /(设备|机器|机械|商品|产品|款|型号|规格|类目|sku|货号|推荐|报价|多少钱|生产线|配件)/i;

/** 明确的商品意图词（刻意避开过度宽泛的「找」）。 */
const PRODUCT_WORDS = /(推荐|想找|帮我找|找(?:一?[台套件个]|款|商品|设备|机|类)|想要|需要|想买|要买|采购|有没有|有哪些|哪款|哪[一些]|怎么选|选哪|对比|比较|性价比|预算|报价|多少钱|价格|售价|便宜|贵|型号|规格|参数|供应商|厂家|品牌|类目|品类|库存|现货|起订|发货|适用|适合|用于|sku|货号|设备|机器|机械|生产线|配件|清单|方案)/i;

/** 询问具体事实而非求推荐。 */
const QUERY_WORDS = /(多少钱|价格|售价|规格|参数|型号|供应商|厂家|库存|现货|起订|sku|货号|是什么|有哪些|质保|保修)/i;
/** 出现这些动词时按「求推荐」而不是「事实查询」。 */
const ACTION_WORDS = /(推荐|找|买|选|采购|想要|需要|给我|来[一几])/i;

/** 强指代：几乎只在多轮追问里出现。 */
const STRONG_FOLLOWUP = /(它|它们|这个|那个|这[台套件个款]|那[台套件个款]|第[一二三四五六1-6]|刚才|刚刚|上面|前面|上一?条|再给|再来|换成|那款|这款)/;
const WEAK_FOLLOWUP = /(再|还|换|便宜|贵|其他|别的|呢|吗|相比|对比一下|有货)/;

/**
 * 纯规则判定。返回 null 表示「规则不敢下结论」，调用方应交给 AI 分类。
 * 该函数不依赖 Workers 环境，可直接用 Node 做单元测试。
 */
export function classifyByRules(message: string, hasHistory: boolean): IntentDecision | null {
  const text = clean(message);
  if (!text) return null;

  const chatHit = EXACT_GREETING.test(text) || EXACT_ACK.test(text);
  const productHit = PRODUCT_WORDS.test(text);
  const supportHit = SUPPORT_WORDS.test(text);

  if (chatHit) {
    return { intent: 'general', shouldRecommend: false, source: 'rule', reason: '问候或确认类寒暄' };
  }
  if (supportHit && !CONCRETE_PRODUCT.test(text)) {
    return { intent: 'support', shouldRecommend: false, source: 'rule', reason: '平台服务类问题，不涉及具体商品' };
  }
  if (CAPABILITY.test(text) && !productHit) {
    return { intent: 'general', shouldRecommend: false, source: 'rule', reason: '询问助手能力或用法' };
  }

  if (hasHistory) {
    const strong = STRONG_FOLLOWUP.test(text);
    const weak = [...text].length <= 10 && WEAK_FOLLOWUP.test(text);
    if (strong || weak) {
      return { intent: 'follow_up', shouldRecommend: true, source: 'rule', reason: '承接上一轮商品推荐的追问' };
    }
  }

  if (productHit) {
    const intent = QUERY_WORDS.test(text) && !ACTION_WORDS.test(text) ? 'product_query' : 'recommend';
    return {
      intent,
      shouldRecommend: true,
      source: 'rule',
      reason: intent === 'product_query' ? '询问商品库中的具体信息' : '表达找货或选购需求',
    };
  }

  if ([...text].length <= 3 && !hasHistory) {
    return { intent: 'unclear', shouldRecommend: false, source: 'rule', reason: '输入过短，需要用户补充需求' };
  }

  return null;
}

/**
 * Workers AI 对「看起来像 JSON」的输出可能返回两种形状：
 * ① response 已被解析成对象（OpenAI chat completion 风格的 `result.response`）；
 * ② response / choices[0].message.content 是包含 JSON 的字符串，甚至带 Markdown 代码块。
 * 逐个候选尝试，不能因为第一个候选是对象就短路。
 */
function parseIntentPayload(result: unknown): { intent?: unknown; reason?: unknown } | null {
  const r = result as any;
  const candidates = [
    r?.response,
    r?.result?.response,
    r?.choices?.[0]?.message?.content,
    r?.result?.choices?.[0]?.message?.content,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      if ('intent' in candidate) return candidate as { intent?: unknown; reason?: unknown };
      continue;
    }
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const match = candidate.match(/\{[\s\S]*?\}/);
    if (!match) continue;
    try {
      return JSON.parse(match[0]) as { intent?: unknown; reason?: unknown };
    } catch {
      continue;
    }
  }
  return null;
}

/** 用 Workers AI 做一次轻量分类；任何异常都返回 null，由调用方兜底。 */
export async function classifyWithAi(
  env: Env,
  message: string,
  history: ChatMessage[],
): Promise<IntentDecision | null> {
  const recent = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-4)
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${clip(m.content, 90)}`)
    .join('\n');
  const model = env.INTENT_MODEL || INTENT_MODEL || CHAT_MODEL;
  try {
    const result = await env.AI.run(model, {
      messages: [
        { role: 'system', content: INTENT_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `最近对话：\n${recent || '（无历史）'}\n\n当前消息：${clip(message, 400)}\n\n只输出 JSON：`,
        },
      ],
      max_tokens: 90,
      temperature: 0,
    });
    const parsed = parseIntentPayload(result);
    if (!parsed || typeof parsed.intent !== 'string' || !INTENTS.includes(parsed.intent as ChatIntent)) {
      return null;
    }
    const intent = parsed.intent as ChatIntent;
    return {
      intent,
      shouldRecommend: shouldRecommend(intent),
      source: 'ai',
      reason: clip(typeof parsed.reason === 'string' ? parsed.reason : '模型分类', 60),
    };
  } catch (error) {
    console.error('意图识别 AI 调用失败：', error);
    return null;
  }
}

/** 组合入口：规则 → AI → 兜底。 */
export async function detectIntent(
  env: Env,
  message: string,
  history: ChatMessage[],
): Promise<IntentDecision> {
  const hasHistory = history.some((m) => m.role === 'user');
  const rule = classifyByRules(message, hasHistory);
  if (rule) return rule;

  const ai = await classifyWithAi(env, message, history);
  if (ai) return ai;

  // 识别链路不可用时：含商品信号的仍按推荐处理，避免漏掉真实采购需求；
  // 没有商品信号的模糊句改为追问需求，而不是强行塞一堆商品卡片。
  const hasProductSignal = PRODUCT_WORDS.test(message);
  return {
    intent: hasProductSignal ? 'recommend' : 'unclear',
    shouldRecommend: hasProductSignal,
    source: 'fallback',
    reason: hasProductSignal ? '意图识别不可用，按商品推荐处理' : '意图识别不可用，请用户补充需求',
  };
}
