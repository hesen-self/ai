// ESLint 扁平配置（ESLint 10）。
// 说明：src/**/*.ts 暂不纳入 ESLint —— typescript-eslint 官方 peer 仅支持
// typescript >=4.8.4 <6.1.0，而本项目使用 typescript@7（tsgo，主入口不再导出
// createSourceFile 等经典 JS API），两者不兼容。TypeScript 侧校验继续由
// `tsc --noEmit`（strict 模式）与 dev-governor 规则承担。
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '.wrangler/**',
      'public/vendor/**',
      '.workbuddy/**',
    ],
  },

  // 全局：使用 ESLint 官方推荐规则
  js.configs.recommended,

  // scripts/*.mjs：Node.js CLI 脚本
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // public/*.js：浏览器端经典脚本（非 ES 模块），按 index.html 顺序加载，
  // 顶层声明经全局词法作用域跨文件共享；跨文件引用用文件头部
  // /* global */ 与 /* exported */ 指令声明（sourceType 为 script 时生效）。
  {
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: globals.browser,
    },
  },

  // 本配置文件自身：Node.js ESM
  {
    files: ['eslint.config.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
];
