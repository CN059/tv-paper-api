/**
 * Unit tests: request validation and shim self-containment.
 * These must pass with no TradingView running.
 */
import { describe, expect, test } from 'bun:test';
import { pageShim } from '../src/page-shim.ts';
import { placeOrder } from '../src/driver.ts';

describe('page shim serialisation', () => {
  test('stringifies to a self-contained function', () => {
    const source = pageShim.toString();

    // Bun strips the TypeScript before stringifying, so what we inject is plain JS.
    expect(source).not.toContain(': Promise<');
    expect(source).not.toContain('import type');
    // No module-scope references: everything it needs is defined inside.
    expect(source).not.toContain('CHART_URL_MATCH');
    expect(source).not.toMatch(/\brequire\(/);
    expect(source).not.toMatch(/\bfrom\s*['"]\.\//);
  });

  test('is a function once evaluated', () => {
    const rebuilt = new Function(`return (${pageShim.toString()})`)();
    expect(typeof rebuilt).toBe('function');
  });
});

describe('order validation', () => {
  const driver = { port: 9333 };

  test('rejects a missing symbol before touching the page', async () => {
    await expect(placeOrder(driver, { symbol: '', side: 'buy', qty: 1 })).rejects.toThrow(
      'symbol is required',
    );
  });

  test('rejects a blank symbol', async () => {
    await expect(placeOrder(driver, { symbol: '   ', side: 'buy', qty: 1 })).rejects.toThrow(
      'symbol is required',
    );
  });

  test('rejects an unknown side', async () => {
    await expect(
      placeOrder(driver, { symbol: 'NASDAQ:AAPL', side: 'hold' as 'buy', qty: 1 }),
    ).rejects.toThrow("side must be 'buy' or 'sell'");
  });

  test('rejects zero and negative quantity', async () => {
    for (const qty of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(placeOrder(driver, { symbol: 'NASDAQ:AAPL', side: 'buy', qty })).rejects.toThrow(
        'qty must be a positive number',
      );
    }
  });

  test('rejects limit orders without a price', async () => {
    await expect(
      placeOrder(driver, { symbol: 'NASDAQ:AAPL', side: 'buy', qty: 1, type: 'limit' }),
    ).rejects.toThrow('price is required for limit orders');
  });

  test('rejects stop orders without a price', async () => {
    await expect(
      placeOrder(driver, { symbol: 'NASDAQ:AAPL', side: 'sell', qty: 1, type: 'stop' }),
    ).rejects.toThrow('price is required for stop orders');
  });

  test('rejects a negative stop loss', async () => {
    await expect(
      placeOrder(driver, { symbol: 'NASDAQ:AAPL', side: 'buy', qty: 1, sl: -5 }),
    ).rejects.toThrow('sl must be a positive number');
  });
});
