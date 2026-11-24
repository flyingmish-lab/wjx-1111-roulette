"use strict";
const apiBase = "https://xfslymkzlzfsrzaoerpn.supabase.co/functions/v1/";
const byId = (id) => document.getElementById(id);
let adminToken = "";
let expiryTimer;
let prizeChances = [];
let spinUsersOffset = 0;
let winnersOffset = 0;
let winnersRequestVersion = 0;
let winnerDetailVersion = 0;

function message(text) {
  byId("statusMessage").textContent = text;
}
function clearSession(text = "") {
  adminToken = "";
  clearTimeout(expiryTimer);
  prizeChances = [];
  byId("loginForm").hidden = false;
  byId("adminContent").hidden = true;
  byId("settingsFields").disabled = true;
  byId("adminPassword").value = "";
  byId("prizeChancesFields").replaceChildren();
  byId("prizesPanel").replaceChildren();
  byId("prizeStockDate").textContent = "";
  byId("winsHistory").replaceChildren();
  byId("spinUserSelect").replaceChildren();
  byId("spinUserSearch").value = "";
  byId("spinUsersNote").textContent = "";
  byId("resetUserPrizesButton").disabled = true;
  spinUsersOffset = 0;
  winnersOffset = 0;
  winnersRequestVersion += 1;
  winnerDetailVersion += 1;
  byId("winnerSearch").value = "";
  byId("winnersList").replaceChildren();
  byId("winnersPeriod").textContent = "";
  byId("winnerDetails").replaceChildren();
  byId("winnerDetails").hidden = true;
  byId("botConnectionNote").textContent = "";
  byId("channelAccessNote").textContent = "";
  message(text);
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Сервер не ответил вовремя. Повторите запрос.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function callApi(endpoint, body, token = adminToken) {
  const response = await fetchWithTimeout(apiBase + endpoint, {
    method: "POST",
    cache: "no-store",
    credentials: "omit",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (token && token !== adminToken) throw new Error("Сессия завершена");
  const result = await response.json().catch(() => ({}));
  if (response.status === 401 && token) {
    clearSession("Сессия истекла. Войдите снова.");
  }
  if (!response.ok || !result.success) {
    const retry = response.status === 429
      ? Number(response.headers.get("Retry-After"))
      : 0;
    throw new Error(
      retry > 0
        ? `Слишком много попыток входа. Повторите через ${
          Math.ceil(retry / 60)
        } мин.`
        : result.error || "Не удалось выполнить запрос",
    );
  }
  return result;
}
const adminApi = (action, values = {}) => {
  if (!adminToken) throw new Error("Войдите в админ-панель");
  return callApi("wjx-roulette", { action, ...values });
};

function renderChances() {
  const fields = byId("prizeChancesFields");
  fields.replaceChildren();
  for (const item of prizeChances) {
    const label = document.createElement("label");
    label.append(`${item.prize}: `);
    const input = document.createElement("input");
    Object.assign(input, {
      type: "number",
      min: "0",
      max: "100",
      step: "0.0001",
      value: item.chance,
      className: "prizeChanceInput",
    });
    input.dataset.prize = item.prize;
    input.addEventListener("input", updateTotal);
    label.append(input, " %");
    fields.append(label);
    if (isWinningPrize(item.prize)) {
      const limitLabel = document.createElement("label");
      limitLabel.append("Максимум в день (МСК):");
      const limit = document.createElement("input");
      Object.assign(limit, {type: "number", min: "0", max: "1000000", step: "1",
        value: item.prize_limit ?? "", placeholder: "Без ограничения", className: "prizeLimitInput"});
      limit.dataset.prize = item.prize;
      limitLabel.append(limit);
      fields.append(limitLabel);
      const stock = document.createElement("p");
      stock.textContent = `Сегодня выиграно: ${item.todayWins} | Осталось сегодня: ${item.remainingToday ?? "без ограничения"}`;
      fields.append(stock);
    }
  }
  updateTotal();
}
function updateTotal() {
  const inputs = [...document.querySelectorAll(".prizeChanceInput")];
  const total = inputs.reduce((sum, input) => sum + Number(input.value), 0);
  byId("prizeChancesTotal").textContent = `Итого: ${total.toFixed(4)}%`;
  byId("prizeChancesTotal").style.color = Math.abs(total - 100) <= 0.001
    ? "green"
    : "red";
}
async function loadSettings() {
  const { settings } = await adminApi("admin_get_settings");
  byId("startDate").value = settings.event_start;
  byId("endDate").value = settings.event_end;
  byId("startTime").value = settings.start_time.slice(0, 5);
  byId("endTime").value = settings.end_time.slice(0, 5);
  byId("dailySpins").value = settings.daily_spins;
  byId("spinsPaused").checked = settings.spins_paused === true;
}
async function loadPrizes() {
  const result = await adminApi("admin_get_prizes");
  if (result.limitScope !== "day") throw Error("Обновление дневных лимитов ещё не завершено. Повторите загрузку позже.");
  byId("prizeStockDate").textContent = `Остатки за ${result.stockDate.split("-").reverse().join(".")} (МСК)`;
  prizeChances = result.prizes;
  renderChances();
  const panel = byId("prizesPanel");
  panel.replaceChildren();
  for (
    const item of result.prizes.filter((item) => isWinningPrize(item.prize))
  ) {
    const line = document.createElement("p");
    line.textContent =
      `${item.prize} — шанс ${item.chance}% | Лимит в день: ${item.prize_limit ?? "без ограничения"} | Сегодня выиграно: ${item.todayWins} | Осталось сегодня: ${item.remainingToday ?? "без ограничения"} | Всего начислено: ${item.realWins} | Сброшено: ${item.resetWins ?? 0}`;
    panel.append(line);
  }
  const history = byId("winsHistory");
  const title = document.createElement("h3");
  title.textContent = "Призы среди последних 50 реальных прокруток";
  history.replaceChildren(title);
  for (
    const spin of result.history.filter((spin) => isWinningPrize(spin.prize))
  ) {
    const line = document.createElement("p");
    const name = spin.username
      ? `@${spin.username}`
      : spin.first_name || "Участник";
    if (spin.telegram_id) line.append(winnerButton(spin.telegram_id, name));
    else line.append(name);
    line.append(` | ${spin.spin_date} | ${spin.prize}${spin.prize_reset ? " — сброшен" : ""}`);
    history.append(line);
  }
}

byId("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = byId("loginButton");
  button.disabled = true;
  message("Проверяем пароль…");
  try {
    const pending = callApi("wjx-admin-auth", {
      action: "login",
      password: byId("adminPassword").value,
    }, "");
    byId("adminPassword").value = "";
    const result = await pending;
    if (
      !Number.isFinite(Date.parse(result.expires_at)) ||
      typeof result.token !== "string" || !result.token
    ) {
      throw new Error("Некорректный ответ сервера входа");
    }
    // Device wall clocks may differ from the server. This relative timer only
    // clears the UI; the server verifies the signed expiry on every API call.
    const remaining = 60 * 60 * 1000;
    adminToken = result.token;
    expiryTimer = setTimeout(
      () => clearSession("Сессия истекла. Войдите снова."),
      remaining,
    );
    byId("loginForm").hidden = true;
    byId("adminContent").hidden = false;
    byId("sessionNote").textContent = `Сессия до ${
      new Date(result.expires_at).toLocaleTimeString("ru-RU", {
        timeZone: "Europe/Moscow",
      })
    } МСК`;
    await Promise.all([
      loadSettings(),
      loadPrizes(),
      loadSpinUsers(),
      loadWinners(),
    ]);
    byId("settingsFields").disabled = false;
    byId("saveButton").disabled = false;
    message("Настройки загружены.");
  } catch (error) {
    if (!adminToken) clearSession(error.message);
    else {message(
        `Вход выполнен, но загрузка не завершена: ${error.message}. Выйдите и войдите повторно.`,
      );}
  } finally {
    button.disabled = false;
  }
});

byId("logoutButton").addEventListener("click", async () => {
  const token = adminToken;
  // Clear sensitive UI immediately; send revocation using the captured token.
  clearSession("Вы вышли из админ-панели.");
  if (!token) return;
  try {
    const response = await fetchWithTimeout(apiBase + "wjx-admin-auth", {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action: "logout" }),
    });
    if (!response.ok && response.status !== 401) {
      throw new Error("Logout unavailable");
    }
  } catch {
    message(
      "Вы вышли на этом устройстве. Сервер не подтвердил отзыв сессии; она истечёт в течение часа.",
    );
  }
});

