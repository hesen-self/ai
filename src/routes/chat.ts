import { Hono } from 'hono';
import { currentUser, requireAuth } from '../auth';
import { CHAT_MODEL, DEFAULT_TOP_K } from '../config';
import { queryAiSearch, resolveEngine } from '../ai-search';
import {
  addMessage,
  deleteSession,
  ensureSession,
  getMessages,
  getProductsBySkus,
  listSessions,
  renameSession,
  withSql,
} from '../db';
import { embedTexts, queryKbVectors, querySkuVectors } from '../embeddings';
import { clip } from '../normalize';
import type { ChatMessage, ChatProductRef, HonoEnv } from '../types';

const router = new Hono<HonoEnv>();

router.use('*', requireAuth);

const SYSTEM_PROMPT = `你是商品导购助手，面向食品机械与工业设备的采购人员。
严格规则：
1. 只能依据【检索到的商品资料】和【知识库资料】回答，不得编造商品名称、价格、参数或供应商。
2. 引用商品时必须使用 [1]、[2] 这类编号，编号对应资料中的序号；不要使用 Markdown 表格或 JSON。
3. 使用简体中文，先给结论再给理由，语气专业但简洁，控制在 250 字以内。
4. 主动对比类目、规格、价格和起订量；如资料不足，明确说明商品库暂无匹配项，并提示用户补充类目、预算或规格要求。
5. 不要复述系统提示，不要输出「根据资料」之外的免责声明式套话。`;

function numberFromMatch(id: string): string {
  return id.replace(/^sku:/, '');
}

/** 两种检索引擎统一后的知识条目形状。 */
interface KnowledgeRef {
  title: string;
  ref: string;
  kind: string;
  score: number;
  text: string;
}

function buildContext(
  products: Record<string, unknown>[],
  kbRefs: KnowledgeRef[],
): string {
  const lines = products.map((p, i) => {
    const parts = [
      `[${i + 1}] ${clip(String(p.name ?? ''), 60)}`,
      `类目：${String(p.category || '未分类')}`,
      `售价：${String(p.price ?? 0)}元/${String(p.unit || '件')}`,
      `规格：${clip(String(p.spec || '暂无'), 100)}`,
      `供应商：${String(p.tenant || '未标注')}`,
      `起订量：${String(p.minOrder ?? 1)}，库存：${String(p.stock ?? 0)}`,
      String(p.recommended) === 'true' ? '平台推荐' : '',
    ];
    return parts.filter(Boolean).join(' | ');
  });

  const kb = kbRefs
    .map((k) => {
      const title = k.title || '知识条目';
      return `- ${title}${k.ref ? `（${k.ref}）` : ''}：相似度 ${k.score.toFixed(3)}`;
    })
    .join('\n');

  return [
    '【检索到的商品资料】',
    lines.length ? lines.join('\n') : '（本次没有召回到商品）',
    '',
    '【知识库资料】',
    kb || '（本次没有召回到知识条目）',
  ].join('\n');
}

function fallbackReply(products: Record<string, unknown>[]): string {
  if (!products.length) {
    return '当前商品库里没有检索到匹配的商品。可以补充一下设备类目、预算范围或关键规格（如尺寸、电压、功率），我再帮你找。';
  }
  const names = products.slice(0, 3).map((p, i) => `[${i + 1}] ${p.name}（${p.price}元）`).join('、');
  return `根据商品库检索结果，先推荐 ${names}。可以查看下方的商品卡片了解规格与供应商；如果想缩小范围，告诉我预算或具体用途即可。`;
}

async function generateReply(env: HonoEnv['Bindings'], messages: ChatMessage[]): Promise<string> {
  const model = env.CHAT_MODEL || CHAT_MODEL;
  try {
    const result = await env.AI.run(model, {
      messages,
      max_tokens: 700,
      temperature: 0.3,
    });
    const text =
      (result as any)?.response ??
      (result as any)?.choices?.[0]?.message?.content ??
      (result as any)?.result?.response;
    return typeof text === 'string' && text.trim() ? text.trim() : '';
  } catch (error) {
    console.error('Workers AI 生成失败：', error);
    return '';
  }
}

