import { createClient } from "npm:@supabase/supabase-js@2.119.2";
import {
  corsHeaders,
  failure,
  json,
  preflight,
  readBody,
} from "../_shared/http.ts";
import { requireAdmin } from "../_shared/admin-session.ts";
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
    "admin_test_users",
    "admin_set_test_spins",
    "admin_get_settings",
    "admin_save_settings",
    "admin_get_prizes",
    "admin_save_prize_chances",
  ];
  const isAdminAction = adminActions.includes(action);
  if (
    !["register", "spin", "test_spin", "status", ...adminActions].includes(
      action,
    )
  ) {
    return json({ success: false, error: "Unknown action" }, 400);
  }
  if (isAdminAction) {
    const session = await requireAdmin(
      req,
      supabase,
      Deno.env.get("WJX_ADMIN_PASSWORD") ?? "",
      Deno.env.get("WJX_ADMIN_SESSION_SECRET") ?? "",
    );
    if (!session) {
      return json(
        { success: false, error: "Сессия истекла. Войдите снова." },
        401,
      );
    }
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

    const { error: participantError } = await supabase
      .from("wjx_participants")
      .upsert(
        {
          telegram_id: telegramUserId,
          first_name: telegramUser.first_name || null,
          username: telegramUser.username || null,
        },
        { onConflict: "telegram_id" },
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
  const moscowParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const getMoscowPart = (type: string) =>
    moscowParts.find((part) => part.type === type)?.value;

  const todayMoscow = `${getMoscowPart("year")}-${getMoscowPart("month")}-${
    getMoscowPart("day")
  }`;
  const timeMoscow = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date());

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
  if (action === "test_spin") {
    const selectedPrize = choosePrize(await loadPrizeChances());
    const { data, error } = await supabase.rpc("wjx_use_test_spin", {
      p_telegram_id: telegramUserId,
      p_prize: selectedPrize ?? "Без выигрыша",
    });
    if (error?.code === "P0001") {
      return json(
        { success: false, error: "Тестовые попытки закончились" },
        429,
      );
    }
    if (error) throw new Error("Test spin failed");
    return json({
      success: true,
      isTest: true,
      prize: selectedPrize,
      testRemaining: data,
    });
  }

  if (action === "admin_save_prize_chances") {
    const prizes = requestData.prizes;

    if (
      !Array.isArray(prizes) ||
      prizes.length !== 6 ||
      prizes.some(
        (item) =>
          typeof item?.prize !== "string" ||
          typeof item?.chance !== "number" ||
          !Number.isFinite(item.chance) ||
          item.chance < 0 ||
          item.chance > 100,
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
      .upsert(prizes.map(({ prize, chance }) => ({ prize, chance })), {
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

  if (
    action === "spin" &&
    (
      `${todayMoscow}T${timeMoscow}` <
        `${rouletteSettings.event_start}T${
          rouletteSettings.start_time.slice(0, 5)
        }` ||
      `${todayMoscow}T${timeMoscow}` >
        `${rouletteSettings.event_end}T${rouletteSettings.end_time.slice(0, 5)}`
    )
  ) {
    return Response.json(
      {
        success: false,
        error:
          `Розыгрыш доступен с ${rouletteSettings.event_start} по ${rouletteSettings.event_end}`,
      },
      {
        status: 403,
        headers: corsHeaders,
      },
    );
  }

  if (action === "status") {
    const { count, error } = await supabase
      .from("wjx_spins")
      .select("id", { count: "exact", head: true })
      .eq("telegram_id", telegramUserId)
      .eq("spin_date", todayMoscow);

    if (error) {
      return Response.json(
        { success: false, error: "Could not load spins" },
        { status: 500, headers: corsHeaders },
      );
    }

    const spinsUsed = count ?? 0;
    const { data: balance, error: balanceError } = await supabase.from(
      "wjx_test_balances",
    )
      .select("remaining").eq("telegram_id", telegramUserId).maybeSingle();
    if (balanceError) throw new Error("Test balance unavailable");

    return Response.json(
      {
        success: true,
        testRemaining: balance?.remaining ?? 0,
        spinsUsed: spinsUsed,
        spinsRemaining: Math.max(0, rouletteSettings.daily_spins - spinsUsed),
        settings: {
          event_start: rouletteSettings.event_start,
          event_end: rouletteSettings.event_end,
          start_time: rouletteSettings.start_time,
          end_time: rouletteSettings.end_time,
          daily_spins: rouletteSettings.daily_spins,
        },
      },
      { headers: corsHeaders },
    );
  }
  if (action === "spin") {
    const { count, error: countError } = await supabase
      .from("wjx_spins")
      .select("id", { count: "exact", head: true })
      .eq("telegram_id", telegramUserId)
      .eq("spin_date", todayMoscow);

    if (countError) {
      console.error("Spin count failed:", countError.code);

      return Response.json(
        { success: false, error: "Could not check spins" },
        { status: 500, headers: corsHeaders },
      );
    }

    const spinsUsed = count ?? 0;

    if (spinsUsed >= rouletteSettings.daily_spins) {
      return Response.json(
        {
          success: false,
          error: "Daily spin limit reached",
          spinsUsed: spinsUsed,
          spinsRemaining: 0,
        },
        {
          status: 429,
          headers: corsHeaders,
        },
      );
    }

    const prizeChances = await loadPrizeChances();
    const selectedPrize = choosePrize(prizeChances);

    const { data: spinData, error: spinError } = await supabase
      .rpc("wjx_save_spin", {
        p_telegram_id: telegramUserId,
        p_spin_date: todayMoscow,
        p_prize: selectedPrize ?? "Без выигрыша",
      });

    if (spinError) {
      console.error("Spin save failed:", spinError.code);

      return Response.json(
        {
          success: false,
          error: spinError.code === "P0001"
            ? "Daily spin limit reached"
            : spinError.code === "P0002"
            ? "Розыгрыш сейчас недоступен"
            : "Could not save spin",
        },
        {
          status: spinError.code === "P0001"
            ? 429
            : spinError.code === "P0002"
            ? 403
            : 500,
          headers: corsHeaders,
        },
      );
    }
    return Response.json(
      {
        success: true,
        spinNumber: spinData[0].spin_number,
        spinsRemaining: spinData[0].spins_remaining,
        prize: selectedPrize,
      },
      {
        headers: corsHeaders,
      },
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
    return failure(error);
  }
}
Deno.serve(handleRoulette);
