export class TelegramServiceError extends Error {}
export const MINI_APP_URL =
  "https://flyingmish-lab.github.io/wjx-1111-roulette/";
export const MANAGER_URL = "https://t.me/Wjx_wjxx";
export const BOT_COMMANDS = [
  { command: "start", description: "🎰 WJX Рулетка — играть" },
  { command: "play", description: "🎰 Крутить рулетку" },
  { command: "prizes", description: "🎁 Мои выигрыши и подарки" },
  { command: "rules", description: "📜 Правила WJX Рулетка" },
  { command: "help", description: "💬 Помощь и поддержка WJX" },
];

// Domain-separated credential: never expose either existing secret to clients.
export async function telegramWebhookSecret(secret: string, botToken: string) {
  if (secret.length < 32 || !botToken) {
    throw new Error("Bot configuration missing");
  }
  const bytes = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    bytes.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    bytes.encode(`wjx-telegram-webhook-v1:${botToken}`),
  );
  return [...new Uint8Array(signature)].map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}
export async function telegramRequest(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
) {
  if (!token) {
    throw new TelegramServiceError(
      "В Supabase не настроен TELEGRAM_BOT_TOKEN.",
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    const data = await response.json();
    if (!response.ok || !data.ok) {
      const code = Number(data.error_code) || response.status;
      throw new TelegramServiceError(
        code === 401 || code === 404
          ? "Telegram отклонил токен бота. Проверьте TELEGRAM_BOT_TOKEN в Supabase."
          : `Telegram временно недоступен (код ${code}). Повторите позже.`,
      );
    }
    return data.result;
  } catch (error) {
    if (error instanceof TelegramServiceError) throw error;
    throw new TelegramServiceError(
      "Не удалось получить ответ от Telegram. Повторите позже.",
    );
  } finally {
    clearTimeout(timer);
  }
}
export function telegramWebhookUrl(supabaseUrl: string) {
  const url = new URL(supabaseUrl);
  if (url.protocol !== "https:") {
    throw new TelegramServiceError(
      "Для Telegram нужен публичный HTTPS-адрес Supabase.",
    );
  }
  return `${url.origin}/functions/v1/wjx-telegram-bot`;
}
export async function botConnectionStatus(token: string, supabaseUrl: string) {
  const info = await telegramRequest(token, "getWebhookInfo");
  const expected = telegramWebhookUrl(supabaseUrl);
  // An existing URL might contain credentials: never return it to the browser.
  return {
    connected: info.url === expected,
    otherWebhook: !!info.url && info.url !== expected,
    pendingUpdates: Number(info.pending_update_count) || 0,
    deliveryError: !!info.last_error_date,
  };
}
export async function configureTelegramBot(
  token: string,
  secret: string,
  supabaseUrl: string,
) {
  const status = await botConnectionStatus(token, supabaseUrl);
  if (status.otherWebhook) return { conflict: true };
  const secretToken = await telegramWebhookSecret(secret, token);
  const identity = await telegramRequest(token, "getMe");
  // Update the public display name without changing the username or links.
  for (const language_code of ["", "ru"]) {
    await telegramRequest(token, "setMyName", {
      name: "WJX Рулетка",
      language_code,
    });
  }
  // Default and private-chat scopes cover both existing and new users.
  for (const scope of [{ type: "default" }, { type: "all_private_chats" }]) {
    for (const language_code of ["", "ru"]) {
      await telegramRequest(token, "setMyCommands", {
        commands: BOT_COMMANDS,
        scope,
        language_code,
      });
    }
  }
  await telegramRequest(token, "setChatMenuButton", {
    menu_button: { type: "commands" },
  });
  await telegramRequest(token, "setWebhook", {
    url: telegramWebhookUrl(supabaseUrl),
    secret_token: secretToken,
    allowed_updates: ["message"],
    drop_pending_updates: false,
  });
  return { conflict: false, username: identity.username, connected: true };
}
