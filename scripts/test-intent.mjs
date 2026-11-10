/**
 * 意图识别规则的回归测试。
 *
 * src/intent.ts 是 Worker 内的 TS 模块，无法直接用 Node import（ESM 扩展名 +
 * Workers 全局类型）。这里用 node:module 的 stripTypeScriptTypes 剥离类型、
 * 去掉 import/export，再在 vm 沙箱里注入最小依赖，直接执行真实源码。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src/intent.ts'), 'utf8');
const stripped = stripTypeScriptTypes(source, { mode: 'strip' });
const body = stripped.replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '');
const prelude = `
const CHAT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const INTENT_MODEL = CHAT_MODEL;
const clip = (value, max) => String(value ?? '').slice(0, max);
`;
const sandbox = { console: { info() {}, error() {} } };
vm.runInNewContext(
  `${prelude}\n${body}\n;globalThis.__intent = { classifyByRules, classifyWithAi, detectIntent, shouldRecommend, INTENT_LABELS, INTENTS };`,
  sandbox,
);
const intent = sandbox.__intent;

let failed = 0;
function ok(name, actual, expected) {
  const pass = actual === expected;
  if (!pass) failed += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${pass ? '' : ` :: got ${JSON.stringify(actual)}, expect ${JSON.stringify(expected)}`}`);
}

// 规则层：高置信场景必须零成本判准，且不触发 AI 调用。
const ruleCases = [
  ['你好', false, 'general', false],
  ['HELLO', false, 'general', false],
  ['谢谢！', false, 'general', false],
  ['好的', true, 'general', false],
  ['你是谁', false, 'general', false],
  ['你能做什么', false, 'general', false],
  ['怎么开发票', false, 'support', false],
  ['忘记密码了怎么办', false, 'support', false],
  ['有没有客服', false, 'support', false],
  ['推荐一台香肠去皮机', false, 'recommend', true],
  ['帮我找台设备', false, 'recommend', true],
  ['有没有便宜的灌装机', false, 'recommend', true],
  ['香肠去皮机多少钱', false, 'product_query', true],
  ['这款设备的起订量是多少', false, 'product_query', true],
  ['那第二台有货吗', true, 'follow_up', true],
  ['它多少钱', true, 'follow_up', true],
  ['便宜点的', true, 'follow_up', true],
  ['还有吗', true, 'follow_up', true],
  ['它多少钱', false, 'product_query', true],
  ['哈', false, 'unclear', false],
];
for (const [text, hasHistory, expectedIntent, expectedRecommend] of ruleCases) {
  const got = intent.classifyByRules(text, hasHistory);
  ok(
    `rule "${text}"${hasHistory ? ' (多轮)' : ''} -> ${expectedIntent}`,
    got ? got.intent : null,
    expectedIntent,
  );
  if (got) {
    ok(`  shouldRecommend("${text}")`, got.shouldRecommend, expectedRecommend);
    ok(`  source("${text}")`, got.source, 'rule');
  }
}

// 规则不下结论的句子交给 AI 分类。
for (const text of ['最近生意不太好', '能聊聊行业趋势吗', '随便说点什么']) {
  ok(`rule "${text}" -> null (交给 AI)`, intent.classifyByRules(text, false), null);
}

// shouldRecommend 的总开关：只有三类商品意图为 true。
for (const [name, expected] of [
  ['recommend', true], ['product_query', true], ['follow_up', true],
  ['general', false], ['support', false], ['unclear', false],
]) {
  ok(`shouldRecommend(${name})`, intent.shouldRecommend(name), expected);
}

const makeEnv = (response, shouldThrow = false) => {
  const env = {
    AI: {
      run: async () => {
        env.calls += 1;
        if (shouldThrow) throw new Error('AI unavailable');
        return { response };
      },
    },
    calls: 0,
  };
  return env;
};

const history = [{ role: 'assistant', content: '给你推荐了两台设备' }];

// 规则命中时不应调用 AI。
const quickEnv = makeEnv('{"intent":"general","reason":"x"}');
const quick = await intent.detectIntent(quickEnv, '你好', history);
ok('规则命中不调用 AI', quickEnv.calls, 0);
ok('规则命中返回 general', quick.intent, 'general');

// 规则犹豫时由 AI 定案；带 Markdown 包裹的 JSON 也能解析。
const aiEnv = makeEnv('```json\n{"intent":"support","reason":"问发票"}\n```');
const aiDecision = await intent.detectIntent(aiEnv, '最近生意不太好', history);
ok('模糊输入触发 AI 分类', aiEnv.calls, 1);
ok('AI 结果 intent=support', aiDecision.intent, 'support');
ok('AI 结果不推荐', aiDecision.shouldRecommend, false);
ok('AI 结果 source=ai', aiDecision.source, 'ai');

// 非法 JSON / 未知 intent / 抛异常，都要安全降级到「按推荐处理」。
for (const [name, env] of [
  ['非法 JSON', makeEnv('not a json')],
  ['未知 intent', makeEnv('{"intent":"hack"}')],
  ['AI 抛异常', makeEnv('', true)],
]) {
  const decision = await intent.detectIntent(env, '最近生意不太好', history);
  ok(`${name} -> fallback recommend`, decision.intent, 'recommend');
  ok(`${name} -> 仍然推荐`, decision.shouldRecommend, true);
  ok(`${name} -> source=fallback`, decision.source, 'fallback');
}

// 标签表必须覆盖全部意图，前端展示不能出现 undefined。
for (const name of intent.INTENTS) {
  ok(`INTENT_LABELS[${name}]`, typeof intent.INTENT_LABELS[name], 'string');
}

console.log(failed ? `\nFAILED: ${failed}` : '\nALL INTENT CHECKS PASSED');
process.exitCode = failed ? 1 : 0;
