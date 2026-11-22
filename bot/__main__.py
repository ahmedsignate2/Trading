"""Point d'entrée : python -m bot <commande>

  backtest  Teste la stratégie sur l'historique (avec période hors échantillon)
  run       Lance le bot (paper par défaut, réel si mode: live dans la config)
"""
from __future__ import annotations

import argparse
import logging
from pathlib import Path

import pandas as pd

from .backtest import buy_and_hold, metrics, run_backtest
from .config import load_config
from .data import load_history

PCT = {"rendement_total", "rendement_annuel", "drawdown_max", "taux_reussite", "gain_moyen_trade"}


def fmt(m: dict) -> str:
    return "\n".join(
        f"  {k:<18} {v:>9.1%}" if k in PCT else f"  {k:<18} {v:>9.2f}" if isinstance(v, float)
        else f"  {k:<18} {v:>9}" for k, v in m.items())


def cmd_backtest(cfg, args) -> None:
    print(f"Téléchargement des bougies {cfg.granularity} depuis {cfg.history_start}…")
    data = {p: load_history(p, cfg.granularity, cfg.history_start) for p in cfg.products}
    for p, df in data.items():
        print(f"  {p}: {len(df)} bougies, {df.index[0]:%Y-%m-%d} → {df.index[-1]:%Y-%m-%d}")

    periods = [("Période complète", None, None)]
    if args.split:
        split = pd.Timestamp(args.split, tz="UTC")
        periods += [(f"Avant {args.split} (réglage)", None, split),
                    (f"Après {args.split} (hors échantillon)", split, None)]

    out = Path("results")
    out.mkdir(exist_ok=True)
    for name, start, end in periods:
        sub = {p: df[df.index < end] if end is not None else df for p, df in data.items()}
        res = run_backtest(sub, cfg.strategy, cfg.risk, cfg.costs, cfg.initial_cash, trade_from=start)
        eq = res.equity
        bh = buy_and_hold(sub, eq.index[0], eq.index[-1], cfg.initial_cash, cfg.costs.fee)
        print(f"\n=== {name} : {eq.index[0]:%Y-%m-%d} → {eq.index[-1]:%Y-%m-%d} ===")
        print(fmt(metrics(res)))
        print(f"  Référence achat-conservation : {bh['rendement_total']:+.1%} "
              f"(drawdown max {bh['drawdown_max']:.1%})")
        if res.halts:
            print(f"  ⚠️ Coupe-circuit déclenché : {res.halts}")
        if start is None and end is None:
            res.trades.to_csv(out / "trades.csv", index=False)
            res.equity.to_csv(out / "equity.csv")
    print("\nDétail des trades : results/trades.csv, courbe de capital : results/equity.csv")


def load_dotenv(path: str = ".env") -> None:
    """Charge les variables du fichier .env (sans écraser celles déjà définies)."""
    import os
    if not Path(path).exists():
        return
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def run_all(cfg, state_path: str) -> None:
    """Lance la boucle de trading, le bot Telegram et le tableau de bord ensemble."""
    import signal
    import threading

    from .dashboard import serve
    from .live import LiveBot
    from .telegram_bot import TelegramController

    bot = LiveBot(cfg, state_path)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    threads = [
        threading.Thread(target=TelegramController(bot).run, args=(stop,), name="telegram", daemon=True),
        threading.Thread(target=serve, args=(bot, stop, cfg.dashboard_host, cfg.dashboard_port),
                         name="dashboard", daemon=True),
    ]
    for t in threads:
        t.start()
    try:
        bot.run(stop)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        logging.getLogger("bot").info("Arrêt du bot.")


def main() -> None:
    load_dotenv()
    ap = argparse.ArgumentParser(prog="bot", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["backtest", "run"])
    ap.add_argument("--config", default="config.yaml")
    ap.add_argument("--split", help="date de séparation réglage / hors échantillon, ex. 2024-01-01")
    ap.add_argument("--state", help="fichier d'état du bot (défaut : state/<mode>.json)")
    args = ap.parse_args()

    Path("logs").mkdir(exist_ok=True)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        handlers=[logging.StreamHandler(), logging.FileHandler("logs/bot.log")])
    cfg = load_config(args.config)

    if args.command == "backtest":
        cmd_backtest(cfg, args)
    else:
        run_all(cfg, args.state or f"state/{cfg.mode}.json")


if __name__ == "__main__":
    main()
