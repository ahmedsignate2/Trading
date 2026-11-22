# Bot de trading crypto (Coinbase)

Bot de swing trading en spot sur Coinbase (BTC, ETH, SOL), en bougies journalières.
Il suit la tendance, n'achète que pour revendre plus haut (pas de vente à découvert, pas de levier)
et applique une gestion du risque stricte.

> ⚠️ **Aucune garantie de gain.** Le trading peut faire perdre tout le capital engagé.
> Commencez par le backtest, puis par le mode paper (argent fictif) pendant plusieurs semaines.

## La stratégie

| Élément | Règle |
|---|---|
| Filtre de tendance | Clôture > EMA 200 **et** EMA 50 > EMA 200 |
| Entrée | Clôture au-dessus du plus haut des 20 derniers jours |
| Stop initial | Prix d'entrée − 2,5 × ATR |
| Stop suiveur | Plus haute clôture depuis l'entrée − 3 × ATR (ne redescend jamais) |
| Sortie de tendance | Clôture sous l'EMA 200 |
| Taille | 1 % du capital risqué par trade, 33 % max par crypto |
| Coupe-circuits | −3 % dans la journée : plus d'entrée ; −20 % depuis le plus haut : arrêt total et liquidation |

## Résultats du backtest (frais Coinbase 0,6 % par ordre inclus)

Réglages choisis **uniquement** sur 2020-2023, puis vérifiés une seule fois sur 2024-2026.

| Période | Bot | Drawdown max | Achat-conservation | Drawdown max |
|---|---|---|---|---|
| 2020 → 2023 (réglage) | **+25,2 %** | −3,9 % | +761,7 % | −81,7 % |
| 2024 → nov. 2026 (contrôle) | **−2,8 %** | −5,9 % | −10,2 % | −62,3 % |
| Total 2020 → 2026 | **+21,3 %** | −6,0 % | +664,9 % | −81,7 % |

Lecture honnête :
- Le bot **protège très bien le capital** (perte maximale ≈ 6 % contre 60-80 % en gardant les cryptos).
- Il **gagne beaucoup moins** qu'un simple achat-conservation en marché haussier, car il ne risque que 1 % par trade.
- Sur la période de contrôle 2024-2026, il **perd légèrement** (−2,8 %). L'avantage de la stratégie
  n'est donc **pas prouvé** : la majorité des gains viennent du marché haussier de 2020-2021.
- En bougies 4h, les frais de Coinbase absorbent presque tout le gain : c'est pour ça que le bot est en journalier.

## Installation

```bash
pip install -r requirements.txt
```

## Utilisation

```bash
# 1. Backtest (télécharge l'historique Coinbase, aucune clé nécessaire)
python -m bot backtest --split 2024-01-01

# 2. Simulation en temps réel avec de l'argent fictif (mode: paper dans config.yaml)
python -m bot run

# 3. Tests automatiques
python -m pytest tests
```

Tous les réglages sont dans `config.yaml`. Les trades du backtest sont exportés dans `results/`,
le journal du bot dans `logs/bot.log`, son état (positions, stops) dans `state/`.

## Hébergement Cloudflare (bot, Telegram et tableau de bord)

Le bot tourne entièrement sur Cloudflare, sans machine personnelle :

| Élément | Rôle |
|---|---|
| Worker `trading-bot` | Code du bot (dossier `worker/`, en TypeScript) |
| Déclencheur toutes les minutes | Vérifie les stops, applique la stratégie à chaque clôture journalière |
| Base D1 `trading-bot` | Positions, capital, journal des trades et des événements |
| `https://trading-bot.ahamedsignate2.workers.dev` | Tableau de bord (mot de passe) et webhook Telegram |

Le Worker utilise exactement la même stratégie que le backtest Python : `worker/test/parity.test.mjs`
vérifie que les signaux sont identiques sur l'historique réel.

### Secrets à ajouter (une seule fois)

Cloudflare → Workers & Pages → `trading-bot` → Settings → Variables and Secrets → Add (type *Secret*) :

| Nom | Valeur |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Jeton donné par @BotFather (`/newbot`) |
| `TELEGRAM_CHAT_ID` | Votre identifiant Telegram (envoyez un message à @userinfobot) |
| `DASHBOARD_PASSWORD` | Mot de passe du tableau de bord (8 caractères minimum) |

Le webhook Telegram s'enregistre tout seul dans la minute qui suit. `TELEGRAM_WEBHOOK_SECRET`
est déjà configuré. Le bot n'obéit qu'à votre identifiant Telegram ; les ventes manuelles
demandent `/confirmer`.

### Commandes Telegram

`/statut` `/positions` `/prix` `/signaux` `/journal` `/perf` `/pause` `/reprendre`
`/vendre BTC` `/vendre_tout` `/reset_coupe_circuit` `/confirmer` `/dashboard` `/aide`

### Modifier le Worker

```bash
cd worker && npm install
npm test            # parité avec Python
npm run typecheck
npm run build       # produit dist/worker.js
```

### Argent réel (Coinbase)

Le Worker passe de vrais ordres au marché sur Coinbase quand `MODE=live` et que les secrets
`COINBASE_API_KEY` / `COINBASE_API_SECRET` sont présents (clé CDP avec droits **View + Trade**,
jamais **Transfer**). Sans ces secrets, il ne passe aucun ordre et le signale sur Telegram.

| Variable | Valeur actuelle | Rôle |
|---|---|---|
| `MODE` | `live` | `live` = argent réel, autre valeur = simulation |
| `QUOTE` | `EUR` | Devise du compte : paires BTC-EUR, ETH-EUR, SOL-EUR |
| `MAX_ORDER` | `50` | Plafond par ordre, dans la devise du compte |

Commande Telegram `/solde` : soldes réels du compte Coinbase.

## Passer en argent réel (plus tard, seulement après le mode paper)

1. Créez une clé API sur <https://portal.cdp.coinbase.com> avec les droits **View + Trade uniquement**
   (jamais **Transfer** : la clé ne doit pas pouvoir retirer des fonds).
2. Copiez `.env.example` en `.env` et remplissez les clés. Ce fichier n'est jamais envoyé sur GitHub.
3. Dans `config.yaml` : `mode: live`, et un `max_order_usd` petit au départ.
4. Dans `.env` : `BOT_CONFIRM_LIVE=oui`. Sans ça, le bot refuse de démarrer en réel.
5. Faites tourner le bot sur une machine allumée en continu (petit serveur VPS).

Les stops sont gérés par le bot (vérification chaque minute) : s'il est arrêté, les stops ne
sont plus surveillés.

## Alertes Telegram (facultatif)

Renseignez `TELEGRAM_BOT_TOKEN` et `TELEGRAM_CHAT_ID` dans `.env` pour recevoir chaque achat,
vente, erreur et déclenchement de coupe-circuit sur votre téléphone.

## Organisation du code

```
bot/
  data.py      bougies et prix Coinbase (API publique)
  strategy.py  indicateurs et règles d'entrée/sortie
  risk.py      taille des positions et coupe-circuits
  backtest.py  simulation historique sans biais d'anticipation
  broker.py    exécution : PaperBroker (fictif) et CoinbaseBroker (réel)
  live.py      boucle du bot en temps réel
config.yaml    tous les réglages
```
