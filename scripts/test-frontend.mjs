/**
 * 前端渲染回归测试：用最小 DOM 桩在 vm 里加载真实 public/app.js，
 * 验证聊天卡片缩略图、意图标签、HTML 转义、裁剪规则与跳转链路。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const els = new Map();
const handlers = {};
const pushedUrls = []; // 记录 history.pushState 的目标路径（path 路由）

// 与真实 DOM 一致的转义：文本节点与属性值里的 < > & " 都会被转义，
// 因此 textContent / setAttribute 写入的内容序列化后天然不含可执行标记。
const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeText(s).replace(/"/g, '&quot;');
const VOID_TAGS = new Set(['img', 'br', 'hr', 'input']);
const kebab = (key) => key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

function serialize(node) {
  if (node.nodeType === 3) return escapeText(node.textContent);
  const tag = String(node.tagName || 'div').toLowerCase();
  const attrs = [];
  if (node.className) attrs.push(`class="${escapeAttr(node.className)}"`);
  for (const [k, v] of Object.entries(node.dataset || {})) attrs.push(`data-${kebab(k)}="${escapeAttr(v)}"`);
  for (const [k, v] of Object.entries(node.attrs || {})) attrs.push(`${k}="${escapeAttr(v)}"`);
  const open = `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
  if (VOID_TAGS.has(tag)) return open;
  const inner = (node.children || []).map(serialize).join('');
  const text = node.children?.length ? '' : escapeText(node.textContent || '');
  return `${open}${inner}${text}</${tag}>`;
}

class FakeEl {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.attrs = {};
    this.hidden = false;
    this.textContent = '';
    this.value = '';
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  addEventListener() {}
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  replaceChildren(...kids) { this.children = kids.filter(Boolean); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  replaceWith() {}
  focus() {}
  remove() {}
  get lastElementChild() { return this.children.at(-1) ?? null; }
  get innerHTML() { return (this.children || []).map(serialize).join(''); }
}

const getEl = (selector) => {
  if (!els.has(selector)) els.set(selector, new FakeEl());
  return els.get(selector);
};
const reg = (key) => (type, fn) => { (handlers[`${key}:${type}`] ||= []).push(fn); };

const sandbox = {
  console: { warn() {}, log() {}, error() {} },
  setTimeout,
  clearTimeout,
  URLSearchParams,
  AbortSignal,
  document: {
    querySelector: getEl,
    querySelectorAll: () => [],
    addEventListener: reg('doc'),
    createElement: (tag) => new FakeEl(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
  },
  window: { addEventListener: reg('win'), scrollTo() {} },
  location: { hash: '', pathname: '/', search: '' },
  history: {
    replaceState() {},
    pushState(_state, _unused, url) { pushedUrls.push(String(url)); },
  },
  sessionStorage: { getItem: () => null, setItem() {} },
  navigator: { clipboard: { writeText: async () => {} } },
  fetch: async () => { throw new Error('offline'); },
};

// 与 index.html 的加载顺序一致：工具 → 渲染 → 站内信 → 运维 → 入口。
// 均为经典脚本（无 import/export），拼接后在同一上下文执行。
const FRONTEND_FILES = [
  'public/ui.js',
  'public/render.js',
  'public/notify-ui.js',
  'public/admin-ui.js',
  'public/app.js',
];
const code = `${FRONTEND_FILES.map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n;\n')}
;globalThis.__test = { productCard, appendMessage, imageUrlOf, state };`;
vm.runInNewContext(code, sandbox);
const t = sandbox.__test;

// boot() 是异步 IIFE，等它执行完再清空消息容器，避免桩里残留欢迎语。
await new Promise((resolve) => setTimeout(resolve, 0));
getEl('#chat-messages').children.length = 0;

let failed = 0;
function ok(name, condition, extra = '') {
  if (!condition) failed += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition ? '' : ` :: ${extra}`}`);
}
function count(text, needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (text.match(new RegExp(escaped, 'g')) || []).length;
}

// 图片 URL 选择与白名单
ok('imageUrlOf: SKU 图优先', t.imageUrlOf({ imageUrl: 'https://x/a.png', coverUrl: 'https://x/b.png' }) === 'https://x/a.png');
ok('imageUrlOf: 封面兜底', t.imageUrlOf({ coverUrl: '/img/b.png' }) === '/img/b.png');
ok('imageUrlOf: 轮播图兜底', t.imageUrlOf({ gallery: ['https://x/c.png'] }) === 'https://x/c.png');
ok('imageUrlOf: 拒绝 javascript:', t.imageUrlOf({ imageUrl: 'javascript:alert(1)' }) === '');
ok('imageUrlOf: 拒绝协议相对 URL', t.imageUrlOf({ imageUrl: '//evil.example/x.png' }) === '');
ok('imageUrlOf: 拒绝含引号的 URL', t.imageUrlOf({ imageUrl: 'https://x/a.png" onerror="evil()' }) === '');
ok('imageUrlOf: 空对象', t.imageUrlOf({}) === '');

const products = [
  { index: 1, skuCode: 'S0', name: '<img onerror=alert(1)>', price: 12, category: '香肠去皮机', imageUrl: 'https://cdn.example.com/a.png' },
  { index: 2, skuCode: 'S1', name: '恶意图', price: 22, category: 'c', imageUrl: 'javascript:alert(1)' },
  { index: 3, skuCode: 'S2', name: '无图', price: 32, category: 'c' },
  ...Array.from({ length: 3 }, (_, i) => ({ index: i + 4, skuCode: `S${i + 3}`, name: `n${i}`, price: i, category: 'c' })),
];

t.appendMessage('assistant', 'hello', products, { label: '商品推荐', shouldRecommend: true });
const msg = getEl('#chat-messages').children.at(-1);
ok('意图标签出现在首位', msg.children[0].textContent.includes('意图识别：商品推荐 · 已检索商品库'), msg.children[0].textContent);
const box = msg.children[1];
ok('商品容器是 msg-products', box.className === 'msg-products', box.className);
ok('只渲染 3 张卡片', count(box.innerHTML, 'class="mini-card"') === 3);
ok('每张卡片都有缩略图容器', count(box.innerHTML, 'class="mini-thumb"') === 3);
ok('合法图片渲染 img', count(box.innerHTML, '<img src=') === 1);
ok('恶意/无图渲染占位符', count(box.innerHTML, '<span>▧</span>') === 2);
ok('图片 src 走 esc', box.innerHTML.includes('src="https://cdn.example.com/a.png"'));
ok('名称 XSS 被转义', box.innerHTML.includes('&lt;img') && !box.innerHTML.includes('<img onerror'));
ok('卡片带 data-sku', box.innerHTML.includes('data-sku="S0"'));
ok('溢出提示保留', Boolean(msg.children[2]) && msg.children[2].textContent.includes('其余 3 件'));

t.appendMessage('assistant', 'hi', [], { label: '一般对话', shouldRecommend: false });
ok('非推荐意图标签', getEl('#chat-messages').children.at(-1).children[0].textContent.includes('无需商品推荐'));

// 历史会话回放：只传 products，不应出现意图标签，但缩略图仍渲染。
t.appendMessage('assistant', 'hi', [products[0]]);
const replay = getEl('#chat-messages').children.at(-1);
ok('历史回放无意图标签', replay.children[0].className === 'msg-products', replay.children[0].className);
ok('历史回放仍带缩略图', replay.children[0].innerHTML.includes('<img src='));

// 商品卡片与聊天卡片共用的事件委托不能回归。
const card = { dataset: { sku: 'SKU-42' }, closest: () => card };
t.state.user = { email: 'u@example.com' };
(handlers['doc:click'] || []).forEach((fn) => fn({ target: card }));
ok('卡片点击仍可跳详情', pushedUrls.at(-1) === '/product/SKU-42', pushedUrls.at(-1));
ok('分页仍为 18', t.state.pageSize === 18);

console.log(failed ? `\nFAILED: ${failed}` : '\nALL FRONTEND CHECKS PASSED');
process.exitCode = failed ? 1 : 0;
