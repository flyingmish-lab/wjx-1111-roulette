import { createClient } from "npm:@supabase/supabase-js@2.119.2";
import {
  corsHeaders,
  failure,
  json,
  preflight,
  readBody,
} from "../_shared/http.ts";
import { requireAdmin } from "../_shared/admin-session.ts";
import {
  botConnectionStatus,
  configureTelegramBot,
  isChannelSubscriber,
  REQUIRED_CHANNEL_URL,
  subscriptionSetupStatus,
  TelegramServiceError,
} from "../_shared/telegram-bot.ts";
const telegramBotToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Supabase configuration is missing");
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const encoder = new TextEncoder();

const settingsTable = "roulette_settings";

async function loadPrizeChances() {
  const { data, error } = await supabase
    .from("roulette_prize_chances")
    .select("prize, chance");

  if (error || !data || data.length === 0) {
    throw new Error("Не удалось загрузить вероятности призов");
  }

  if (
    data.length !== 6 ||
    data.some((item) =>
      !Number.isFinite(Number(item.chance)) || Number(item.chance) < 0 ||
      Number(item.chance) > 100
    ) ||
    Math.abs(data.reduce((sum, item) => sum + Number(item.chance), 0) - 100) >
      0.001
  ) {
    throw new Error("Invalid prize configuration");
  }
  return data.map((item) => ({
    prize: item.prize === "Без выигрыша" ? null : item.prize,
    chance: Number(item.chance),
  }));
}

function choosePrize(
  prizeChances: { prize: string | null; chance: number }[],
): string | null {
  const random = crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296 *
    100;

  let cumulativeChance = 0;

  for (const item of prizeChances) {
    cumulativeChance += item.chance;

    if (random < cumulativeChance) {
      return item.prize;
    }
  }

  return null;
}

async function createHmacKey(
  secret: Uint8Array,
  algorithm: string,
) {
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(secret),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
}
async function verifyTelegramData(
  initData: string,
  botToken: string,
): Promise<boolean> {
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");

  if (!receivedHash) return false;

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = await crypto.subtle.sign(
    "HMAC",
    await createHmacKey(encoder.encode("WebAppData"), "SHA-256"),
    encoder.encode(botToken),
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    await createHmacKey(new Uint8Array(secretKey), "SHA-256"),
    encoder.encode(dataCheckString),
  );

  const expectedHash = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  if (expectedHash.length !== receivedHash.length) return false;

  let difference = 0;

  for (let i = 0; i < expectedHash.length; i++) {
    difference |= expectedHash.charCodeAt(i) ^
      receivedHash.toLowerCase().charCodeAt(i);
  }

  return difference === 0;
}