byId("saveButton").addEventListener("click", async () => {
  const button = byId("saveButton");
  button.disabled = true;
  try {
    await adminApi("admin_save_settings", {
      settings: {
        event_start: byId("startDate").value,
        event_end: byId("endDate").value,
        start_time: byId("startTime").value,
        end_time: byId("endTime").value,
        daily_spins: Number(byId("dailySpins").value),
      },
    });
    message("Настройки сохранены.");
  } catch (error) {
    message(error.message);
  } finally {
    button.disabled = false;
  }
});
byId("suggestPrizePlanButton").addEventListener("click", () => {
  const attempts = Number(byId("dailySpins").value);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20) {
    message("Укажите количество попыток в день от 1 до 20."); return;
  }
  const limits = [...document.querySelectorAll(".prizeLimitInput")];
  if (limits.some((input) => !input.value.trim() || input.validity.badInput || !Number.isInteger(Number(input.value)) || Number(input.value) < 0 || Number(input.value) > 1000000)) {
    message("Для расчёта укажите целый дневной лимит каждого приза. Безлимитные призы настройте вручную."); return;
  }
  const spins = 1000 * attempts;
  const chances = new Map(limits.map((input) => [input.dataset.prize, Math.round(Number(input.value) / spins * 1000000)]));
  const total = [...chances.values()].reduce((sum, value) => sum + value, 0);
  if (total > 1000000) {message("Сумма дневных лимитов превышает число прокруток. Уменьшите лимиты или настройте шансы вручную."); return;}
  chances.set("Без выигрыша", 1000000 - total);
  for (const input of document.querySelectorAll(".prizeChanceInput")) input.value = chances.get(input.dataset.prize) / 10000;
  updateTotal();
  message(`Расчёт на ${spins} прокруток в день подставлен. Проверьте значения и нажмите «Сохранить вероятности и лимиты».`);
});
byId("savePrizeChancesButton").addEventListener("click", async () => {
  const inputs = [...document.querySelectorAll(".prizeChanceInput")];
  const prizes = inputs.map((input) => ({
    prize: input.dataset.prize,
    chance: Number(input.value),
    prize_limit: null,
  }));
  for (const limit of document.querySelectorAll(".prizeLimitInput")) {
    const value = limit.value.trim();
    if (limit.validity.badInput || (value && (!Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 1000000))) {
      message("Количество призов должно быть целым числом от 0 до 1000000. Пустое поле — без ограничения.");
      return;
    }
    prizes.find((item) => item.prize === limit.dataset.prize).prize_limit = value ? Number(value) : null;
  }
  if (
    inputs.length !== prizeChances.length || inputs.length !== 7 || inputs.some((input) => !input.value.trim()) ||
    prizes.some((item) =>
      !Number.isFinite(item.chance) || item.chance < 0 || item.chance > 100
    ) ||
    Math.abs(prizes.reduce((sum, item) => sum + item.chance, 0) - 100) > 0.001
  ) {
    message("Сумма вероятностей должна быть ровно 100%.");
    return;
  }
  const button = byId("savePrizeChancesButton");
  button.disabled = true;
  try {
    await adminApi("admin_save_prize_chances", { prizes, limitScope: "day" });
    await loadPrizes();
    message("Вероятности сохранены. Лимиты призов сохранены.");
  } catch (error) {
    message(error.message);
  } finally {
    button.disabled = false;
  }
});
byId("viewPrizesButton").addEventListener("click", async () => {
  const visible = byId("prizesPanel").style.display === "none";
  byId("prizesPanel").style.display = visible ? "block" : "none";
  byId("winsHistory").style.display = visible ? "block" : "none";
  if (visible) {
    try {
      await loadPrizes();
    } catch (error) {
      message(error.message);
    }
  }
});
// Remove a legacy Telegram authorization value, if this browser used the old panel.
sessionStorage.removeItem("wjxAdminInitData");
clearSession();

