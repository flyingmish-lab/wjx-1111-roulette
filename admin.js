"use strict";
const apiBase = "https://xfslymkzlzfsrzaoerpn.supabase.co/functions/v1/";
const byId = (id) => document.getElementById(id);
let adminToken = "";
let expiryTimer;
let prizeChances = [];
let testUsersOffset = 0;

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
  byId("winsHistory").replaceChildren();
  byId("testUserSelect").replaceChildren();
  byId("testUserSearch").value = "";
  byId("testUsersNote").textContent = "";
  testUsersOffset = 0;
  message(text);
}

async function callApi(endpoint, body, token = adminToken) {
  const response = await fetch(apiBase + endpoint, {
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
      step: "0.01",
      value: item.chance,
      className: "prizeChanceInput",
    });
    input.dataset.prize = item.prize;
    input.addEventListener("input", updateTotal);
    label.append(input, " %");
    fields.append(label);
  }
  updateTotal();
}
function updateTotal() {
  const inputs = [...document.querySelectorAll(".prizeChanceInput")];
  const total = inputs.reduce((sum, input) => sum + Number(input.value), 0);
  byId("prizeChancesTotal").textContent = `Итого: ${total.toFixed(2)}%`;
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
}
async function loadPrizes() {
  const result = await adminApi("admin_get_prizes");
  prizeChances = result.prizes;
  renderChances();
  const panel = byId("prizesPanel");
  panel.replaceChildren();
  for (const item of result.prizes) {
    const line = document.createElement("p");
    line.textContent =
      `${item.prize} — шанс ${item.chance}% | Выигрышей: ${item.realWins} | Тестовых (без призов): ${item.testWins}`;
    panel.append(line);
  }
  const history = byId("winsHistory");
  const title = document.createElement("h3");
  title.textContent = "История последних 50 прокруток";
  history.replaceChildren(title);
  for (const spin of result.history) {
    const line = document.createElement("p");
    line.textContent = `${
      spin.username ? `@${spin.username}` : spin.first_name
    } | ${spin.spin_date} | ${spin.prize ?? "Без выигрыша"}`;
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
    if (!Number.isFinite(Date.parse(result.expires_at)) || typeof result.token !== "string" || !result.token) {
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
    await Promise.all([loadSettings(), loadPrizes(), loadTestUsers()]);
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
    const response = await fetch(apiBase + "wjx-admin-auth", {
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
byId("savePrizeChancesButton").addEventListener("click", async () => {
  const inputs = [...document.querySelectorAll(".prizeChanceInput")];
  const prizes = inputs.map((input) => ({
    prize: input.dataset.prize,
    chance: Number(input.value),
  }));
  if (
    inputs.length !== 6 || inputs.some((input) => !input.value.trim()) ||
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
    await adminApi("admin_save_prize_chances", { prizes });
    await loadPrizes();
    message("Вероятности сохранены.");
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

async function loadTestUsers() {
  const result = await adminApi("admin_test_users", {
    search: byId("testUserSearch").value.trim().replace(/^@/, ""),
    offset: testUsersOffset,
  });
  const select = byId("testUserSelect");
  select.replaceChildren();
  for (const user of result.users) {
    const option = document.createElement("option");
    option.value = user.telegram_id;
    option.textContent = `${user.first_name || "Участник"}${
      user.username ? ` (@${user.username})` : ""
    } | ID ${user.telegram_id} | Остаток: ${user.test_remaining}`;
    option.dataset.remaining = user.test_remaining;
    select.append(option);
  }
  byId("prevTestUsersButton").disabled = testUsersOffset === 0;
  byId("nextTestUsersButton").disabled = !result.has_more;
  byId("setTestAttemptsButton").disabled = result.users.length === 0;
  byId("testUsersNote").textContent = result.users.length
    ? "Выберите пользователя. Сохранение заменит остаток, а не добавит попытки."
    : "Пользователи не найдены. Они появятся после первого входа в Mini App.";
}
async function searchTestUsers(offset) {
  testUsersOffset = offset;
  try {
    await loadTestUsers();
  } catch (error) {
    message(error.message);
  }
}
byId("findTestUsersButton").addEventListener("click", () => searchTestUsers(0));
byId("prevTestUsersButton").addEventListener(
  "click",
  () => searchTestUsers(Math.max(0, testUsersOffset - 25)),
);
byId("nextTestUsersButton").addEventListener(
  "click",
  () => searchTestUsers(testUsersOffset + 25),
);
byId("testUserSearch").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    searchTestUsers(0);
  }
});
byId("testUserSelect").addEventListener("change", () => {
  const option = byId("testUserSelect").selectedOptions[0];
  if (option) byId("testAttempts").value = option.dataset.remaining;
});
byId("setTestAttemptsButton").addEventListener("click", async () => {
  const telegram_id = byId("testUserSelect").value;
  const attempts = Number(byId("testAttempts").value);
  if (
    !telegram_id || !byId("testAttempts").value.trim() ||
    !Number.isInteger(attempts) || attempts < 0 || attempts > 100
  ) {
    message("Выберите пользователя и остаток от 0 до 100.");
    return;
  }
  const button = byId("setTestAttemptsButton");
  button.disabled = true;
  try {
    await adminApi("admin_set_test_spins", { telegram_id, attempts });
    await loadTestUsers();
    byId("testUserSelect").value = telegram_id;
    message(
      `Тестовый остаток для ID ${telegram_id}: ${attempts}. Реальные попытки не изменены.`,
    );
  } catch (error) {
    message(error.message);
  } finally {
    button.disabled = byId("testUserSelect").options.length === 0;
  }
});
