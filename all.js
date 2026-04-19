/* ============================================================
   公司內部點餐系統 - 主要邏輯
   技術棧：純 JavaScript + Google Identity Services + Sheets API v4
   ============================================================ */

// ============================================================
// ★ 設定區域：請在使用前填入您的 Google Cloud 專案資訊
// ============================================================
const CONFIG = {
    // 您的 OAuth 2.0 用戶端 ID（在 GCP 主控台 → API 和服務 → 憑證 中建立）
    CLIENT_ID: '773178309570-788jnj08pukssfvtevc18nq5sme9qp1t.apps.googleusercontent.com',

    // 目標 Google Sheets 的試算表 ID（URL 中 /d/ 和 /edit 之間的那段字串）
    SPREADSHEET_ID: '1YBPel649pQ52uNiGs_IRMRkNXJy-l8rDuClmoCWXwuE',

    // Sheets API v4 的基礎 URL（不需要修改）
    SHEETS_API_BASE: 'https://sheets.googleapis.com/v4/spreadsheets',
};

// ============================================================
// 全域狀態
// ============================================================
let accessToken = null;     // Google OAuth 存取憑證（用於呼叫 API）
let tokenClient  = null;    // GIS Token Client 物件
let currentUser  = {
    email: '',
    name:  '',
    role:  '',              // '管理員' 或 '一般成員'
};

// 快取今日訂單資料，供「一鍵複製」使用
let todayOrdersCache = [];

// 附加選項快取：{ 分類: { 選項類型: { values: [...], defaultValue: '...' } } }
// 例如：{ '飲品': { '甜度': { values: ['全糖','半糖',...], defaultValue: '半糖' } } }
let optionsCache = {};

// ============================================================
// 初始化
// ============================================================

/**
 * 頁面載入完成後初始化 Google Identity Services
 * 因為 GIS 腳本以 async defer 載入，需輪詢等候
 */
window.addEventListener('load', function () {
    waitForGIS();
});

function waitForGIS() {
    if (typeof google !== 'undefined' && google.accounts) {
        initGoogleAuth();
    } else {
        setTimeout(waitForGIS, 150);
    }
}

/**
 * 初始化 GIS Token Client
 * 使用 Implicit Grant 流程（純前端，不需要後端 secret）
 */
function initGoogleAuth() {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.CLIENT_ID,
        // 同時申請試算表讀寫權限與使用者基本資料
        scope: 'https://www.googleapis.com/auth/spreadsheets ' +
               'https://www.googleapis.com/auth/userinfo.email ' +
               'https://www.googleapis.com/auth/userinfo.profile',
        callback: handleTokenResponse,
    });

    renderLoginButton();
}

/**
 * 在 #google-signin-btn 容器中渲染自訂的 Google 登入按鈕
 */
function renderLoginButton() {
    const container = document.getElementById('google-signin-btn');
    container.innerHTML = '';

    const btn = document.createElement('button');
    btn.className = 'btn-google';
    btn.innerHTML =
        '<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">' +
            '<path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908C16.658 14.013 17.64 11.705 17.64 9.2z" fill="#4285F4"/>' +
            '<path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>' +
            '<path d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z" fill="#FBBC05"/>' +
            '<path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 6.293C4.672 4.166 6.656 3.58 9 3.58z" fill="#EA4335"/>' +
        '</svg>' +
        '使用 Google 帳號登入';

    btn.addEventListener('click', startSignIn);
    container.appendChild(btn);
}

/**
 * 觸發 Google OAuth 彈出視窗
 * prompt: 'select_account' 讓使用者每次都能選擇帳號
 */
function startSignIn() {
    tokenClient.requestAccessToken({ prompt: 'select_account' });
}

/**
 * GIS Token 回呼：取得 access_token 後執行身份驗證流程
 * @param {Object} response - Google 回傳的 token 物件
 */
async function handleTokenResponse(response) {
    if (response.error) {
        showToast('登入失敗：' + response.error, 'error');
        return;
    }

    accessToken = response.access_token;
    showToast('驗證身份中，請稍候…', 'info');

    try {
        // 1. 取得 Google 帳戶資訊（email / name）
        const userInfo = await fetchUserInfo();
        currentUser.email = userInfo.email;
        currentUser.name  = userInfo.name || userInfo.email;

        // 2. 比對 Users 工作表，決定是否授權
        await checkUserAuthorization();
    } catch (err) {
        console.error('[登入流程錯誤]', err);
        showToast('登入過程發生錯誤：' + err.message, 'error');
    }
}

