/** AI Gateway 调用策略的回归测试：不依赖 Cloudflare 账号或真实模型。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src/ai-gateway.ts'), 'utf8');
const stripped = stripTypeScriptTypes(source, { mode: 'strip' });
const body = stripped.replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '');
const sandbox = { crypto: globalThis.crypto, TextEncoder };
vm.runInNewContext(
  `${body}\n;globalThis.__gateway = { aiGatewayOptions, aiContentCacheKey };`,
  sandbox,
);
const { aiGatewayOptions, aiContentCacheKey } = sandbox.__gateway;

assert.equal(
  aiGatewayOptions({}, { operation: 'chat', source: 'user-request' }),
  undefined,
  '本地未配置网关时应直连 Workers AI',
);

const env = { AI_GATEWAY_ID: 'product-ai-prod' };
const chat = aiGatewayOptions(env, { operation: 'chat', source: 'user-request' });
assert.equal(chat.gateway.id, 'product-ai-prod');
assert.equal(chat.gateway.skipCache, true, '聊天必须跳过缓存');
assert.equal(chat.gateway.metadata.cache, 'disabled');

const key = await aiContentCacheKey('@cf/baai/bge-m3', ['商品标题', '商品描述']);
const sameKey = await aiContentCacheKey('@cf/baai/bge-m3', ['商品标题', '商品描述']);
assert.equal(key, sameKey, '相同模型和文本必须生成相同缓存键');
assert.ok(!key.includes('商品标题'), '缓存键不得泄露原文');

const embedding = aiGatewayOptions(env, {
  operation: 'embedding',
  source: 'admin-sync',
  cache: { key, ttl: 604800 },
});
assert.equal(embedding.gateway.skipCache, false, '后台 embedding 可以使用内容缓存');
assert.equal(embedding.gateway.cacheKey, key);
assert.equal(embedding.gateway.cacheTtl, 604800);
assert.equal(embedding.gateway.metadata.source, 'admin-sync');

console.log('PASS AI Gateway：直连降级、聊天禁缓存、embedding 内容缓存策略');
