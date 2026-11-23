// Point d'entrée du Worker Cloudflare.
//  - scheduled : déclencheur chaque minute -> cycle du bot (stops, signaux journaliers)
//  - POST /telegram : webhook Telegram (vérifié par jeton secret)
//  - GET / et /api/* : tableau de bord en lecture seule, protégé par mot de passe
import { Bot, Env } from "./bot";
import { ensureWebhook, handleUpdate, sendTelegram } from "./telegram";
import DASHBOARD_HTML from "./dashboard.html";
import RESEARCH from "./research.json";

const makeBot = (env: Env) => new Bot(env, msg => sendTelegram(env, msg));

const SECURITY_HEADERS = {
  "Cache-Control": "no-store", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function json(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json", ...SECURITY_HEADERS } });
}

function equalSecret(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  return ea.byteLength === eb.byteLength && crypto.subtle.timingSafeEqual(ea, eb);
}

function authorized(req: Request, env: Env): boolean {
  const pw = env.DASHBOARD_PASSWORD ?? "";
  if (pw.length < 8) return false;
  const h = req.headers.get("Authorization") ?? "";
  if (!h.startsWith("Basic ")) return false;
  try {
    const given = atob(h.slice(6)).split(":").slice(1).join(":");
    return equalSecret(given, pw);
  } catch { return false; }
}

async function route(url: URL, env: Env, bot: Bot): Promise<Response> {
    switch (url.pathname) {
    case "/":
      return new Response(DASHBOARD_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS } });
    case "/api/status":
      return json(await bot.snapshot());
    case "/api/equity":
      return json((await env.DB.prepare("SELECT * FROM (SELECT * FROM equity ORDER BY time DESC LIMIT 5000) ORDER BY time").all()).results);
    case "/api/trades":
      return json((await env.DB.prepare("SELECT * FROM trades ORDER BY id DESC LIMIT 100").all()).results);
    case "/api/market":
      return json(await bot.market());
    case "/api/chart":
      return json(await bot.chart(url.searchParams.get("product") ?? ""));
    case "/api/risk":
      return json(await bot.riskReport());
    case "/api/research":
      return json(RESEARCH);
    case "/api/events":
      return json((await env.DB.prepare("SELECT * FROM events WHERE level != 'pending' ORDER BY id DESC LIMIT 30").all()).results);
  }
  return new Response("introuvable", { status: 404 });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const bot = makeBot(env);

    if (url.pathname === "/healthz") return new Response("ok");
    await bot.account(); // crée les tables au premier appel

    if (url.pathname === "/telegram" && req.method === "POST") {
      const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
      if (!env.TELEGRAM_WEBHOOK_SECRET || !equalSecret(secret, env.TELEGRAM_WEBHOOK_SECRET)) {
        return new Response("interdit", { status: 403 });
      }
      const update = await req.json();
      // On répond tout de suite à Telegram et on traite la commande en arrière-plan.
      ctx.waitUntil((async () => {
        const reply = await handleUpdate(bot, update);
        if (reply) await sendTelegram(env, reply);
      })());
      return new Response("ok");
    }

    if (!(env.DASHBOARD_PASSWORD && env.DASHBOARD_PASSWORD.length >= 8)) {
      return new Response("Tableau de bord désactivé : ajoutez le secret DASHBOARD_PASSWORD (8 caractères min).",
        { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    if (!authorized(req, env)) {
      return new Response("Authentification requise", {
        status: 401, headers: { "WWW-Authenticate": 'Basic realm="Trading bot", charset="UTF-8"' },
      });
    }

    try {
      return await route(url, env, bot);
    } catch (e) {
      return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
        { status: 500, headers: { "Content-Type": "application/json", ...SECURITY_HEADERS } });
    }
  },

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const bot = makeBot(env);
    try {
      await bot.account(); // crée les tables au premier lancement
      await ensureWebhook(bot);
      await bot.step();
    } catch (e) {
      console.error(e);
      await bot.recordError(e);
    }
  },
};
