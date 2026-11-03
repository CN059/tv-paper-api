import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, ArrowDownUp, Ban, Loader2, Play, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react';
import { api, tokenStore, type Account, type Health, type Order, type Position, type Snapshot } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Side = 'buy' | 'sell';
type OrderType = 'market' | 'limit' | 'stop';

interface Notice {
  kind: 'ok' | 'error';
  text: string;
}

const money = (value: number | null | undefined) =>
  typeof value === 'number'
    ? value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '--';

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [account, setAccount] = useState<string>('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [token, setToken] = useState(tokenStore.get());
  const [needsToken, setNeedsToken] = useState(false);

  // Order ticket state.
  const [symbol, setSymbol] = useState('NASDAQ:AAPL');
  const [side, setSide] = useState<Side>('buy');
  const [qty, setQty] = useState('1');
  const [orderType, setOrderType] = useState<OrderType>('market');
  const [price, setPrice] = useState('');
  const [sl, setSl] = useState('');
  const [tp, setTp] = useState('');

  const refresh = useCallback(async () => {
    try {
      const h = await api.health();
      setHealth(h);
      setNeedsToken(false);

      const list = await api.accounts();
      setAccounts(list.accounts);
      const preferred =
        account ||
        String(
          list.accounts.find((a) => a.default && !a.hidden)?.accountId ??
            list.accounts.find((a) => !a.hidden)?.accountId ??
            '',
        );
      if (preferred && preferred !== account) setAccount(preferred);

      setSnapshot(await api.snapshot(preferred || undefined));
      setNotice(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes('unauthorized')) setNeedsToken(true);
      else setNotice({ kind: 'error', text: message });
    }
  }, [account]);

  useEffect(() => {
    void refresh();
    // First paint only; refreshes are explicit so a slow endpoint cannot spam the API.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitOrder = async () => {
    setBusy(true);
    try {
      const body = {
        symbol,
        side,
        qty: Number(qty),
        type: orderType,
        ...(orderType !== 'market' && price ? { price: Number(price) } : {}),
        ...(sl ? { sl: Number(sl) } : {}),
        ...(tp ? { tp: Number(tp) } : {}),
        ...(account ? { account } : {}),
      };
      const result = await api.order(body);
      setNotice({ kind: 'ok', text: `Order ${result.response.id} accepted (${result.response.status})` });
      // Market orders fill asynchronously; give the server a moment before reading back.
      setTimeout(() => void refresh(), orderType === 'market' ? 1500 : 300);
    } catch (e) {
      setNotice({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const act = async (label: string, run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
      setNotice({ kind: 'ok', text: label });
      setTimeout(() => void refresh(), 800);
    } catch (e) {
      setNotice({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const positions = snapshot?.positions ?? [];
  const orders = snapshot?.orders ?? [];
  // Price is absent until a quote subscription exists, so exposure is only
  // meaningful when every open position has one; otherwise say so instead of
  // reporting a confident zero.
  const priced = positions.filter((p) => typeof p.price === 'number');
  const grossExposure = useMemo(
    () => priced.reduce((sum, p) => sum + Math.abs(p.qty) * (p.price ?? 0), 0),
    [priced],
  );
  const exposureLabel = positions.length === 0
    ? 'flat'
    : priced.length < positions.length
      ? 'gross n/a (no quotes)'
      : `gross ${money(grossExposure)}`;

  if (needsToken) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Access token required</CardTitle>
            <CardDescription>This deployment is protected. Paste its BRIDGE_TOKEN.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Input
              type="password"
              value={token}
              placeholder="token"
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  tokenStore.set(token);
                  void refresh();
                }
              }}
            />
            <Button
              onClick={() => {
                tokenStore.set(token);
                void refresh();
              }}
            >
              Connect
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">tv-paper-api</h1>
          <p className="text-sm text-muted-foreground">
            TradingView paper trading, driven from outside the app
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={health?.ok ? 'success' : 'destructive'}>
            <Activity className="size-3" />
            {health ? (health.ok ? health.mode : 'offline') : 'checking'}
          </Badge>
          {health?.mode === 'attached' && health.tvTarget ? (
            <Badge variant="outline">CDP {health.cdpPort}</Badge>
          ) : null}
          {accounts.length > 0 ? (
            <Select value={account} onValueChange={setAccount}>
              <SelectTrigger className="w-[168px]">
                <SelectValue placeholder="account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={String(a.accountId)} value={String(a.accountId)}>
                    {String(a.accountId)}
                    {a.default ? ' (default)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Button variant="outline" size="icon" onClick={() => void refresh()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
        </div>
      </header>

      {notice ? (
        <div
          className={
            notice.kind === 'ok'
              ? 'rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success'
              : 'rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive'
          }
        >
          {notice.text}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        {/* ---- order ticket ---- */}
        <Card>
          <CardHeader>
            <CardTitle>Order</CardTitle>
            <CardDescription>Buy/sell acts on the net position.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="symbol">Symbol</Label>
              <Input
                id="symbol"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                placeholder="NASDAQ:AAPL"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Button
                variant={side === 'buy' ? 'default' : 'outline'}
                onClick={() => setSide('buy')}
              >
                <TrendingUp /> Buy
              </Button>
              <Button
                variant={side === 'sell' ? 'destructive' : 'outline'}
                onClick={() => setSide('sell')}
              >
                <TrendingDown /> Sell
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1.5">
                <Label htmlFor="qty">Quantity</Label>
                <Input id="qty" value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" />
              </div>
              <div className="grid gap-1.5">
                <Label>Type</Label>
                <Select value={orderType} onValueChange={(v) => setOrderType(v as OrderType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="market">market</SelectItem>
                    <SelectItem value="limit">limit</SelectItem>
                    <SelectItem value="stop">stop</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {orderType !== 'market' ? (
              <div className="grid gap-1.5">
                <Label htmlFor="price">Limit / stop price</Label>
                <Input id="price" value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1.5">
                <Label htmlFor="sl">Stop loss</Label>
                <Input id="sl" value={sl} onChange={(e) => setSl(e.target.value)} placeholder="optional" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="tp">Take profit</Label>
                <Input id="tp" value={tp} onChange={(e) => setTp(e.target.value)} placeholder="optional" />
              </div>
            </div>

            <Button onClick={() => void submitOrder()} disabled={busy || !symbol.trim()}>
              <Play /> {side === 'buy' ? 'Buy' : 'Sell'} {symbol || 'symbol'}
            </Button>
            <p className="text-xs text-muted-foreground">
              Market orders return <code>pending</code>; the position appears once filled (1-5s).
            </p>
          </CardContent>
        </Card>

        {/* ---- positions + orders ---- */}
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle>Positions</CardTitle>
                <CardDescription>
                  {positions.length} open - {exposureLabel}
                </CardDescription>
              </div>
              <Badge variant="secondary">balance {money(snapshot?.balance)}</Badge>
            </CardHeader>
            <CardContent>
              {positions.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">Flat.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Symbol</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="text-right">P/L</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {positions.map((p) => (
                      <PositionRow key={p.symbol} position={p} busy={busy} act={act} account={account} />
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Open orders</CardTitle>
              <CardDescription>{orders.length} resting</CardDescription>
            </CardHeader>
            <CardContent>
              {orders.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">None.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Id</TableHead>
                      <TableHead>Symbol</TableHead>
                      <TableHead>Side</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orders.map((o) => (
                      <OrderRow key={o.id} order={o} busy={busy} act={act} account={account} />
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function PositionRow({
  position,
  busy,
  act,
  account,
}: {
  position: Position;
  busy: boolean;
  act: (label: string, run: () => Promise<unknown>) => Promise<void>;
  account: string;
}) {
  const long = position.qty > 0;
  return (
    <TableRow>
      <TableCell className="font-medium">{position.symbol}</TableCell>
      <TableCell className="tabular text-right">
        <Badge variant={long ? 'success' : 'destructive'}>
          {long ? '+' : ''}
          {position.qty}
        </Badge>
      </TableCell>
      <TableCell className="tabular text-right">{money(position.price ?? null)}</TableCell>
      <TableCell
        className={
          position.pl == null
            ? 'tabular text-right text-muted-foreground'
            : position.pl >= 0
              ? 'tabular text-right text-success'
              : 'tabular text-right text-destructive'
        }
      >
        {money(position.pl ?? null)}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void act(`Reversed ${position.symbol}`, () => api.reverse({ symbol: position.symbol, account }))
            }
          >
            <ArrowDownUp /> Reverse
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void act(`Closed ${position.symbol}`, () => api.close({ symbol: position.symbol, account }))}
          >
            <Ban /> Close
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function OrderRow({
  order,
  busy,
  act,
  account,
}: {
  order: Order;
  busy: boolean;
  act: (label: string, run: () => Promise<unknown>) => Promise<void>;
  account: string;
}) {
  return (
    <TableRow>
      <TableCell className="tabular text-muted-foreground">{order.id}</TableCell>
      <TableCell className="font-medium">{order.symbol}</TableCell>
      <TableCell>
        <Badge variant={order.side === 'buy' ? 'success' : 'destructive'}>{order.side}</Badge>
      </TableCell>
      <TableCell className="text-muted-foreground">{order.type}</TableCell>
      <TableCell className="tabular text-right">{order.qty}</TableCell>
      <TableCell className="tabular text-right">{order.price ? money(order.price) : '--'}</TableCell>
      <TableCell className="text-muted-foreground">{order.status}</TableCell>
      <TableCell className="text-right">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void act(`Cancelled ${order.id}`, () => api.cancel({ id: order.id, account }))}
        >
          <Ban /> Cancel
        </Button>
      </TableCell>
    </TableRow>
  );
}