// ============================================================
// Google Sheets API 輔助函式
// ============================================================

/**
 * 呼叫 Google UserInfo API 取得使用者基本資料
 * @returns {Promise<{email: string, name: string}>}
 */
async function fetchUserInfo() {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: 'Bearer ' + accessToken },
    });
    if (!res.ok) throw new Error('無法取得使用者資訊（HTTP ' + res.status + '）');
    return res.json();
}

/**
 * 讀取工作表資料，回傳二維陣列（含標題列）
 * @param {string} sheet - 工作表名稱，例如 'Users'
 * @param {string} range - 資料欄範圍，例如 'A:C'（可省略）
 * @returns {Promise<string[][]>}
 */
async function sheetsGet(sheet, range) {
    const rangeStr = range ? sheet + '!' + range : sheet;
    const url = CONFIG.SHEETS_API_BASE + '/' + CONFIG.SPREADSHEET_ID +
                '/values/' + encodeURIComponent(rangeStr);

    const res = await fetch(url, {
        headers: { Authorization: 'Bearer ' + accessToken },
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || '讀取試算表失敗（HTTP ' + res.status + '）');
    }

    const data = await res.json();
    return data.values || [];
}

/**
 * 在工作表末尾新增一列
 * @param {string} sheet    - 工作表名稱
 * @param {Array}  rowData  - 要新增的資料陣列（一維）
 */
async function sheetsAppend(sheet, rowData) {
    // RAW 模式：時間字串不被 Sheets 自動轉為日期序號，確保讀回時格式一致
    const url = CONFIG.SHEETS_API_BASE + '/' + CONFIG.SPREADSHEET_ID +
                '/values/' + encodeURIComponent(sheet) +
                ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS';

    const res = await fetch(url, {
        method:  'POST',
        headers: {
            Authorization:  'Bearer ' + accessToken,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ values: [rowData] }),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || '寫入試算表失敗（HTTP ' + res.status + '）');
    }

    return res.json();
}

/**
 * 覆寫工作表指定起始格以下的資料（PUT 方式）
 * @param {string}   sheet   - 工作表名稱
 * @param {string}   start   - 起始儲存格，例如 'A2'
 * @param {string[][]} values - 二維陣列資料
 */
async function sheetsUpdate(sheet, start, values) {
    const rangeStr = sheet + '!' + start;
    const url = CONFIG.SHEETS_API_BASE + '/' + CONFIG.SPREADSHEET_ID +
                '/values/' + encodeURIComponent(rangeStr) +
                '?valueInputOption=USER_ENTERED';

    const res = await fetch(url, {
        method:  'PUT',
        headers: {
            Authorization:  'Bearer ' + accessToken,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ values: values }),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || '更新試算表失敗（HTTP ' + res.status + '）');
    }

    return res.json();
}

/**
 * 清除工作表指定範圍的資料（不刪除列，僅清空內容）
 * @param {string} sheet - 工作表名稱
 * @param {string} range - 範圍，例如 'A2:F10000'
 */
async function sheetsClear(sheet, range) {
    const rangeStr = sheet + '!' + range;
    const url = CONFIG.SHEETS_API_BASE + '/' + CONFIG.SPREADSHEET_ID +
                '/values/' + encodeURIComponent(rangeStr) + ':clear';

    const res = await fetch(url, {
        method:  'POST',
        headers: { Authorization: 'Bearer ' + accessToken },
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || '清除試算表失敗（HTTP ' + res.status + '）');
    }

    return res.json();
}

// ============================================================
// 身分驗證與權限判斷
// ============================================================

/**
 * 比對 Users 工作表中的 Email 欄位，判斷使用者是否獲授權
 * 授權：進入主畫面並依權限顯示相應功能
 * 未授權：顯示未授權畫面
 */