function newResetId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
const pendingResets = new Map();
function resetRequestId(id, kind = "daily") {
  id = kind === "daily" ? id : `prizes:${id}`;
  if (pendingResets.has(id)) return pendingResets.get(id);
  let requestId;
  try {requestId = sessionStorage.getItem(`wjxDailyReset:${id}`);} catch {}
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId || "")) {
    requestId = newResetId();
  }
  pendingResets.set(id, requestId);
  try {sessionStorage.setItem(`wjxDailyReset:${id}`, requestId);} catch {}
  return requestId;
}
function clearResetRequest(id, kind = "daily") {
  id = kind === "daily" ? id : `prizes:${id}`;
  pendingResets.delete(id);
  try {sessionStorage.removeItem(`wjxDailyReset:${id}`);} catch {}
}
async function loadSpinUsers() {
  const result = await adminApi("admin_spin_users", {
    search: byId("spinUserSearch").value.trim().replace(/^@/, ""), offset: spinUsersOffset,
  });
  const select = byId("spinUserSelect");
  const selected = select.value;
  select.replaceChildren();
  for (const user of result.users) {
    const option = document.createElement("option");
    option.value = user.telegram_id;
    option.textContent = `${user.first_name || "Участник"}${user.username ? ` (@${user.username})` : ""} | ID ${user.telegram_id} | Сегодня использовано: ${user.spins_used} | Осталось: ${user.spins_remaining}`;
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === selected)) select.value = selected;
  byId("prevSpinUsersButton").disabled = spinUsersOffset === 0;
  byId("nextSpinUsersButton").disabled = !result.has_more;
  byId("resetDailySpinsButton").disabled = result.users.length === 0;
  byId("resetUserPrizesButton").disabled = result.users.length === 0;
  byId("spinUsersNote").textContent = result.users.length
    ? `Попытки за ${result.spinDate.split("-").reverse().join(".")} (МСК). После сброса игроку нужно нажать «Обновить попытки» или заново открыть Mini App.`
    : "Пользователи не найдены. Они появятся после первого входа в Mini App.";
}
async function searchSpinUsers(offset) {
  spinUsersOffset = offset;
  try {await loadSpinUsers();} catch (error) {message(error.message);}
}
byId("findSpinUsersButton").addEventListener("click", () => searchSpinUsers(0));
byId("prevSpinUsersButton").addEventListener("click", () => searchSpinUsers(Math.max(0, spinUsersOffset - 25)));
byId("nextSpinUsersButton").addEventListener("click", () => searchSpinUsers(spinUsersOffset + 25));
byId("spinUserSearch").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {event.preventDefault(); searchSpinUsers(0);}
});
byId("resetDailySpinsButton").addEventListener("click", async () => {
  const telegram_id = byId("spinUserSelect").value;
  if (!telegram_id) {message("Выберите пользователя."); return;}
  const button = byId("resetDailySpinsButton"); button.disabled = true;
  try {
    const requestId = resetRequestId(telegram_id);
    const result = await adminApi("admin_reset_daily_spins", {telegram_id, requestId});
    await loadSpinUsers();
    clearResetRequest(telegram_id);
    message(`${result.replayed ? "Ранее выполненный сброс подтверждён" : "Прокрутки сброшены"} для ID ${telegram_id} за ${result.spinDate.split("-").reverse().join(".")}. Призы сохранены. Актуальный остаток показан в списке.`);
  } catch (error) {message(error.message);}
  finally {button.disabled = !adminToken || byId("spinUserSelect").options.length === 0;}
});

