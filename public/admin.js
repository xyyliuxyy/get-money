const csrf = document.querySelector('meta[name="csrf-token"]')?.content ?? '';
const feedback = document.querySelector('#page-feedback');
const escapeHtml = (value) => String(value ?? '-').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
const json = async (path, options = {}) => { const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...(options.headers ?? {}) } }); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || 'Request failed'); return body; };
const show = (message, bad = false) => { if (feedback) { feedback.textContent = message; feedback.classList.toggle('is-error', bad); } };
const login = document.querySelector('#admin-login-form');
if (login) login.addEventListener('submit', async (event) => { event.preventDefault(); const data = new FormData(login); try { await json('/api/admin/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(data)) }); location.assign('/admin'); } catch (error) { show(error.message, true); } });
const tbody = document.querySelector('#orders'); let selected;
async function load() {
  if (!tbody) return;
  const query = new URLSearchParams({ status: document.querySelector('#status').value, search: document.querySelector('#search').value });
  try {
    const { orders } = await json(`/api/admin/orders?${query}`);
    tbody.innerHTML = orders.map((order) => {
      const retryable = order.status === 'recharge_failed' || (order.status === 'approved' && order.callback_status === 'failed');
      const reference = order.trade_no || order.external_order_no;
      const actions = retryable
        ? `<button data-retry="${escapeHtml(order.order_no)}">Retry</button>`
        : `<button data-approve="${escapeHtml(order.order_no)}" data-amount="${Number(order.amount_fen)}" data-user="${Number(order.user_id)}">Approve</button> <button data-reject="${escapeHtml(order.order_no)}">Reject</button>`;
      return `<tr><td>${escapeHtml(order.order_no)}</td><td>#${escapeHtml(order.user_id)}</td><td>${(Number(order.amount_fen) / 100).toFixed(2)}</td><td>${escapeHtml(reference)}</td><td>${escapeHtml(order.status)}</td><td>${actions}</td></tr>`;
    }).join('');
  } catch (error) { show(error.message, true); }
}
document.querySelector('#search')?.addEventListener('input', load);
document.querySelector('#status')?.addEventListener('change', load);
document.querySelector('#logout')?.addEventListener('click', async () => { await json('/api/admin/logout', { method: 'POST', body: '{}' }); location.assign('/admin/login'); });
tbody?.addEventListener('click', async (event) => { const button = event.target.closest('button'); if (!button) return; const orderNo = button.dataset.approve || button.dataset.reject || button.dataset.retry; try { if (button.dataset.approve) { selected = orderNo; document.querySelector('#approve-copy').textContent = `Approve ${(Number(button.dataset.amount) / 100).toFixed(2)} for user #${button.dataset.user}?`; document.querySelector('#approve-dialog').showModal(); return; } if (button.dataset.reject) { const reason = prompt('Rejection reason'); if (!reason) return; await json(`/api/admin/orders/${orderNo}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }); } if (button.dataset.retry) await json(`/api/admin/orders/${orderNo}/retry`, { method: 'POST', body: '{}' }); await load(); } catch (error) { show(error.message, true); } });
document.querySelector('#approve-confirm')?.addEventListener('click', async (event) => { event.preventDefault(); try { await json(`/api/admin/orders/${selected}/approve`, { method: 'POST', body: '{}' }); document.querySelector('#approve-dialog').close(); await load(); } catch (error) { show(error.message, true); } });
if (tbody) load();
