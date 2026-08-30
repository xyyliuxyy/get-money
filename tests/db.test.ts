import { afterEach, describe, expect, it } from 'vitest';
import { createDatabaseStore, type DatabaseStore, type NewOrder } from '../src/db.js';

const now = '2026-08-30T12:00:00.000Z';
const later = '2026-08-30T12:05:00.000Z';

function makeOrder(overrides: Partial<NewOrder> = {}): NewOrder {
  return {
    orderNo: 'S2P20260830ORDERA',
    userId: 7,
    usernameSnapshot: 'alice',
    emailSnapshot: 'alice@example.test',
    amountFen: 5000,
    balanceValue: '50',
    paymentMethod: 'alipay_manual',
    status: 'awaiting_payment',
    rechargeCode: 'manual_S2P20260830ORDERA',
    createdAt: now,
    expiresAt: '2026-08-31T12:00:00.000Z',
    ...overrides,
  };
}

describe('SQLite database store', () => {
  const stores: DatabaseStore[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) {
      store.close();
    }
  });

  function createStore(): DatabaseStore {
    const store = createDatabaseStore(':memory:');
    stores.push(store);
    return store;
  }

  it('rejects a transaction number assigned to another order', () => {
    const store = createStore();
    const orderA = makeOrder();
    const orderB = makeOrder({
      orderNo: 'S2P20260830ORDERB',
      userId: 8,
      rechargeCode: 'manual_S2P20260830ORDERB',
    });

    store.createOrder(orderA);
    store.createOrder(orderB);
    store.submitTransaction(orderA.orderNo, 7, '20260830ABCDE', null, null);

    expect(() => store.submitTransaction(orderB.orderNo, 8, '20260830ABCDE', null, null))
      .toThrow(/UNIQUE constraint failed: orders.trade_no/);
  });

  it('allows exactly one recharge claim', () => {
    const store = createStore();
    const pendingOrder = makeOrder({ status: 'pending_review' });

    store.createOrder(pendingOrder);

    expect(store.claimRecharge(pendingOrder.orderNo, now)).toMatchObject({
      status: 'processing',
      processingAt: now,
      rechargeAttempts: 1,
    });
    expect(store.claimRecharge(pendingOrder.orderNo, now)).toBeNull();
  });

  it('returns only an unexpired session matching its token hash', () => {
    const store = createStore();

    store.createSession({
      tokenHash: 'session-hash',
      actorType: 'user',
      userId: 7,
      usernameSnapshot: 'alice',
      emailSnapshot: 'alice@example.test',
      csrfSecret: 'csrf-secret',
      createdAt: now,
      expiresAt: '2026-08-31T12:00:00.000Z',
    });

    expect(store.getSession('session-hash', now)).toMatchObject({ actorType: 'user', userId: 7 });
    expect(store.getSession('session-hash', '2026-09-01T12:00:00.000Z')).toBeNull();
    expect(store.getSession('other-session', now)).toBeNull();
  });

  it('returns an order only for its owner', () => {
    const store = createStore();
    const order = makeOrder();

    store.createOrder(order);

    expect(store.findOrderForUser(order.orderNo, 7)?.orderNo).toBe(order.orderNo);
    expect(store.findOrderForUser(order.orderNo, 8)).toBeNull();
  });

  it('finishes only a claimed order without changing immutable identity fields', () => {
    const store = createStore();
    const order = makeOrder({ status: 'pending_review' });

    store.createOrder(order);
    expect(store.finishRecharge(order.orderNo, 'approved', later, null)).toBeNull();

    store.claimRecharge(order.orderNo, now);
    expect(store.finishRecharge(order.orderNo, 'approved', later, null)).toMatchObject({
      status: 'approved',
      approvedAt: later,
      userId: order.userId,
      amountFen: order.amountFen,
      rechargeCode: order.rechargeCode,
      tradeNo: null,
    });
  });

  it('rejects only a pending-review order and records the review details', () => {
    const store = createStore();
    const order = makeOrder({ status: 'pending_review' });

    store.createOrder(order);

    expect(store.rejectOrder(order.orderNo, 'payment not found', 'checked bank feed', now)).toMatchObject({
      status: 'rejected',
      rejectionReason: 'payment not found',
      adminNote: 'checked bank feed',
      reviewedAt: now,
      rejectedAt: now,
    });
    expect(store.rejectOrder(order.orderNo, 'payment not found', 'checked bank feed', later)).toBeNull();
  });

  it('lists administrator orders by status and parameterized search', () => {
    const store = createStore();
    const pendingOrder = makeOrder({ status: 'pending_review' });
    const otherOrder = makeOrder({
      orderNo: 'S2P20260830ORDERB',
      userId: 8,
      emailSnapshot: 'bob@example.test',
      rechargeCode: 'manual_S2P20260830ORDERB',
      status: 'awaiting_payment',
    });

    store.createOrder(pendingOrder);
    store.createOrder(otherOrder);

    expect(store.listAdminOrders({ statuses: ['pending_review'] }).map((order) => order.orderNo))
      .toEqual([pendingOrder.orderNo]);
    expect(store.listAdminOrders({ search: 'bob@example.test' }).map((order) => order.orderNo))
      .toEqual([otherOrder.orderNo]);
  });

  it('writes immutable administrator audit records', () => {
    const store = createStore();

    expect(store.writeAuditLog({
      adminName: 'admin',
      action: 'reject',
      orderNo: 'S2P20260830ORDERA',
      oldStatus: 'pending_review',
      newStatus: 'rejected',
      ip: '127.0.0.1',
      userAgent: 'Vitest',
      detail: 'payment not found',
      createdAt: now,
    })).toMatchObject({ action: 'reject', oldStatus: 'pending_review', newStatus: 'rejected' });
  });
});