function isWinningPrize(prize) {
  return typeof prize === "string" && prize.trim() !== "" &&
    prize.trim() !== "Без выигрыша";
}
function winnerButton(id, name) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "winnerUserButton";
  button.textContent = name;
  button.dataset.telegramId = id;
  button.style.cssText =
    "width:auto;padding:4px 8px;font-size:15px;margin-right:6px";
  button.addEventListener("click", () => showWinnerDetails(id));
  return button;
}
function periodLabel(period) {
  const date = (value) => value?.split("-").reverse().join(".") || "—";
  return `Период: ${date(period?.event_start)} — ${
    date(period?.event_end)
  } (МСК)`;
}
async function loadWinners() {
  const version = ++winnersRequestVersion;
  ++winnerDetailVersion;
  byId("winnerDetails").hidden = true;
  byId("winnerDetails").replaceChildren();
  const result = await adminApi("admin_get_winners", {
    search: byId("winnerSearch").value.trim().replace(/^@/, ""),
    offset: winnersOffset,
  });
  if (version !== winnersRequestVersion) return;
  byId("winnersPeriod").textContent = periodLabel(result.period);
  const list = byId("winnersList");
  list.replaceChildren();
  for (const person of result.winners) {
    const row = document.createElement("p");
    const name = person.username
      ? `@${person.username}`
      : person.first_name || "Участник без ника";
    row.append(winnerButton(person.telegram_id, name));
    row.append(
      `Telegram ID: ${person.telegram_id} | Призов: ${person.total_wins}`,
    );
    list.append(row);
  }
  if (!result.winners.length) {
    list.textContent = "Реальных выигрышей за этот период не найдено.";
  }
  byId("prevWinnersButton").disabled = winnersOffset === 0;
  byId("nextWinnersButton").disabled = !result.has_more;
}
async function showWinnerDetails(id) {
  const version = ++winnerDetailVersion;
  const panel = byId("winnerDetails");
  panel.hidden = false;
  panel.textContent = "Загружаем выигрыши участника…";
  try {
    const result = await adminApi("admin_get_user_wins", { telegram_id: id });
    if (version !== winnerDetailVersion) return;
    panel.replaceChildren();
    const heading = document.createElement("h3");
    heading.textContent = result.participant.username
      ? `@${result.participant.username}`
      : result.participant.first_name || "Участник без ника";
    const identity = document.createElement("p");
    identity.textContent = `Telegram ID: ${result.participant.telegram_id}`;
    const period = document.createElement("p");
    period.textContent = periodLabel(result.period);
    const total = document.createElement("p");
    total.textContent = `Всего реальных призов: ${result.total_wins}`;
    panel.append(heading, identity, period, total);
    const delivery = document.createElement("p");
    delivery.textContent = `Выдано: ${
      result.delivered_count ?? 0
    } | Осталось выдать: ${result.remaining_count ?? result.total_wins}`;
    panel.append(delivery);
    for (const item of result.delivered_prizes ?? []) {
      const line = document.createElement("p");
      line.textContent = `Выдано: ${item.prize} × ${item.quantity}`;
      panel.append(line);
    }
    if (result.can_deliver && result.remaining_count > 0) {
      const issue = document.createElement("button");
      issue.type = "button";
      issue.textContent = "Отметить выдачу всех оставшихся призов";
      issue.addEventListener("click", async () => {
        issue.disabled = true;
        try {
          const saved = await adminApi("admin_mark_prizes_delivered", {
            telegram_id: id,
          });
          message(`Отмечена выдача: ${saved.marked_count}.`);
          if (version === winnerDetailVersion) await showWinnerDetails(id);
        } catch (error) {
          message(error.message);
          if (version === winnerDetailVersion) issue.disabled = false;
        }
      });
      panel.append(issue);
    }

    for (
      const item of result.prizes.filter((item) => isWinningPrize(item.prize))
    ) {
      const line = document.createElement("p");
      line.textContent = `${item.prize} × ${item.quantity}`;
      panel.append(line);
    }
    if (!result.total_wins) {
      const empty = document.createElement("p");
      empty.textContent = "Реальных выигрышей за этот период нет.";
      panel.append(empty);
    } else {
      const days = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Посмотреть по дням";
      days.append(summary);
      for (
        const item of result.daily.filter((item) => isWinningPrize(item.prize))
      ) {
        const line = document.createElement("p");
        line.textContent = `${
          item.spin_date.split("-").reverse().join(".")
        }: ${item.prize} × ${item.quantity}`;
        days.append(line);
      }
      panel.append(days);
    }
  } catch (error) {
    if (version === winnerDetailVersion && adminToken) {
      panel.textContent = error.message;
    }
  }
}
async function searchWinners(offset) {
  winnersOffset = offset;
  try {
    await loadWinners();
  } catch (error) {
    message(error.message);
  }
}
byId("findWinnersButton").addEventListener("click", () => searchWinners(0));
byId("prevWinnersButton").addEventListener(
  "click",
  () => searchWinners(Math.max(0, winnersOffset - 25)),
);
byId("nextWinnersButton").addEventListener(
  "click",
  () => searchWinners(winnersOffset + 25),
);
byId("winnerSearch").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    searchWinners(0);
  }
});