async function checkUserAuthorization() {
    let rows;
    try {
        rows = await sheetsGet('Users', 'A:C');
    } catch (err) {
        showToast('無法讀取授權名單：' + err.message, 'error');
        return;
    }

    // 第一列為標題，從索引 1 開始比對 Email（不分大小寫）
    const normalizedEmail = currentUser.email.trim().toLowerCase();
    const matched = rows.slice(1).find(function (row) {
        return row[1] && row[1].trim().toLowerCase() === normalizedEmail;
    });

    if (!matched) {
        showScreen('unauthorized-screen');
        return;
    }

    // 取得使用者姓名與權限
    currentUser.name = matched[0] || currentUser.name;
    currentUser.role = matched[2] || '一般成員';

    // 切換到主畫面
    showScreen('main-screen');
    document.getElementById('user-name').textContent =
        currentUser.name + '（' + currentUser.role + '）';

    // 管理員：顯示設定餐廳區塊與清空按鈕
    if (currentUser.role === '管理員') {
        document.getElementById('admin-config').classList.remove('hidden');
        document.getElementById('admin-clear').classList.remove('hidden');
        loadRestaurantConfig();
    }

    // 所有已授權使用者：載入今日菜單與訂單
    await loadMenu();
    await loadTodayOrders();
}

// ============================================================
// 管理員功能：設定今日餐廳
// ============================================================

/**
 * 從 Menu 取得所有餐廳名稱，並從 TodayConfig 取得已選餐廳，
 * 渲染成勾選框供管理員操作
 */
async function loadRestaurantConfig() {
    try {
        const [menuRows, configRows] = await Promise.all([
            sheetsGet('Menu', 'A:A'),
            sheetsGet('TodayConfig', 'A:A'),
        ]);

        // 從 Menu 第 1 欄取出唯一餐廳名稱（去除標題列與空值）
        const allRestaurants = [];
        const seen = new Set();
        menuRows.slice(1).forEach(function (row) {
            const name = row[0] && row[0].trim();
            if (name && !seen.has(name)) {
                seen.add(name);
                allRestaurants.push(name);
            }
        });

        // 今日已選餐廳的集合
        const todaySet = new Set(
            configRows.slice(1)
                .map(function (row) { return row[0] && row[0].trim(); })
                .filter(Boolean)
        );

        // 渲染勾選框
        const container = document.getElementById('restaurant-checkboxes');
        container.innerHTML = '';

        if (allRestaurants.length === 0) {
            container.innerHTML = '<p class="empty-hint">Menu 工作表中尚無餐廳資料。</p>';
            return;
        }

        allRestaurants.forEach(function (name) {
            const label = document.createElement('label');
            label.className = 'checkbox-label';

            const checkbox = document.createElement('input');
            checkbox.type    = 'checkbox';
            checkbox.value   = name;
            checkbox.checked = todaySet.has(name);

            const span = document.createElement('span');
            span.textContent = name;

            label.appendChild(checkbox);
            label.appendChild(span);
            container.appendChild(label);
        });
    } catch (err) {
        console.error('[載入餐廳設定失敗]', err);
        showToast('載入餐廳清單失敗：' + err.message, 'error');
    }
}

/**
 * 將管理員勾選的餐廳清單儲存到 TodayConfig 工作表
 * 流程：清除舊資料 → 寫入新資料 → 重新載入菜單
 */
async function saveTodayConfig() {
    const checked = document.querySelectorAll(
        '#restaurant-checkboxes input[type="checkbox"]:checked'
    );
    const selected = Array.from(checked).map(function (cb) { return cb.value; });

    if (selected.length === 0) {
        showToast('請至少勾選一家餐廳', 'warning');
        return;
    }

    try {
        showToast('儲存中…', 'info');

        // 先清除第二列以後的舊資料
        await sheetsClear('TodayConfig', 'A2:A1000');

        // 再寫入新選擇的餐廳（每列一個名稱）
        const values = selected.map(function (name) { return [name]; });
        await sheetsUpdate('TodayConfig', 'A2', values);

        showToast('今日餐廳設定已儲存！', 'success');

        // 重新載入菜單以反映最新設定
        await loadMenu();
    } catch (err) {
        console.error('[儲存今日餐廳失敗]', err);
        showToast('儲存失敗：' + err.message, 'error');
    }
}

