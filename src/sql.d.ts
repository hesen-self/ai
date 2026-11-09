/** Wrangler `rules: [{ type: "Text" }]` 把 .sql 文件作为字符串模块导入。 */
declare module '*.sql' {
  const content: string;
  export default content;
}
