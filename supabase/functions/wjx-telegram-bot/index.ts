import { createClient } from "npm:@supabase/supabase-js@2.119.2";
import { equalPassword } from "../_shared/admin-session.ts";
import { failure, json, readBody, RequestError } from "../_shared/http.ts";
import {
  MANAGER_URL,
  MINI_APP_URL,
  telegramWebhookSecret,
} from "../_shared/telegram-bot.ts";
const botDb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  {
    auth: { persistSession: false, autoRefreshToken: false },
  },
);
const openGame = { text: "🎰 Открыть рулетку", web_app: { url: MINI_APP_URL } };
const support = { text: "💬 Написать менеджеру", url: MANAGER_URL };
const menuText =
  "Команды WJX Рулетка:\n/start — открыть рулетку\n/play — играть в Mini App\n/prizes — мои реальные призы\n/rules — даты и правила\n/help — помощь";
function botReply(
  chat: number,
  text: string,
  buttons: Record<string, unknown>[] = [openGame, support],
) {
  // Telegram executes this Bot API method from the webhook response.
  return json({
    method: "sendMessage",
    chat_id: chat,
    text,
    reply_markup: { inline_keyboard: buttons.map((button) => [button]) },
  });
}
const displayDate = (date: string) => date.split("-").reverse().join(".");
export async function handleTelegramBot(req: Request): Promise<Response> {
  try {
    if (req.method !== "POST") return json({ ok: false }, 405);
    const expected = await telegramWebhookSecret(
      Deno.env.get("WJX_ADMIN_SESSION_SECRET") ?? "",
      Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "",
    );
    const received = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    if (
      received.length !== expected.length ||
      !(await equalPassword(received, expected))
    ) return json({ ok: false }, 401);
    let update;
    try {
      update = await readBody(req);
    } catch (error) {
      // Large/non-JSON updates are not commands. Do not create an endless retry loop.
      if (error instanceof RequestError) return json({ ok: true });
      throw error;
    }
    const message = update.message;
    const user = message?.from;
    if (
      !Number.isSafeInteger(update.update_id) || update.update_id < 0 ||
      message?.chat?.type !== "private" || user?.is_bot ||
      !Number.isSafeInteger(user?.id) || user.id <= 0 ||
      message.chat.id !== user.id ||
      typeof message.text !== "string"
    ) return json({ ok: true });
    // Only command text, never arguments, usernames or forwarded IDs, selects data.
    const command = /^\/([a-z]+)(?:@[a-z0-9_]+)?(?:\s|$)/i.exec(message.text)
      ?.[1].toLowerCase();
    if (!command) return json({ ok: true });
    if (command === "start") {
      return botReply(
        user.id,
        "🎰 Добро пожаловать в WJX Рулетка!\nОткройте рулетку кнопкой ниже. Попытки и выигрыши сохраняются на сервере.\n\n" +
          menuText,
      );
    }
    if (command === "play") {
      return botReply(
        user.id,
        "🎰 Нажмите «Открыть рулетку» и потяните рычаг в Mini App.\nКоманда сама не расходует попытки.",
        [openGame],
      );
    }
    if (command === "help") {
      return botReply(
        user.id,
        menuText +
          "\n\nЕсли нужна помощь с игрой или выдачей призов, напишите менеджеру.",
      );
    }
    if (command === "rules") {
      const { data: settings, error } = await botDb.from("roulette_settings")
        .select("event_start,event_end,start_time,end_time,daily_spins").eq(
          "id",
          1,
        ).single();
      if (error || !settings) throw new Error("Rules unavailable");
      return botReply(
        user.id,
        `📜 Правила WJX Рулетка\n\nНачало: ${
          displayDate(settings.event_start)
        } в ${settings.start_time.slice(0, 5)} МСК.\nОкончание: ${
          displayDate(settings.event_end)
        } в ${
          settings.end_time.slice(0, 5)
        } МСК.\nЭто единый период; в промежуточные дни игра доступна и ночью.\n\nДля участия подпишитесь на официальный канал: https://t.me/tattoowjxrussia.\n\nПопыток в день: ${settings.daily_spins}. Новый день начинается в 00:00 МСК. Неиспользованные попытки не переносятся.\nРезультат случайный; возможен исход без выигрыша.\nПосле окончания розыгрыша победители обращаются к менеджеру. Выигрыши проверяются по базе, а не по скриншоту.`,
      );
    }
    if (command === "prizes") {
      const { data: summary, error } = await botDb.rpc(
        "wjx_user_prize_summary",
        { p_telegram_id: user.id },
      );
      if (error) throw new Error("Prizes unavailable");
      if (!summary) {
        return botReply(
          user.id,
          "🎁 Вы ещё не участвовали в рулетке. Откройте Mini App — здесь появятся ваши реальные призы.",
        );
      }
      const items = (summary.prizes ?? []).filter((p: { prize: string }) =>
        typeof p.prize === "string" && p.prize.trim() &&
        p.prize.trim() !== "Без выигрыша"
      );
      const period = `${displayDate(summary.period.event_start)} — ${
        displayDate(summary.period.event_end)
      }`;
      if (!items.length) {
        return botReply(
          user.id,
          `🎁 Мои призы\nПериод: ${period}.\n\nРеальных выигрышей за этот период пока нет.`,
        );
      }
      const lines = items.map((p: { prize: string; quantity: number }) =>
        `• ${p.prize} × ${p.quantity}`
      );
      return botReply(
        user.id,
        `🎁 Ваши реальные призы\nПериод: ${period}.\n\n${
          lines.join("\n")
        }\n\nВсего: ${summary.total_wins}.\nВыдано: ${
          summary.delivered_count ?? 0
        }. Осталось выдать: ${
          summary.remaining_count ?? summary.total_wins
        }.\n\nПосле окончания розыгрыша свяжитесь с менеджером. Исходы «Без выигрыша» в список не включены.`,
      );
    }
    return botReply(user.id, "Неизвестная команда.\n\n" + menuText);
  } catch (error) {
    return failure(error);
  }
}
Deno.serve(handleTelegramBot);