// ============================================================
// 附加選項：從 Options 工作表載入
// ============================================================

/**
 * 讀取 Options 工作表，建立 optionsCache
 * 格式：{ 分類: { 選項類型: { values: [...], defaultValue: '' } } }
 * 若工作表不存在或讀取失敗，靜默略過（不影響點餐流程）
 */
async function loadOptions() {
    try {
        const rows = await sheetsGet('Options', 'A:D');
        optionsCache = {};
        rows.slice(1).forEach(function (row) {
            const category   = row[0] && row[0].trim();
            const optionType = row[1] && row[1].trim();
            const optionVal  = row[2] && row[2].trim();
            const isDefault  = row[3] && row[3].trim().toUpperCase() === 'Y';
            if (!category || !optionType || !optionVal) return;
            if (!optionsCache[category]) optionsCache[category] = {};
            if (!optionsCache[category][optionType]) {
                optionsCache[category][optionType] = { values: [], defaultValue: '' };
            }
            optionsCache[category][optionType].values.push(optionVal);
            if (isDefault) optionsCache[category][optionType].defaultValue = optionVal;
        });
    } catch (err) {
        console.warn('[Options 工作表讀取失敗，附加選項功能略過]', err);
        optionsCache = {};
    }
}

// ============================================================
// 點餐介面：讀取 TodayConfig + Menu → 渲染菜單卡片
// ============================================================

/**
 * 主要菜單載入函式
 * 1. 讀取今日開放餐廳（TodayConfig）
 * 2. 讀取完整菜單（Menu）
 * 3. 過濾並依餐廳 → 分類兩層分組後渲染
 */
async function loadMenu() {
    const container = document.getElementById('menu-container');
    container.innerHTML = '<p class="loading">載入菜單中…</p>';

    try {
        // 平行讀取三張工作表以節省時間
        const [configRows, menuRows] = await Promise.all([
            sheetsGet('TodayConfig', 'A:A'),
            sheetsGet('Menu', 'A:D'),
            loadOptions(),   // 同步載入附加選項快取
        ]);

        // 今日開放餐廳集合
        const todaySet = new Set(
            configRows.slice(1)
                .map(function (row) { return row[0] && row[0].trim(); })
                .filter(Boolean)
        );

        if (todaySet.size === 0) {
            container.innerHTML = '<p class="empty-hint">今日尚未設定開放餐廳，請聯絡管理員。</p>';
            return;
        }

        // 過濾出屬於今日餐廳的餐點（跳過標題列）
        const todayItems = menuRows.slice(1).filter(function (row) {
            return row[0] && todaySet.has(row[0].trim());
        });

        if (todayItems.length === 0) {
            container.innerHTML = '<p class="empty-hint">今日菜單中尚無餐點資料。</p>';
            return;
        }

        // 依餐廳分組：{ 餐廳名稱: { 分類: [{ itemName, price }] } }
        const groups = {};
        todayItems.forEach(function (row) {
            const restaurant = row[0].trim();
            const itemName   = row[1] || '';
            const price      = row[2] || '0';
            const category   = row[3] || '其他';

            if (!groups[restaurant]) groups[restaurant] = {};
            if (!groups[restaurant][category]) groups[restaurant][category] = [];
            groups[restaurant][category].push({ itemName: itemName, price: price, category: category });
        });

        // 渲染
        container.innerHTML = '';
        Object.keys(groups).forEach(function (restaurant) {
            const section = document.createElement('div');
            section.className = 'restaurant-section';

            const title = document.createElement('h3');
            title.className   = 'restaurant-title';
            title.textContent = restaurant;
            section.appendChild(title);

            const categories = groups[restaurant];
            Object.keys(categories).forEach(function (category) {
                const catDiv = document.createElement('div');
                catDiv.className = 'category-group';

                const catLabel = document.createElement('div');
                catLabel.className   = 'category-label';
                catLabel.textContent = category;
                catDiv.appendChild(catLabel);

                categories[category].forEach(function (item) {
                    catDiv.appendChild(createMenuCard(restaurant, item));
                });

                section.appendChild(catDiv);
            });

            container.appendChild(section);
        });
    } catch (err) {
        console.error('[載入菜單失敗]', err);
        container.innerHTML = '<p class="error-hint">載入菜單失敗：' + err.message + '</p>';
    }
}

