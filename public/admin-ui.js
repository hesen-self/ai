/* 运维控制台交互：状态查询、迁移（带二次确认）、知识库构建与 AI Search 同步。 */
/* exported adminHeaders, output, adminAction */
/* global $, api, toast, confirmDialog, state */

function adminHeaders() {
  state.adminToken = $('#admin-token').value.trim();
  sessionStorage.setItem('cf_admin_token', state.adminToken);
  return { 'X-Admin-Token': state.adminToken };
}

function output(value) {
  $('#admin-output').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

async function adminAction(label, path, body) {
  try {
    output(`${label}…`);
    const result = await api(path, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify(body || {}),
    });
    output(result);
    toast(`${label}完成`);
  } catch (error) {
    output(`${label}失败：${error.message}`);
  }
}

$('#admin-status-btn').addEventListener('click', async () => {
  try {
    const result = await api('/api/admin/status', { headers: adminHeaders() });
    output(result);
  } catch (error) {
    output(`状态读取失败：${error.message}`);
  }
});

$('#admin-migrate-btn').addEventListener('click', async () => {
  const confirmed = await confirmDialog(
    '执行数据库迁移？',
    '迁移会按顺序执行 sql/ 下尚未应用的迁移文件，可能改动表结构。确认继续？',
  );
  if (confirmed) await adminAction('数据库迁移', '/api/admin/migrate');
});
$('#admin-knowledge-btn').addEventListener('click', async () => {
  await adminAction('知识库构建（第 1 批）', '/api/admin/build-knowledge', { offset: 0, limit: 120 });
  toast('如需全量构建，请运行 npm run ingest:knowledge');
});
$('#admin-ai-status-btn').addEventListener('click', async () => {
  try {
    const result = await api('/api/admin/ai-search/status', { headers: adminHeaders() });
    output(result.aiSearch ?? result);
  } catch (error) {
    output(`AI Search 状态读取失败：${error.message}`);
  }
});
$('#admin-ai-sync-btn').addEventListener('click', () =>
  adminAction('AI Search 知识库同步（第 1 批）', '/api/admin/ai-search/sync', {
    kind: 'kb', offset: 0, limit: 40,
  }),
);
$('#admin-schema-btn').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/admin/schema', { headers: adminHeaders() });
    output(await response.text());
  } catch (error) {
    output(`DDL 读取失败：${error.message}`);
  }
});
