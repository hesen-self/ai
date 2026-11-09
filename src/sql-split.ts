/**
 * 把 SQL 文本拆成单条语句，供 `sql.unsafe(statement)` 逐条执行。
 * 处理行/块注释、单引号与双引号字符串（含重复引号转义）、$tag$ dollar-quoted 块，
 * 因此后续迁移里写函数、触发器也不会被字符串里的分号切断。
 *
 * 纯函数、无 Worker 绑定依赖，可用 Node 直接跑测试：
 *   node --experimental-strip-types scripts/... （import 本文件即可）
 */
export function splitStatements(source: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  let quote: "'" | '"' | null = null;
  let dollarTag: string | null = null;
  let lineComment = false;
  let blockComment = false;

  const push = (): void => {
    const trimmed = current.trim();
    if (trimmed) statements.push(trimmed);
    current = '';
  };

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === '\n') {
        lineComment = false;
        current += ch;
      }
      i += 1;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (dollarTag) {
      if (source.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        current += ch;
        i += 1;
      }
      continue;
    }
    if (quote) {
      current += ch;
      i += 1;
      if (ch === quote) {
        if (source[i] === quote) {
          current += quote;
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      lineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/.exec(source.slice(i));
      if (tag) {
        dollarTag = tag[0];
        current += tag[0];
        i += tag[0].length;
        continue;
      }
    }
    if (ch === ';') {
      push();
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  push();
  return statements;
}