byId("checkBotButton").addEventListener("click", async () => {
  const button = byId("checkBotButton");
  button.disabled = true;
  try {
    const result = await adminApi("admin_bot_status");
    byId("botConnectionNote").textContent = result.otherWebhook
      ? "У бота подключён другой обработчик. Его замена автоматически заблокирована."
      : result.connected
      ? `Команды подключены. Ожидают обработки: ${result.pendingUpdates}.${
        result.deliveryError
          ? " Telegram сообщает об ошибке доставки; проверьте функцию бота."
          : ""
      }`
      : "Обработчик команд ещё не подключён.";
  } catch (error) {
    message(error.message);
  } finally {
    button.disabled = false;
  }
});
byId("configureBotButton").addEventListener("click", async () => {
  const button = byId("configureBotButton");
  button.disabled = true;
  try {
    const result = await adminApi("admin_configure_bot");
    byId("botConnectionNote").textContent = `Команды подключены${
      result.username ? " для @" + result.username : ""
    }. Проверьте их в личном чате с ботом.`;
  } catch (error) {
    message(error.message);
  } finally {
    button.disabled = false;
  }
});

byId("savePauseButton").addEventListener("click", async () => {
  const button = byId("savePauseButton");
  button.disabled = true;
  try {
    const result = await adminApi("admin_set_pause", {
      paused: byId("spinsPaused").checked,
    });
    byId("spinsPaused").checked = result.paused;
    message(
      byId("spinsPaused").checked
        ? "Новые прокрутки приостановлены."
        : "Прокрутки возобновлены.",
    );
  } catch (error) {
    message(error.message);
  } finally {
    button.disabled = false;
  }
});

