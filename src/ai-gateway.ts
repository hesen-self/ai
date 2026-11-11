import type { AiGatewayRunOptions, Env } from './types';

export type AiOperation = 'chat' | 'intent' | 'embedding';
export type AiSource = 'user-request' | 'admin-sync' | 'knowledge-build';

export interface AiGatewayRequest {
  operation: AiOperation;
  source: AiSource;
  /** 仅适合输入稳定、可安全复用的后台向量化任务。 */
  cache?: {
    key: string;
    ttl: number;
  };
}

/**
 * 为 Workers AI 请求附加 AI Gateway 策略。
 *
 * 未配置 AI_GATEWAY_ID 时返回 undefined，让本地开发继续直连 Workers AI；
 * 对话和意图识别调用方不传 cache，因而始终跳过网关缓存。
 */
export function aiGatewayOptions(env: Env, request: AiGatewayRequest): AiGatewayRunOptions | undefined {
  const id = env.AI_GATEWAY_ID?.trim();
  if (!id) return undefined;

  return {
    gateway: {
      id,
      skipCache: !request.cache,
      ...(request.cache ? { cacheKey: request.cache.key, cacheTtl: request.cache.ttl } : {}),
      // 网关控制台必须设为“仅元数据日志”，避免持久化提示词与回答正文。
      collectLog: true,
      metadata: {
        operation: request.operation,
        source: request.source,
        cache: request.cache ? 'content-addressed' : 'disabled',
      },
    },
  };
}

/** 以模型和输入内容生成稳定缓存键，不把原始文本放入键或元数据。 */
export async function aiContentCacheKey(model: string, texts: string[]): Promise<string> {
  const payload = `${model}\u0000${texts.join('\u0001')}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `embedding:${hex}`;
}
