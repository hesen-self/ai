/* 站内信（通知抽屉）：状态、轮询、渲染与交互。渲染走 ui.js 的 el()，不使用 innerHTML。 */
/* exported NOTIFY_POLL_INTERVAL, fetchUnreadCount, fetchNotifications, updateNotifyBadge, renderNotifications, openNotifyDrawer, closeNotifyDrawer, startNotifyPolling, stopNotifyPolling */
/* global $, el, api, toast, state, formatTime, applyPath */

const NOTIFY_POLL_INTERVAL = 30000; // 30s 轮询一次未读数

async function fetchUnreadCount() {
  try {
    const { count } = await api('/api/notifications/unread-count');
    state.notifyUnread = count;
    updateNotifyBadge();
  } catch { /* 轮询静默失败，下一轮自动重试 */ }
}

async function fetchNotifications() {
  try {
    const { notifications, unreadCount } = await api('/api/notifications');
    state.notifications = notifications;
    state.notifyUnread = unreadCount;
    updateNotifyBadge();
    renderNotifications();
  } catch (error) {
    toast(error.message);
  }
}

function updateNotifyBadge() {
  const badge = $('#notify-badge');
  if (state.notifyUnread > 0) {
    badge.textContent = state.notifyUnread > 99 ? '99+' : state.notifyUnread;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function renderNotifications() {
  const list = $('#notify-list');
  if (!state.notifications.length) {
    list.replaceChildren(el('p', { class: 'muted notify-empty', text: '暂无通知' }));
    return;
  }
  const typeIcon = { system: '📢', product: '📦', chat: '💬', admin: '🛠' };
  list.replaceChildren(...state.notifications.map((n) => {
    const unread = !n.readAt;
    const link = n.payload?.link;
    const item = el('div', { class: `notify-item ${unread ? 'unread' : ''}`, dataset: { id: String(n.id), link: link || '' } },
      el('span', { class: 'notify-item-type', text: typeIcon[n.type] ?? '🔔' }),
      el('div', { class: 'notify-item-body' },
        el('div', { class: 'notify-item-head' },
          el('span', { class: 'notify-item-title', text: n.title }),
          el('span', { class: 'notify-item-time', text: formatTime(n.createdAt) })),
        n.content ? el('p', { class: 'notify-item-content', text: n.content }) : null),
      unread ? el('span', { class: 'notify-item-dot', 'aria-hidden': 'true' }) : null);

    // 点击条目：标记已读 + 跳转（如果有 link）
    item.addEventListener('click', async () => {
      const id = Number(item.dataset.id);
      let target = item.dataset.link;
      if (target) {
        closeNotifyDrawer();
        // 兼容旧 hash 格式（#/chat）和新 path 格式（/chat）
        if (target.startsWith('#')) target = target.slice(1);
        history.pushState(null, '', target);
        applyPath();
      }
      try {
        await api(`/api/notifications/${id}/read`, { method: 'POST' });
        // 乐观更新
        const found = state.notifications.find((x) => x.id === id);
        if (found) { found.readAt = new Date().toISOString(); state.notifyUnread = Math.max(0, state.notifyUnread - 1); }
        updateNotifyBadge();
        renderNotifications();
      } catch { /* 标记已读失败不阻断浏览，下次轮询会重试 */ }
    });
    return item;
  }));
}

function openNotifyDrawer() {
  state.notifyDrawerOpen = true;
  $('#notify-drawer').hidden = false;
  $('#notify-backdrop').hidden = false;
  fetchNotifications();
}

function closeNotifyDrawer() {
  state.notifyDrawerOpen = false;
  $('#notify-drawer').hidden = true;
  $('#notify-backdrop').hidden = true;
}

function startNotifyPolling() {
  fetchUnreadCount();
  stopNotifyPolling();
  state.notifyPollTimer = setInterval(() => {
    if (!state.notifyDrawerOpen) fetchUnreadCount();
  }, NOTIFY_POLL_INTERVAL);
}

function stopNotifyPolling() {
  if (state.notifyPollTimer) {
    clearInterval(state.notifyPollTimer);
    state.notifyPollTimer = null;
  }
}

// 事件绑定（铃铛 / 关闭 / 全部已读 / 背景点击）
document.addEventListener('DOMContentLoaded', () => {
  const bell = $('#notify-bell');
  if (!bell) return;
  bell.addEventListener('click', () => {
    if (state.notifyDrawerOpen) closeNotifyDrawer(); else openNotifyDrawer();
  });
  $('#notify-close')?.addEventListener('click', closeNotifyDrawer);
  $('#notify-backdrop')?.addEventListener('click', closeNotifyDrawer);
  $('#notify-mark-all')?.addEventListener('click', async () => {
    try {
      const { marked } = await api('/api/notifications/read-all', { method: 'POST' });
      if (marked > 0) {
        state.notifyUnread = 0;
        state.notifications.forEach((n) => (n.readAt = n.readAt || new Date().toISOString()));
        updateNotifyBadge();
        renderNotifications();
      }
    } catch (error) {
      toast(error.message);
    }
  });
});