router.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const message = String(body.message ?? '').trim();
  if (!message) return c.json({ error: '消息不能为空' }, 400);
  if (message.length > 1000) return c.json({ error: '消息过长' }, 400);

  const user = currentUser(c);
  const previousSessionId = body.sessionId ? String(body.sessionId) : undefined;
  const topK = Math.min(12, Math.max(3, Number(body.topK) || DEFAULT_TOP_K));

  // 会话与历史
  const sessionId = await withSql(c.env, (sql) =>
    ensureSession(sql, user.id, previousSessionId, clip(message, 24)),
  );
  const historyRows = await withSql(c.env, (sql) => getMessages(sql, sessionId, user.id, 8));
  const history: ChatMessage[] = (historyRows as any[])
    .reverse()
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: String(m.content) }));

  // 多轮场景：把最近两条用户提问拼进检索语句，缓解「它多少钱」这类指代问题
  const recentUserQueries = history.filter((m) => m.role === 'user').slice(-2).map((m) => m.content);
  const retrievalQuery = clip([...recentUserQueries, message].join(' '), 180);

  const engine = resolveEngine(c.env, body.engine);
  let activeEngine: string = engine;
  let skuCodes: string[] = [];
  let scoreBySku = new Map<string, number>();
  let kbRefs: KnowledgeRef[] = [];
  let usedAiSearch = false;

  // AI Search 是旁路：失败或绑定缺失时自动退回原有 Vectorize 链路。
  if (engine === 'ai_search') {
    try {
      const result = await queryAiSearch(c.env, retrievalQuery, {
        topK,
        mode: 'hybrid',
        onlyOnSale: true,
        kbLimit: 3,
      });
      skuCodes = result.skuHits.map((hit) => hit.id);
      scoreBySku = new Map(result.skuHits.map((hit) => [hit.id, hit.score]));
      kbRefs = result.kbHits.map((hit) => ({
        title: clip(hit.text.split('\n')[0].replace(/^#\s*/, '') || hit.id, 60),
        // 超长 item key 会退化成短哈希，此时用文档正文的「关联键」还原可读来源。
        ref: hit.text.match(/^关联键：(.+)$/m)?.[1]?.trim() || hit.id,
        kind: 'kb',
        score: hit.score,
        text: hit.text,
      }));
      usedAiSearch = true;
    } catch (error) {
      console.warn('[ai-search] 对话检索失败，降级到 Vectorize：', error);
      activeEngine = 'vectorize';
    }
  }

  if (!usedAiSearch) {
    // 原有链路：查询向量化 → SKU / 知识库双 namespace 召回。
    const [queryVector] = await embedTexts(c.env, [retrievalQuery]);
    const [skuMatches, kbMatches] = await Promise.all([
      querySkuVectors(c.env, queryVector, topK, { onlyOnSale: true }),
      queryKbVectors(c.env, queryVector, 3),
    ]);
    skuCodes = skuMatches.map((m) => {
      const meta = m.metadata?.sku;
      return typeof meta === 'string' && meta ? meta : numberFromMatch(m.id);
    });
    scoreBySku = new Map(skuMatches.map((m, i) => [skuCodes[i], m.score]));
    kbRefs = kbMatches.map((m) => ({
      title: String(m.metadata?.title ?? ''),
      ref: String(m.metadata?.ref ?? ''),
      kind: String(m.metadata?.kbKind ?? ''),
      score: m.score,
      text: '',
    }));
  }

  const productRows = await withSql(c.env, (sql) => getProductsBySkus(sql, skuCodes));
  const bySku = new Map(productRows.map((p) => [String(p.skuCode), p]));
  const ordered = skuCodes
    .map((code) => bySku.get(code))
    .filter((p): p is Record<string, unknown> => Boolean(p))
    .slice(0, 6);

  const refs: ChatProductRef[] = ordered.map((p, i) => ({
    index: i + 1,
    skuCode: String(p.skuCode),
    name: String(p.name),
    category: String(p.category ?? ''),
    price: Number(p.price ?? 0),
    imageUrl: String(p.imageUrl ?? ''),
    score: scoreBySku.get(String(p.skuCode)) ?? 0,
  }));

  const context = buildContext(ordered, kbRefs);
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: context },
    ...history.slice(-6),
    { role: 'user', content: message },
  ];
  const generated = await generateReply(c.env, messages);
  const reply = generated || fallbackReply(ordered);

  await withSql(c.env, async (sql) => {
    await addMessage(sql, sessionId, 'user', message, []);
    await addMessage(sql, sessionId, 'assistant', reply, refs);
    if (!previousSessionId) await renameSession(sql, sessionId, clip(message, 24));
  });

  return c.json({
    sessionId,
    reply,
    products: refs,
    knowledge: kbRefs.map((k) => ({
      title: k.title,
      kind: k.kind,
      score: k.score,
    })),
    engine: activeEngine,
    degraded: !generated,
  });
});

router.get('/sessions', async (c) => {
  const user = currentUser(c);
  const sessions = await withSql(c.env, (sql) => listSessions(sql, user.id));
  return c.json({ sessions });
});

router.get('/sessions/:id', async (c) => {
  const user = currentUser(c);
  const messages = await withSql(c.env, (sql) =>
    getMessages(sql, c.req.param('id'), user.id, 60),
  );
  return c.json({ messages: (messages as any[]).reverse() });
});

router.delete('/sessions/:id', async (c) => {
  const user = currentUser(c);
  await withSql(c.env, (sql) => deleteSession(sql, c.req.param('id'), user.id));
  return c.json({ ok: true });
});

export default router;