async function roulette(req: Request): Promise<Response> {
  const early = preflight(req);
  if (early) return early;
  const requestData = await readBody(req);
  const action = requestData.action || "register";
  const adminActions = [
    "admin_bot_status",
    "admin_set_pause",
    "admin_subscription_status",
    "admin_configure_bot",
    "admin_mark_prizes_delivered",
    "admin_get_winners",
    "admin_get_user_wins",
    "admin_test_users",
    "admin_set_test_spins",
    "admin_get_settings",
    "admin_save_settings",
    "admin_get_prizes",
    "admin_save_prize_chances",
  ];
  const isAdminAction = adminActions.includes(action);
  if (
    ![
      "register",
      "spin",
      "test_spin",
      "status",
      "check_subscription",
      ...adminActions,
    ].includes(
      action,
    )
  ) {
    return json({ success: false, error: "Unknown action" }, 400);
  }
  let adminSessionHash: string | null = null;
  if (isAdminAction) {
    const session = await requireAdmin(
      req,
      supabase,
      Deno.env.get("WJX_ADMIN_PASSWORD") ?? "",
      Deno.env.get("WJX_ADMIN_SESSION_SECRET") ?? "",
    );
    adminSessionHash = session;
    if (!session) {
      return json(
        { success: false, error: "Сессия истекла. Войдите снова." },
        401,
      );
    }
  }
  if (action === "admin_subscription_status") {
    return json({
      success: true,
      ...await subscriptionSetupStatus(telegramBotToken ?? ""),
    });
  }
  if (action === "admin_bot_status") {
    return json({
      success: true,
      ...await botConnectionStatus(telegramBotToken ?? "", supabaseUrl!),
    });
  }
  if (action === "admin_configure_bot") {
    const result = await configureTelegramBot(
      telegramBotToken ?? "",
      Deno.env.get("WJX_ADMIN_SESSION_SECRET") ?? "",
      supabaseUrl!,
    );
    if (result.conflict) {
      return json({
        success: false,
        error:
          "У бота уже подключён другой обработчик. Автоматическая замена остановлена, чтобы сохранить его функции.",
      }, 409);
    }
    return json({ success: true, ...result });
  }
  let telegramUserId: number = 0;
  if (!isAdminAction) {
    const telegramInitData = requestData.initData;
    if (
      typeof telegramInitData !== "string" || telegramInitData.length > 12000
    ) {
      return json({ success: false, error: "Telegram data required" }, 401);
    }

    if (!telegramInitData) {
      return Response.json(
        { success: false, error: "Telegram data required" },
        {
          status: 401,
          headers: corsHeaders,
        },
      );
    }

    if (
      !telegramBotToken ||
      !(await verifyTelegramData(telegramInitData, telegramBotToken))
    ) {
      return Response.json(
        { success: false, error: "Invalid Telegram signature" },
        {
          status: 401,
          headers: corsHeaders,
        },
      );
    }
    const authDate = Number(
      new URLSearchParams(telegramInitData).get("auth_date"),
    );

    const currentTime = Math.floor(Date.now() / 1000);
    const maxAge = 24 * 60 * 60;

    if (
      !Number.isSafeInteger(authDate) ||
      authDate <= 0 ||
      authDate > currentTime ||
      currentTime - authDate > maxAge
    ) {
      return Response.json(
        { success: false, error: "Telegram session expired" },
        {
          status: 401,
          headers: corsHeaders,
        },
      );
    }

    const telegramParams = new URLSearchParams(telegramInitData);
    const userJson = telegramParams.get("user");

    if (!userJson) {
      return Response.json(
        { success: false, error: "Telegram user not found" },
        {
          status: 401,
          headers: corsHeaders,
        },
      );
    }

    let telegramUser;

    try {
      telegramUser = JSON.parse(userJson);
    } catch {
      return Response.json(
        { success: false, error: "Invalid Telegram user data" },
        {
          status: 401,
          headers: corsHeaders,
        },
      );
    }

    telegramUserId = telegramUser?.id;

    if (
      !Number.isSafeInteger(telegramUserId) ||
      telegramUserId <= 0
    ) {
      return Response.json(
        { success: false, error: "Invalid Telegram user ID" },
        {
          status: 401,
          headers: corsHeaders,
        },
      );
    }

    const { error: participantError } = await supabase.rpc(
      "wjx_register_player",
      {
        p_telegram_id: telegramUserId,
        p_first_name: telegramUser.first_name || null,
        p_username: telegramUser.username || null,
      },
    );

    if (participantError) {
      console.error("Participant save failed:", participantError.code);

      return Response.json(
        { success: false, error: "Could not save participant" },
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }
  if (action === "check_subscription") {
    const subscribed = await isChannelSubscriber(
      telegramBotToken ?? "",
      telegramUserId,
    );
    return json({
      success: true,
      subscribed,
      channelUrl: REQUIRED_CHANNEL_URL,
    });
  }
  const operationId = requestData.operationId;
  const validOperationId = (value: unknown): value is string =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
  async function playerState() {
    const { data, error } = await supabase.rpc("wjx_player_state", {
      p_telegram_id: telegramUserId,
      p_request_id: operationId ?? null,
    });
    if (error || !data || !data.eventSummary) {
      throw new Error("Player state unavailable");
    }
    return {
      ...data,
      eventWinCount: Number(data.eventSummary.total_wins ?? 0),
    };
  }
  if (action === "status" || action === "spin" || action === "test_spin") {
    if (
      (operationId !== undefined || action !== "status") &&
      !validOperationId(operationId)
    ) {
      return json({
        success: false,
        error: "Обновите Mini App и повторите загрузку.",
      }, 400);
    }
    if (action === "status") {
      return json({ success: true, ...await playerState() });
    }
    const isTest = action === "test_spin";
    // Return already committed results even after the event ends or chances change.
    const { data: previous, error: lookupError } = await supabase.from(
      "wjx_spin_operations",
    )
      .select("is_test,result").eq("telegram_id", telegramUserId).eq(
        "request_id",
        operationId,
      ).maybeSingle();
    if (lookupError) throw new Error("Operation lookup failed");
    if (previous && previous.is_test !== isTest) {
      return json(
        { success: false, error: "Режим операции не совпадает" },
        409,
      );
    }
    let result = previous?.result;
    if (!previous) {
      if (
        !(await isChannelSubscriber(telegramBotToken ?? "", telegramUserId))
      ) {
        return json({
          success: false,
          code: "SUBSCRIPTION_REQUIRED",
          error: "Чтобы крутить рулетку, подпишитесь на наш канал.",
          channelUrl: REQUIRED_CHANNEL_URL,
        }, 403);
      }
      const selectedPrize = choosePrize(await loadPrizeChances());
      const { data, error } = await supabase.rpc("wjx_perform_spin", {
        p_telegram_id: telegramUserId,
        p_request_id: operationId,
        p_is_test: isTest,
        p_prize: selectedPrize ?? "Без выигрыша",
      });
      if (error) {
        if (["P0001", "P0002", "P0003", "22023"].includes(error.code)) {
          return json(
            {
              success: false,
              code: error.code === "P0003" ? "SPINS_PAUSED" : undefined,
              error: error.code === "P0003"
                ? "Рулетка временно приостановлена. Попробуйте позже."
                : error.code === "P0001"
                ? (isTest
                  ? "Доступные прокрутки закончились"
                  : "На сегодня лимит попыток исчерпан")
                : error.code === "P0002"
                ? "Розыгрыш сейчас недоступен"
                : "Некорректная операция",
            },
            error.code === "P0001"
              ? 429
              : ["P0002", "P0003"].includes(error.code)
              ? 403
              : 400,
          );
        }
        throw new Error("Spin unavailable");
      }
      result = data;
    }
    if (!result) throw new Error("Spin result missing");
    return json({
      success: true,
      ...result,
      replayed: !!previous,
      state: await playerState(),
    });
  }

  const { data: rouletteSettings, error: settingsError } = await supabase
    .from(settingsTable)
    .select("event_start, event_end, start_time, end_time, daily_spins")
    .eq("id", 1)
    .single();

  if (settingsError || !rouletteSettings) {
    console.error("Settings load failed:", settingsError?.code);
    return Response.json(
      {
        success: false,
        error: "Could not load roulette settings",
      },
      {
        status: 500,
        headers: corsHeaders,
      },
    );
  }

  if (action === "admin_mark_prizes_delivered") {
    const id = Number(requestData.telegram_id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return json({ success: false, error: "Некорректный Telegram ID" }, 400);
    }
    const { data, error } = await supabase.rpc("wjx_mark_prizes_delivered", {
      p_telegram_id: id,
      p_session_hash: adminSessionHash,
    });
    if (error?.code === "P0002") {
      return json({
        success: false,
        error:
          "Выдача доступна зарегистрированному участнику после окончания розыгрыша.",
      }, 409);
    }
    if (error || !data) throw new Error("Delivery unavailable");
    return json({ success: true, ...data });
  }
  if (action === "admin_get_winners") {
    const search = requestData.search ?? "";
    const offset = requestData.offset ?? 0;
    if (
      typeof search !== "string" || search.length > 100 ||
      !Number.isInteger(offset) || offset < 0 || offset > 1000000
    ) {
      return json({ success: false, error: "Некорректный поиск" }, 400);
    }
    const { data, error } = await supabase.rpc("wjx_event_winners", {
      p_search: search.trim(),
      p_offset: offset,
    });
    if (error || !data) throw new Error("Winners unavailable");
    return json({ success: true, ...data });
  }
  if (action === "admin_get_user_wins") {
    const id = Number(requestData.telegram_id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return json({ success: false, error: "Некорректный Telegram ID" }, 400);
    }
    const { data, error } = await supabase.rpc("wjx_user_prize_summary", {
      p_telegram_id: id,
    });
    if (error) throw new Error("Winner summary unavailable");
    if (!data) {
      return json({ success: false, error: "Участник не найден" }, 404);
    }
    return json({ success: true, ...data });
  }

  if (action === "admin_test_users") {
    const search = requestData.search ?? "";
    const offset = requestData.offset ?? 0;
    if (
      typeof search !== "string" || search.length > 100 ||
      !Number.isInteger(offset) || offset < 0 || offset > 1000000
    ) {
      return json({ success: false, error: "Некорректный поиск" }, 400);
    }
    const { data, error } = await supabase.rpc("wjx_admin_test_users", {
      p_search: search,
      p_offset: offset,
    });
    if (error || !data) throw new Error("User list unavailable");
    return json({ success: true, ...data });
  }
  if (action === "admin_set_test_spins") {
    const id = Number(requestData.telegram_id);
    const attempts = requestData.attempts;
    if (
      !Number.isSafeInteger(id) || id <= 0 || !Number.isInteger(attempts) ||
      attempts < 0 || attempts > 100
    ) {
      return json({
        success: false,
        error: "Выберите пользователя и остаток от 0 до 100",
      }, 400);
    }
    const { data, error } = await supabase.rpc("wjx_set_test_spins", {
      p_telegram_id: id,
      p_attempts: attempts,
    });
    if (error?.code === "P0002") {
      return json({ success: false, error: "Пользователь не найден" }, 404);
    }
    if (error) throw new Error("Test allocation failed");
    return json({ success: true, testRemaining: data });
  }
  if (action === "admin_save_prize_chances") {
    const prizes = requestData.prizes;

    if (
      !Array.isArray(prizes) ||
      prizes.length !== 6 ||
      (prizes.some((item) => item?.prize_limit !== undefined) &&
        prizes.some((item) => item?.prize_limit === undefined)) ||
      prizes.some(
        (item) =>
          typeof item?.prize !== "string" ||
          typeof item?.chance !== "number" ||
          !Number.isFinite(item.chance) ||
          item.chance < 0 ||
          item.chance > 100 ||
          (item.prize_limit !== undefined && item.prize_limit !== null &&
            (!Number.isInteger(item.prize_limit) || item.prize_limit < 0 || item.prize_limit > 1000000)) ||
          (item.prize === "Без выигрыша" && item.prize_limit != null),
      ) ||
      Math.abs(
          prizes.reduce((sum, item) => sum + item.chance, 0) - 100,
        ) > 0.001
    ) {
      return Response.json(
        { success: false, error: "Некорректные вероятности призов" },
        { status: 400, headers: corsHeaders },
      );
    }
    const allowedPrizes = [
      "Картридж",
      "Расходники",
      "Noir Blade",
      "Soul Ink",
      "Бандажка",
      "Без выигрыша",
    ];

    const receivedPrizes = prizes.map((item) => item.prize);

    if (
      new Set(receivedPrizes).size !== allowedPrizes.length ||
      !allowedPrizes.every((prize) => receivedPrizes.includes(prize))
    ) {
      return Response.json(
        { success: false, error: "Недопустимый список призов" },
        { status: 400, headers: corsHeaders },
      );
    }
    const { error: saveError } = await supabase
      .from("roulette_prize_chances")
      .upsert(prizes.map(({ prize, chance, prize_limit }) => ({
        prize, chance,
        // Older clients may save chances without changing the configured cap.
        ...(prize_limit === undefined ? {} : { prize_limit }),
      })), {
        onConflict: "prize",
      });

    if (saveError) {
      console.error("Prize chances save failed:", saveError.code);

      return Response.json(
        { success: false, error: "Не удалось сохранить вероятности" },
        { status: 500, headers: corsHeaders },
      );
    }

    return Response.json(
      { success: true, message: "Вероятности сохранены" },
      { headers: corsHeaders },
    );
  }
  if (action === "admin_get_prizes") {
    const { data, error } = await supabase.rpc("wjx_admin_prize_stats");
    if (error || !data) throw new Error("Statistics unavailable");
    return json({ success: true, ...data });
  }

  if (action === "admin_set_pause") {
    if (typeof requestData.paused !== "boolean") {
      return json(
        { success: false, error: "Некорректное состояние паузы" },
        400,
      );
    }
    const { error } = await supabase.from(settingsTable).update({
      spins_paused: requestData.paused,
    }).eq("id", 1);
    if (error) throw new Error("Pause update failed");
    return json({ success: true, paused: requestData.paused });
  }

  if (action === "admin_get_settings") {
    return Response.json(
      { success: true, settings: rouletteSettings },
      { headers: corsHeaders },
    );
  }

  if (action === "admin_save_settings") {
    const settings = requestData.settings;

    const validTime = (value: unknown): value is string =>
      typeof value === "string" &&
      /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    const validDate = (value: unknown): value is string => {
      if (typeof value !== "string") return false;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

      const date = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(date.getTime()) &&
        date.toISOString().slice(0, 10) === value;
    };

    if (
      !settings ||
      !validDate(settings.event_start) ||
      !validDate(settings.event_end) ||
      !validTime(settings.start_time) ||
      !validTime(settings.end_time) ||
      (settings.event_start === settings.event_end &&
        settings.end_time.slice(0, 5) <= settings.start_time.slice(0, 5)) ||
      settings.event_end < settings.event_start ||
      !Number.isInteger(settings.daily_spins) ||
      settings.daily_spins < 1 ||
      settings.daily_spins > 20
    ) {
      return Response.json(
        { success: false, error: "Некорректные настройки" },
        { status: 400, headers: corsHeaders },
      );
    }

    const { data, error } = await supabase
      .from(settingsTable)
      .update({
        event_start: settings.event_start,
        event_end: settings.event_end,
        start_time: settings.start_time,
        end_time: settings.end_time,
        daily_spins: settings.daily_spins,
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1)
      .select("event_start, event_end, start_time, end_time, daily_spins")
      .single();

    if (error || !data) {
      console.error("Settings save failed:", error?.code);

      return Response.json(
        { success: false, error: "Не удалось сохранить настройки" },
        { status: 500, headers: corsHeaders },
      );
    }

    return Response.json(
      { success: true, settings: data },
      { headers: corsHeaders },
    );
  }

  return Response.json(
    {
      success: true,
      message: "Telegram participant verified and saved",
    },
    {
      headers: corsHeaders,
    },
  );
}

export async function handleRoulette(req: Request): Promise<Response> {
  try {
    return await roulette(req);
  } catch (error) {
    if (error instanceof TelegramServiceError) {
      return json({ success: false, error: error.message }, 503);
    }
    return failure(error);
  }
}
Deno.serve(handleRoulette);