byId("checkChannelButton").addEventListener("click", async () => {
  const button = byId("checkChannelButton");
  button.disabled = true;
  try {
    const result = await adminApi("admin_subscription_status");
    byId("channelAccessNote").textContent = result.ready
      ? "Бот — администратор канала. Можно проверять подписки."
      : "Добавьте бота администратором канала @tattoowjxrussia и повторите проверку.";
  } catch (error) {
    byId("channelAccessNote").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

byId("resetUserPrizesButton").addEventListener("click", async () => {
  const select = byId("spinUserSelect");
  const telegram_id = select.value;
  if (!adminToken || !telegram_id) {message("Выберите пользователя."); return;}
  const name = select.selectedOptions[0].textContent.split(" | ")[0];
  if (!confirm(`Сбросить все призы ${name} (ID ${telegram_id}) за даты текущего розыгрыша, включая выданные? Попытки не изменятся, призы не вернутся в запас. История сохранится.`)) return;
  const button = byId("resetUserPrizesButton");
  if (button.disabled) return;
  button.disabled = true;
  select.disabled = true;
  try {
    const result = await adminApi("admin_reset_user_prizes", {telegram_id, requestId: resetRequestId(telegram_id, "prizes")});
    await Promise.all([loadPrizes(), loadWinners()]);
    clearResetRequest(telegram_id, "prizes");
    message(`${result.replayed ? "Ранее выполненный сброс подтверждён" : "Призы сброшены"}: ${name} (ID ${telegram_id}). Призов: ${result.reset_count}. Попытки и расход дневного запаса сохранены.`);
  } catch (error) {message(error.message);}
  finally {select.disabled = false; button.disabled = !adminToken || select.options.length === 0;}
});