/**
 * 建立單一餐點卡片的 DOM 元素
 * @param {string} restaurant - 餐廳名稱
 * @param {{itemName: string, price: string, category: string}} item - 餐點資料
 * @returns {HTMLElement}
 */
function createMenuCard(restaurant, item) {
    const card = document.createElement('div');
    card.className = 'menu-card';

    // 餐點名稱 + 單價列
    const info = document.createElement('div');
    info.className = 'card-info';
    info.innerHTML =
        '<span class="item-name">' + escapeHtml(item.itemName) + '</span>' +
        '<span class="item-price">$' + escapeHtml(item.price) + '</span>';

    card.appendChild(info);

    // 附加選項列（依 optionsCache 中該分類的設定動態產生下拉選單）
    const categoryOptions = optionsCache[item.category] || {};
    const optionTypes = Object.keys(categoryOptions);
    if (optionTypes.length > 0) {
        const optionsRow = document.createElement('div');
        optionsRow.className = 'options-row';

        optionTypes.forEach(function (optionType) {
            const data = categoryOptions[optionType];

            const wrapper = document.createElement('div');
            wrapper.className = 'option-wrapper';

            const label = document.createElement('span');
            label.className   = 'option-label';
            label.textContent = optionType;

            const select = document.createElement('select');
            select.className            = 'option-select';
            select.dataset.optionType   = optionType;

            data.values.forEach(function (val) {
                const opt = document.createElement('option');
                opt.value       = val;
                opt.textContent = val;
                if (val === data.defaultValue) opt.selected = true;
                select.appendChild(opt);
            });

            wrapper.appendChild(label);
            wrapper.appendChild(select);
            optionsRow.appendChild(wrapper);
        });

        card.appendChild(optionsRow);
    }

    // 備註輸入 + 點餐按鈕列
    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const noteInput = document.createElement('input');
    noteInput.type        = 'text';
    noteInput.className   = 'note-input';
    noteInput.placeholder = '備註（如：不要菜脯）';
    noteInput.maxLength   = 100;

    const orderBtn = document.createElement('button');
    orderBtn.className   = 'btn-order';
    orderBtn.textContent = '點餐';

    // 點餐時一併收集附加選項，拼入餐點內容
    orderBtn.addEventListener('click', function () {
        const selects = card.querySelectorAll('.option-select');
        submitOrder(orderBtn, restaurant, item.itemName, item.price, noteInput, selects);
    });

    actions.appendChild(noteInput);
    actions.appendChild(orderBtn);
    card.appendChild(actions);
    return card;
}

// ============================================================
// 訂單送出
// ============================================================

/**
 * 將一筆訂單寫入 Orders 工作表
 * @param {HTMLButtonElement} btn        - 觸發的按鈕（用於停用/恢復）
 * @param {string}            restaurant - 餐廳名稱
 * @param {string}            itemName   - 餐點名稱
 * @param {string|number}     price      - 金額
 * @param {HTMLInputElement}  noteInput  - 備註輸入框
 * @param {NodeList}          selects    - 附加選項的 <select> 元素集合（可選）
 */
async function submitOrder(btn, restaurant, itemName, price, noteInput, selects) {
    const note      = noteInput.value.trim();
    const timestamp = formatTimestamp(new Date());

    // 收集附加選項，拼成「炸排骨飯（飯多）」或「珍珠奶茶(L)（半糖／少冰）」
    const selectedOpts = selects && selects.length > 0
        ? Array.from(selects).map(function (s) { return s.value; }).filter(Boolean)
        : [];
    const fullItemName = selectedOpts.length > 0
        ? itemName + '（' + selectedOpts.join('／') + '）'
        : itemName;

    // 停用按鈕，避免重複送出
    btn.disabled     = true;
    btn.textContent  = '送出中…';

    try {
        await sheetsAppend('Orders', [
            timestamp,
            currentUser.email,
            restaurant,
            fullItemName,
            price,
            note,
        ]);

        showToast('已成功點餐：' + fullItemName + '！', 'success');
        noteInput.value = '';

        // 重新整理訂單列表
        await loadTodayOrders();
    } catch (err) {
        console.error('[送出訂單失敗]', err);
        showToast('送出失敗：' + err.message, 'error');
    } finally {
        btn.disabled    = false;
        btn.textContent = '點餐';
    }
}

