/* UI 基础工具：DOM 构建器、弹层、格式化（经典脚本，全局共享给其余前端文件）。
 * 安全约定：所有动态内容一律经 el() 的 textContent / setAttribute 进入 DOM，
 * 浏览器自动转义，天然免疫 XSS；前端代码不再使用 innerHTML。 */
/* exported $, $$, el, toast, confirmDialog, bindImages, formatTime, money, listOf, isObject, scalar, describe, cell, imageUrlOf, safeUrl */

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

/**
 * DOM 构建器：
 *   el('div', { class: 'x', dataset: { id }, title }, child1, '纯文本', [child2, child3])
 * props 支持 class / text / dataset / 任意属性（setAttribute 自动转义）；
 * children 支持元素、字符串（转 textNode）、数组，null/undefined/false 自动跳过。
 */
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  const append = (child) => {
    if (child === null || child === undefined || child === false) return;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  };
  children.forEach((child) => (Array.isArray(child) ? child.forEach(append) : append(child)));
  return node;
}

const money = (value) => `¥${Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
const listOf = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const cell = (value) => (value === null || value === undefined || value === '' ? '—' : String(value));
// 商品图片统一取：SKU 图 → SPU 封面 → 轮播图首张；只接受 http(s) 或站内绝对路径。
const imageUrlOf = (product) => {
  const urls = [product?.imageUrl, product?.coverUrl, ...listOf(product?.gallery)];
  for (const value of urls) {
    const url = typeof value === 'string' ? value.trim() : '';
    if (/[\s"'<>]/.test(url)) continue; // 含引号/空白的 URL 一律丢弃，避免属性被污染
    if (/^https?:\/\//i.test(url) || (url.startsWith('/') && !url.startsWith('//'))) return url;
  }
  return '';
};
const safeUrl = (value) => {
  const url = String(value ?? '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
};
const scalar = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  if (isObject(value) || Array.isArray(value)) return JSON.stringify(value);
  return String(value);
};
const describe = (value) =>
  isObject(value)
    ? Object.entries(value).map(([k, v]) => `${k}：${scalar(v)}`).join('　')
    : scalar(value);

let toastTimer;
function toast(message) {
  const box = $('#toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), 3200);
}

/** 轻量确认弹窗：Esc / 背景点击 / 取消均为取消，默认焦点在"取消"（安全默认）。 */
function confirmDialog(title, text, okLabel = '确认执行') {
  return new Promise((resolve) => {
    const modal = $('#confirm-modal');
    const cancelBtn = $('#confirm-cancel');
    const okBtn = $('#confirm-ok');
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    okBtn.textContent = okLabel;
    modal.hidden = false;
    cancelBtn.focus();
    const close = (result) => {
      modal.hidden = true;
      document.removeEventListener('keydown', onKeydown);
      cancelBtn.removeEventListener('click', onCancel);
      okBtn.removeEventListener('click', onOk);
      modal.removeEventListener('click', onBackdrop);
      resolve(result);
    };
    const onKeydown = (event) => { if (event.key === 'Escape') close(false); };
    const onCancel = () => close(false);
    const onOk = () => close(true);
    const onBackdrop = (event) => { if (event.target === modal) close(false); };
    document.addEventListener('keydown', onKeydown);
    cancelBtn.addEventListener('click', onCancel);
    okBtn.addEventListener('click', onOk);
    modal.addEventListener('click', onBackdrop);
  });
}

function bindImages(container) {
  container.querySelectorAll('.product-thumb img, .mini-thumb img').forEach((img) => {
    img.addEventListener('error', () => {
      const placeholder = document.createElement('span');
      placeholder.textContent = '▧';
      img.replaceWith(placeholder);
    });
  });
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} 天前`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
