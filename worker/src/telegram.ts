// Commandes Telegram reçues par webhook. Seul TELEGRAM_CHAT_ID est obéi.
import type { Bot, Env } from "./bot";


const CONFIRM_MS = 60_000;

export const COMMANDS: [string, string][] = [
  ["statut", "Capital, performance du jour, état du bot"],
  ["positions", "Positions ouvertes avec gain et stop"],
  ["prix", "Prix actuels"],
  ["solde", "Soldes du compte Coinbase (mode réel)"],
  ["signaux", "Distance de chaque crypto à un signal d'achat"],
  ["journal", "Derniers trades (ex. /journal 20)"],
  ["perf", "Bilan des trades réalisés"],
  ["pause", "Bloque les nouveaux achats (les stops restent actifs)"],
  ["reprendre", "Réautorise les achats"],
  ["vendre", "Vend une position (ex. /vendre BTC)"],
  ["vendre_tout", "Vend toutes les positions et met en pause"],
  ["reset_coupe_circuit", "Relance le bot après un coupe-circuit"],
  ["confirmer", "Confirme la dernière action sensible"],
  ["dashboard", "Lien vers le tableau de bord"],
  ["aide", "Liste des commandes"],
];

const money = (x: number) => x.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " $";
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2).replace(".", ",")} %`;

export async function tg(env: Env, method: string, params: object): Promise<any> {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params),
  });
  return r.json();
}

export async function sendTelegram(env: Env, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  for (let i = 0; i < text.length; i += 4000) {
    await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text: text.slice(i, i + 4000) });
  }
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Enregistre le webhook et le menu des commandes dès que le jeton Telegram est configuré. */
export async function ensureWebhook(bot: Bot): Promise<void> {
  const env = bot.env;
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET || !env.PUBLIC_URL) return;
  const key = await sha256(`${env.TELEGRAM_BOT_TOKEN}|${env.TELEGRAM_WEBHOOK_SECRET}|${env.PUBLIC_URL}`);
  const acc = await bot.account();
  if (acc.webhook_key === key) return;
  const r = await tg(env, "setWebhook", {
    url: `${env.PUBLIC_URL}/telegram`, secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message"], drop_pending_updates: true,
  });
  if (!r.ok) throw new Error(`setWebhook Telegram : ${r.description}`);
  await tg(env, "setMyCommands", { commands: COMMANDS.map(([command, description]) => ({ command, description })) });
  await bot.env.DB.prepare("UPDATE account SET webhook_key = ? WHERE id = 1").bind(key).run();
  await bot.say(`Bot connecté à Telegram en mode ${bot.mode === "live" ? "ARGENT RÉEL" : "SIMULATION"}. /aide pour les commandes.`);
}

/** Traite une mise à jour Telegram. Renvoie la réponse à envoyer (ou "" si rien). */
export async function handleUpdate(bot: Bot, update: any): Promise<string> {
  const msg = update?.message;
  const text: string = (msg?.text ?? "").trim();
  if (!text.startsWith("/")) return "";
  if (String(msg?.chat?.id) !== String(bot.env.TELEGRAM_CHAT_ID)) {
    console.log(`Commande refusée depuis le chat ${msg?.chat?.id}`);
    return "";
  }
  const [head, ...args] = text.split(/\s+/);
  const cmd = head.slice(1).split("@")[0].toLowerCase();
  try {
    return await run(bot, cmd, args);
  } catch (e) {
    return `⚠️ Erreur : ${e instanceof Error ? e.message : e}`;
  }
}

async function ask(bot: Bot, description: string, action: string): Promise<string> {
  await bot.env.DB.prepare("INSERT INTO events (time, level, message) VALUES (?, 'pending', ?)")
    .bind(new Date().toISOString(), JSON.stringify({ description, action, expires: Date.now() + CONFIRM_MS })).run();
  return `❓ ${description}\nEnvoyez /confirmer dans les 60 secondes pour valider.`;
}

async function run(bot: Bot, cmd: string, args: string[]): Promise<string> {
  switch (cmd) {
    case "start":
    case "aide":
      return "Commandes disponibles :\n" + COMMANDS.map(([c, d]) => `/${c} : ${d}`).join("\n");

    case "statut": {
      const s = await bot.snapshot();
      const etat = s.halted ? `🛑 ARRÊTÉ (${s.halt_reason})` : s.paused ? "⏸️ en pause" : "✅ actif";
      return [
        `Mode : ${s.mode === "paper" ? "SIMULATION" : "ARGENT RÉEL"} | ${etat}`,
        ...(s.missing_keys ? ["⚠️ Mode réel demandé : ajoutez COINBASE_API_KEY et COINBASE_API_SECRET dans Cloudflare."] : []),
        s.mode === "paper"
          ? `Capital : ${money(s.equity)} (${pct(s.equity / s.initial_cash - 1)} depuis le départ)`
          : `Capital : ${money(s.equity)} | Plafond par ordre : ${money(s.max_order)}`,
        `Liquidités : ${money(s.cash)}`,
        `Aujourd'hui : ${pct(s.day_pnl)} | Recul depuis le plus haut : ${pct(s.drawdown)}`,
        `Positions ouvertes : ${s.positions.length}`,
        `Dernier cycle : ${s.last_step ?? "pas encore"}`,
        ...(s.last_error ? [`⚠️ Dernière erreur : ${s.last_error}`] : []),
      ].join("\n");
    }

    case "positions": {
      const s = await bot.snapshot();
      if (!s.positions.length) return "Aucune position ouverte.";
      return s.positions.map(p =>
        `${p.product} : ${p.qty.toFixed(6)} (${money(p.value)})\n` +
        `Entrée ${money(p.entry_price)} → ${money(p.price)} (${pct(p.pnl_pct)})\n` +
        `Stop ${money(p.stop)} (${pct(p.stop_dist_pct)})`).join("\n\n");
    }

    case "prix": {
      const s = await bot.snapshot();
      return Object.entries(s.prices).map(([p, v]) => `${p} : ${money(v)}`).join("\n") || "Pas encore de prix.";
    }

    case "signaux":
      return (await bot.signalReport()).map(r => {
        const etat = r.entry ? "🟢 signal d'achat sur la dernière bougie"
          : !r.trendUp ? `⚪ pas de tendance haussière (EMA 200 à ${money(r.emaSlow)})`
          : `🟡 tendance haussière, cassure à ${money(r.channelHigh)} (${pct(r.toBreakoutPct)})`;
        return `${r.product} ${money(r.close)}\n${etat}`;
      }).join("\n\n");

    case "journal": {
      const n = Math.min(parseInt(args[0]) || 10, 50);
      const { results } = await bot.env.DB.prepare("SELECT * FROM trades ORDER BY id DESC LIMIT ?").bind(n).all<any>();
      if (!results.length) return "Aucun trade enregistré.";
      return results.map(t => `${t.time.slice(0, 16).replace("T", " ")} ${t.side === "buy" ? "🟢" : "🔴"} ` +
        `${t.product} ${money(t.price)} (${t.reason})${t.pnl_pct != null ? " " + pct(t.pnl_pct) : ""}`).join("\n");
    }

    case "perf": {
      const { results } = await bot.env.DB.prepare("SELECT * FROM trades WHERE side = 'sell'").all<any>();
      if (!results.length) return "Aucun trade clôturé pour l'instant.";
      const wins = results.filter(t => t.pnl_pct > 0);
      const avg = results.reduce((s, t) => s + t.pnl_pct, 0) / results.length;
      const best = results.reduce((a, b) => (b.pnl_pct > a.pnl_pct ? b : a));
      const worst = results.reduce((a, b) => (b.pnl_pct < a.pnl_pct ? b : a));
      return `Trades clôturés : ${results.length}\nGagnants : ${wins.length} (${Math.round(wins.length / results.length * 100)} %)\n` +
        `Variation moyenne : ${pct(avg)}\nMeilleur : ${best.product} ${pct(best.pnl_pct)}\nPire : ${worst.product} ${pct(worst.pnl_pct)}`;
    }

    case "solde": {
      if (bot.mode !== "live") return "Le bot est en simulation : pas de compte Coinbase connecté.";
      const b = await (bot.broker as import("./broker").LiveBroker).balances();
      const lines = Object.entries(b).filter(([, v]) => v > 0).map(([c, v]) => `${c} : ${v.toLocaleString("fr-FR", { maximumFractionDigits: 8 })}`);
      return lines.length ? "Soldes disponibles sur Coinbase :\n" + lines.join("\n") : "Aucun solde disponible sur Coinbase.";
    }

    case "pause": await bot.setPaused(true); return "";
    case "reprendre": await bot.setPaused(false); return "";

    case "vendre": {
      if (!args[0]) return "Précisez la crypto, ex. /vendre BTC";
      const product = args[0].toUpperCase().includes("-") ? args[0].toUpperCase() : `${args[0].toUpperCase()}-${bot.quote}`;
      if (!(await bot.positions()).some(p => p.product === product)) return `Aucune position ouverte sur ${product}.`;
      return ask(bot, `Vendre toute la position ${product} ?`, `sell:${product}`);
    }

    case "vendre_tout": {
      const pos = await bot.positions();
      if (!pos.length) return "Aucune position ouverte.";
      return ask(bot, `Vendre TOUTES les positions (${pos.map(p => p.product).join(", ")}) et mettre le bot en pause ?`, "sell_all");
    }

    case "reset_coupe_circuit": {
      const acc = await bot.account();
      if (!acc.guard.halted) return "Le coupe-circuit n'est pas déclenché.";
      return ask(bot, "Réinitialiser le coupe-circuit et relancer le trading ?", "reset");
    }

    case "confirmer": {
      const row = await bot.env.DB.prepare(
        "DELETE FROM events WHERE id = (SELECT max(id) FROM events WHERE level = 'pending') RETURNING message").first<any>();
      await bot.env.DB.prepare("DELETE FROM events WHERE level = 'pending'").run();
      if (!row) return "Rien à confirmer.";
      const p = JSON.parse(row.message);
      if (Date.now() > p.expires) return "⌛ Délai dépassé, recommencez la commande.";
      if (p.action.startsWith("sell:")) await bot.closePosition(p.action.slice(5));
      else if (p.action === "sell_all") {
        await bot.setPaused(true);
        for (const pos of await bot.positions()) await bot.closePosition(pos.product);
      } else if (p.action === "reset") await bot.resetHalt();
      return `✅ Fait : ${p.description}`;
    }

    case "dashboard":
      return bot.env.PUBLIC_URL ? `📊 ${bot.env.PUBLIC_URL}` : "Adresse du tableau de bord inconnue.";

    default:
      return "Commande inconnue. /aide pour la liste.";
  }
}
