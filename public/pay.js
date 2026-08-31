const csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
const feedback = document.querySelector('#page-feedback');

function showFeedback(message, isError = false) {
  if (!feedback) return;
  feedback.textContent = message;
  feedback.classList.toggle('is-error', isError);
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken ?? '',
      ...(options.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : '请求未能完成，请稍后重试。');
  return body;
}

document.querySelector('#order-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const amount = new FormData(form).get('amount_cny');
  try {
    await requestJson('/api/orders', { method: 'POST', body: JSON.stringify({ amount_cny: amount }) });
    window.location.assign('/pay');
  } catch (error) {
    showFeedback(error instanceof Error ? error.message : '请求未能完成，请稍后重试。', true);
  }
});

document.querySelector('#payment-proof-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const orderNo = form.dataset.orderNo;
  if (!orderNo) return;
  const values = new FormData(form);
  try {
    await requestJson(`/api/orders/${encodeURIComponent(orderNo)}/submit`, {
      method: 'POST',
      body: JSON.stringify({ trade_no: values.get('trade_no'), note: values.get('note') }),
    });
    window.location.assign('/pay');
  } catch (error) {
    showFeedback(error instanceof Error ? error.message : '请求未能完成，请稍后重试。', true);
  }
});

document.querySelector('[data-cancel-order]')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const orderNo = button.dataset.cancelOrder;
  if (!orderNo) return;
  try {
    await requestJson(`/api/orders/${encodeURIComponent(orderNo)}/cancel`, { method: 'POST', body: '{}' });
    window.location.assign('/pay');
  } catch (error) {
    showFeedback(error instanceof Error ? error.message : '请求未能完成，请稍后重试。', true);
  }
});

const activeOrder = document.querySelector('[data-order-no][data-order-status]');
if (activeOrder) {
  const orderNo = activeOrder.dataset.orderNo;
  const initialStatus = activeOrder.dataset.orderStatus;
  window.setInterval(async () => {
    if (!orderNo) return;
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(orderNo)}`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return;
      const order = await response.json();
      if (order.status !== initialStatus) window.location.reload();
    } catch {
      // Polling failures are transient and should not interrupt data entry.
    }
  }, 15_000);
}
