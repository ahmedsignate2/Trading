"""Exécution des ordres : simulation (paper) ou Coinbase réel."""
from __future__ import annotations

import logging
import os
import time
import uuid
from decimal import ROUND_DOWN, Decimal

log = logging.getLogger("bot")


class PaperBroker:
    """Simule les ordres au marché avec frais et glissement. Aucun argent réel."""

    def __init__(self, cash: float, positions: dict | None = None,
                 fee: float = 0.006, slippage: float = 0.0005):
        self.cash = cash
        self.holdings: dict[str, float] = positions or {}
        self.fee, self.slippage = fee, slippage

    def usd_balance(self) -> float:
        return self.cash

    def base_balance(self, product: str) -> float:
        return self.holdings.get(product, 0.0)

    def buy(self, product: str, usd: float, price: float) -> tuple[float, float]:
        fill = price * (1 + self.slippage)
        qty = usd * (1 - self.fee) / fill
        self.cash -= usd
        self.holdings[product] = self.holdings.get(product, 0.0) + qty
        return qty, fill

    def sell(self, product: str, qty: float, price: float) -> tuple[float, float]:
        fill = price * (1 - self.slippage)
        self.cash += qty * fill * (1 - self.fee)
        self.holdings[product] = max(0.0, self.holdings.get(product, 0.0) - qty)
        return qty, fill


class CoinbaseBroker:
    """Ordres réels via l'API Coinbase Advanced Trade.

    Clés lues dans les variables d'environnement COINBASE_API_KEY et COINBASE_API_SECRET
    (clé CDP créée sur https://portal.cdp.coinbase.com, droits « trade » uniquement,
    jamais de droit de retrait).
    """

    def __init__(self, quote_currency: str = "USD"):
        from coinbase.rest import RESTClient  # import tardif : inutile en mode paper

        key, secret = os.environ.get("COINBASE_API_KEY"), os.environ.get("COINBASE_API_SECRET")
        if not key or not secret:
            raise RuntimeError("COINBASE_API_KEY / COINBASE_API_SECRET manquantes")
        self.client = RESTClient(api_key=key, api_secret=secret.replace("\\n", "\n"))
        self.quote = quote_currency
        self._increments: dict[str, str] = {}

    def _balances(self) -> dict[str, float]:
        out, cursor = {}, None
        while True:
            resp = self.client.get_accounts(limit=250, cursor=cursor).to_dict()
            for a in resp.get("accounts", []):
                out[a["currency"]] = out.get(a["currency"], 0.0) + float(a["available_balance"]["value"])
            if not resp.get("has_next"):
                return out
            cursor = resp.get("cursor")

    def usd_balance(self) -> float:
        return self._balances().get(self.quote, 0.0)

    def base_balance(self, product: str) -> float:
        return self._balances().get(product.split("-")[0], 0.0)

    def _round_base(self, product: str, qty: float) -> str:
        if product not in self._increments:
            self._increments[product] = self.client.get_product(product).to_dict()["base_increment"]
        inc = Decimal(self._increments[product])
        return str((Decimal(str(qty)) / inc).to_integral_value(rounding=ROUND_DOWN) * inc)

    def _check(self, resp, action: str) -> dict:
        d = resp.to_dict()
        if not d.get("success"):
            raise RuntimeError(f"Ordre {action} refusé : {d.get('error_response') or d}")
        return d

    def _fill(self, order_id: str) -> tuple[float, float]:
        for _ in range(10):  # un ordre au marché est rempli en quelques instants
            o = self.client.get_order(order_id).to_dict()["order"]
            if o.get("status") in ("FILLED", "CANCELLED", "EXPIRED", "FAILED"):
                break
            time.sleep(1)
        return float(o.get("filled_size") or 0), float(o.get("average_filled_price") or 0)

    def buy(self, product: str, usd: float, price: float) -> tuple[float, float]:
        d = self._check(self.client.market_order_buy(
            client_order_id=str(uuid.uuid4()), product_id=product, quote_size=f"{usd:.2f}"), "achat")
        qty, fill = self._fill(d["success_response"]["order_id"])
        return qty, fill or price

    def sell(self, product: str, qty: float, price: float) -> tuple[float, float]:
        d = self._check(self.client.market_order_sell(
            client_order_id=str(uuid.uuid4()), product_id=product,
            base_size=self._round_base(product, qty)), "vente")
        sold, fill = self._fill(d["success_response"]["order_id"])
        return sold, fill or price
