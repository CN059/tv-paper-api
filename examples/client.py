"""Minimal client for the local tv-paper-api bridge.

    pip install requests
    python examples/client.py

Start the bridge first:  npm run bridge
"""

import os

import requests

BASE = os.environ.get("BRIDGE_URL", "http://127.0.0.1:8787")
TOKEN = os.environ.get("BRIDGE_TOKEN", "")

_session = requests.Session()
if TOKEN:
    _session.headers["Authorization"] = f"Bearer {TOKEN}"


def _call(method: str, path: str, **kwargs):
    r = _session.request(method, f"{BASE}{path}", timeout=15, **kwargs)
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"{method} {path} failed: {data}")
    return data


def accounts():
    return _call("GET", "/accounts")


def positions():
    return _call("GET", "/positions")


def buy(symbol: str, qty: float, **extra):
    """Go long, or add to a long."""
    return _call("POST", "/order", json={"symbol": symbol, "side": "buy", "qty": qty, **extra})


def sell(symbol: str, qty: float, **extra):
    """Go short, or reduce a long."""
    return _call("POST", "/order", json={"symbol": symbol, "side": "sell", "qty": qty, **extra})


def close(symbol: str, qty: float | None = None):
    body = {"symbol": symbol}
    if qty is not None:
        body["qty"] = qty
    return _call("POST", "/close", json=body)


def reverse(symbol: str):
    """Flip long <-> short."""
    return _call("POST", "/reverse", json={"symbol": symbol})


def cancel(order_id: int):
    return _call("POST", "/cancel", json={"id": order_id})


def flatten(symbol: str, position_qty: float):
    """Close the current position in whichever direction it points."""
    if position_qty > 0:
        return sell(symbol, abs(position_qty))
    if position_qty < 0:
        return buy(symbol, abs(position_qty))
    return None


if __name__ == "__main__":
    print("accounts:", accounts())
    snapshot = positions()
    for p in snapshot.get("positions", []):
        print(f"  {p.get('symbol'):22} qty={p.get('qty')} price={p.get('price')} pl={p.get('pl')}")
    for o in snapshot.get("orders", []):
        print(f"  order {o.get('id')} {o.get('symbol')} {o.get('type')} {o.get('side')} {o.get('qty')} @{o.get('price')}")