// ============================================================
// 今日訂單列表
// ============================================================

/**
 * 讀取 Orders 工作表並過濾出今日訂單，渲染為表格
 * 今日判斷：訂單時間欄位以今天的日期字串開頭
 */
async function loadTodayOrders() {
    const ordersDiv = document.getElementById('orders-list');
    ordersDiv.innerHTML = '<p class="loading">載入訂單中…</p>';

    try {
        const rows  = await sheetsGet('Orders', 'A:F');
        const today = getTodayString();   // 格式：YYYY/MM/DD

        // 跳過標題列，篩選今天的資料
        // 用數字比對年/月/日，避免 Sheets 讀回時去掉補零（4/18 vs 04/18）導致比對失敗
        const now = new Date();
        const todayOrders = rows.slice(1).filter(function (row) {
            if (!row[0]) return false;
            const datePart = row[0].toString().split(' ')[0];
            const parts = datePart.split('/');
            if (parts.length < 3) return false;
            return parseInt(parts[0], 10) === now.getFullYear() &&
                   parseInt(parts[1], 10) === (now.getMonth() + 1) &&
                   parseInt(parts[2], 10) === now.getDate();
        });

        todayOrdersCache = todayOrders;  // 快取供複製使用

        if (todayOrders.length === 0) {
            ordersDiv.innerHTML = '<p class="empty-hint">今日尚無訂單。</p>';
            return;
        }

        // 建立表格
        const table  = document.createElement('table');
        table.className = 'orders-table';

        const thead = document.createElement('thead');
        thead.innerHTML =
            '<tr>' +
                '<th>時間</th>' +
                '<th>訂購人</th>' +
                '<th>餐廳</th>' +
                '<th>餐點</th>' +
                '<th>金額</th>' +
                '<th>備註</th>' +
            '</tr>';
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        todayOrders.forEach(function (row) {
            // 時間欄只顯示 HH:MM（去除日期部分）
            const timeStr = row[0] ? (row[0].split(' ')[1] || row[0]) : '';
            const tr = document.createElement('tr');
            tr.innerHTML =
                '<td>' + escapeHtml(timeStr)        + '</td>' +
                '<td>' + escapeHtml(row[1] || '')   + '</td>' +
                '<td>' + escapeHtml(row[2] || '')   + '</td>' +
                '<td>' + escapeHtml(row[3] || '')   + '</td>' +
                '<td>$' + escapeHtml(row[4] || '0') + '</td>' +
                '<td>' + escapeHtml(row[5] || '')   + '</td>';
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        ordersDiv.innerHTML = '';
        ordersDiv.appendChild(table);
    } catch (err) {
        console.error('[載入訂單失敗]', err);
        ordersDiv.innerHTML = '<p class="error-hint">載入訂單失敗：' + err.message + '</p>';
    }
}

/**
 * 將今日訂單格式化為純文字後複製到剪貼簿
 * 格式適合貼入 LINE 或其他通訊軟體
 */
function copyOrders() {
    if (!todayOrdersCache || todayOrdersCache.length === 0) {
        showToast('目前沒有可複製的訂單，請先重新整理。', 'warning');
        return;
    }

    const today = getTodayString();
    const lines = ['📋 今日訂單（' + today + '）', '─────────────────────'];

    todayOrdersCache.forEach(function (row, idx) {
        const timeStr = row[0] ? (row[0].split(' ')[1] || row[0]) : '';
        const note    = row[5] ? '（備註：' + row[5] + '）' : '';
        lines.push(
            (idx + 1) + '. ' + (row[1] || '') +
            ' → ' + (row[2] || '') + ' ' + (row[3] || '') +
            '  $' + (row[4] || '0') + note
        );
    });

    // 計算今日合計金額
    const total = todayOrdersCache.reduce(function (sum, row) {
        return sum + (Number(row[4]) || 0);
    }, 0);

    lines.push('─────────────────────');
    lines.push('合計：$' + total);

    const text = lines.join('\n');

    // 優先使用現代 Clipboard API，fallback 至舊版 execCommand
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text)
            .then(function ()  { showToast('已複製到剪貼簿！', 'success'); })
            .catch(function () { fallbackCopy(text); });
    } else {
        fallbackCopy(text);
    }
}

/** execCommand fallback（用於舊瀏覽器或非 HTTPS 環境） */
function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
        document.execCommand('copy');
        showToast('已複製到剪貼簿！', 'success');
    } catch (e) {
        showToast('複製失敗，請手動選取文字。', 'error');
    }
    document.body.removeChild(ta);
}

// ============================================================
// 管理員：清空今日訂單
// ============================================================

/**
 * 彈出系統確認對話框，確認後清空 Orders 表第二列以後的所有資料
 * 標題列（第一列）將被保留
 */
async function confirmClearOrders() {
    const ok = window.confirm(
        '確定要清空今日所有點餐記錄嗎？\n\n' +
        '此操作將刪除 Orders 工作表中的所有訂單（標題列除外），且無法復原。'
    );
    if (!ok) return;

    try {
        showToast('清空中…', 'info');
        await sheetsClear('Orders', 'A2:F10000');
        todayOrdersCache = [];
        showToast('已清空今日點餐記錄', 'success');
        await loadTodayOrders();
    } catch (err) {
        console.error('[清空訂單失敗]', err);
        showToast('清空失敗：' + err.message, 'error');
    }
}

// ============================================================
// 登出
// ============================================================

/**
 * 撤銷 Access Token 並將頁面重置回登入畫面
 */
function signOut() {
    if (accessToken) {
        google.accounts.oauth2.revoke(accessToken, function () {
            console.log('[GIS] Token 已撤銷');
        });
        accessToken = null;
    }

    currentUser       = { email: '', name: '', role: '' };
    todayOrdersCache  = [];

    // 隱藏管理員專區（下次登入若非管理員則不顯示）
    document.getElementById('admin-config').classList.add('hidden');
    document.getElementById('admin-clear').classList.add('hidden');
    document.getElementById('menu-container').innerHTML    = '';
    document.getElementById('orders-list').innerHTML       = '';
    document.getElementById('restaurant-checkboxes').innerHTML = '';

    showScreen('login-screen');
}

// ============================================================
// UI 輔助函式
// ============================================================

/**
 * 切換顯示的畫面（一次只顯示一個 screen）
 * @param {string} targetId - 要顯示的元素 ID
 */
function showScreen(targetId) {
    ['login-screen', 'unauthorized-screen', 'main-screen'].forEach(function (id) {
        const el = document.getElementById(id);
        if (id === targetId) {
            el.classList.remove('hidden');
        } else {
            el.classList.add('hidden');
        }
    });
}

/**
 * 顯示頁面底部的 Toast 通知，3 秒後自動消失
 * @param {string} message - 顯示訊息
 * @param {'success'|'error'|'warning'|'info'} type - 通知類型
 */
function showToast(message, type) {
    type = type || 'info';
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className   = 'toast toast-' + type;   // 移除 hidden 並套用顏色
    toast.classList.remove('hidden');

    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(function () {
        toast.classList.add('hidden');
    }, 3000);
}

/**
 * 取得今天的日期字串，格式：YYYY/MM/DD
 * 此格式與 Orders 工作表中的時間欄位前綴相符
 */
function getTodayString() {
    const now = new Date();
    const y   = now.getFullYear();
    const m   = String(now.getMonth() + 1).padStart(2, '0');
    const d   = String(now.getDate()).padStart(2, '0');
    return y + '/' + m + '/' + d;
}

/**
 * 將 Date 物件格式化為試算表使用的時間字串
 * 格式：YYYY/MM/DD HH:MM
 * @param {Date} date
 * @returns {string}
 */
function formatTimestamp(date) {
    const y  = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const d  = String(date.getDate()).padStart(2, '0');
    const h  = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    return y + '/' + mo + '/' + d + ' ' + h + ':' + mi;
}

/**
 * 防止 XSS：將字串中的 HTML 特殊字元轉為 HTML 實體
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
