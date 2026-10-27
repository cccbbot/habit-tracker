// 人生回报率习惯追踪 — 前端逻辑（Supabase Auth + 存储）
(function () {
  "use strict";

  const CFG = window.APP_CONFIG || {};
  const URL = CFG.url;
  const ANON = CFG.anonKey;
  const CONFIGURED = ANON && ANON !== "REPLACE_WITH_YOUR_ANON_KEY";

  const REPORT_DAYS = 30;
  const CADENCE_LABEL = {
    daily: "每日", weekly: "每周", monthly: "每月", quarterly: "每季",
    yearly: "每年", longterm: "长期", once: "一次性", asneeded: "按需",
  };
  // 30天窗口内“应完成次数”映射（长期/一次性/按需不计入完成率分母）
  const RATE_CADENCES = new Set(["daily", "weekly", "monthly", "quarterly", "yearly"]);

  const state = {
    habits: [],
    checkins: [],
    date: todayISO(),
    view: "today",
    charts: {},
  };

  let UID = null;            // 登录后 = auth.uid()；未登录为 null
  let client = null;
  function ensureClient() {
    if (!CONFIGURED) return null;
    if (!client) client = window.supabase.createClient(URL, ANON);
    return client;
  }

  // ---------- 工具 ----------
  function todayISO() { return new Date().toISOString().slice(0, 10); }
  function $(id) { return document.getElementById(id); }

  function showBanner(html) { const b = $("banner"); b.innerHTML = html; b.classList.remove("hidden"); }
  function hideBanner() { $("banner").classList.add("hidden"); }
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
    clearTimeout(t._t); t._t = setTimeout(() => t.classList.add("hidden"), 2000);
  }
  function showAuth() {
    $("authScreen").classList.remove("hidden");
    document.querySelector(".topbar").classList.add("hidden");
    document.querySelector("main").classList.add("hidden");
  }
  function showApp() {
    $("authScreen").classList.add("hidden");
    document.querySelector(".topbar").classList.remove("hidden");
    document.querySelector("main").classList.remove("hidden");
    const u = client.auth.getUser ? null : null;
    $("userEmail").textContent = sessionEmail || "";
  }
  let sessionEmail = "";

  // ---------- 认证 ----------
  async function handleAuth(mode) {
    const email = $("email").value.trim();
    const password = $("password").value;
    const msg = $("authMsg");
    msg.textContent = ""; msg.className = "auth-msg";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.textContent = "请输入有效邮箱"; return; }
    if (password.length < 6) { msg.textContent = "密码至少 6 位"; return; }
    try {
      let res;
      if (mode === "signin") res = await client.auth.signInWithPassword({ email, password });
      else res = await client.auth.signUp({ email, password });
      if (res.error) { msg.textContent = res.error.message; return; }
      if (!res.data.session) {
        msg.textContent = "注册成功！若已开启邮箱验证，请查收验证邮件后登录。";
        msg.className = "auth-msg ok";
        return;
      }
      // 登录/注册成功，onAuthStateChange 会接管 UI
    } catch (e) {
      msg.textContent = e.message || String(e);
    }
  }

  async function signOut() {
    await client.auth.signOut();
    UID = null; showAuth();
  }

  // ---------- 数据层 ----------
  async function loadHabits() {
    const { data, error } = await client.from("roi_habits").select("*").order("sort_order", { ascending: true });
    if (error) throw error;
    return data || [];
  }
  async function loadCheckins() {
    const { data, error } = await client.from("roi_checkins").select("habit_id, check_date").eq("user_id", UID);
    if (error) throw error;
    return data || [];
  }

  async function toggleCheckin(habitId, date) {
    const exists = state.checkins.some(c => c.habit_id === habitId && c.check_date === date);
    if (exists) {
      const { error } = await client.from("roi_checkins")
        .delete().eq("user_id", UID).eq("habit_id", habitId).eq("check_date", date);
      if (error) throw error;
      state.checkins = state.checkins.filter(c => !(c.habit_id === habitId && c.check_date === date));
    } else {
      const { error } = await client.from("roi_checkins")
        .insert({ user_id: UID, habit_id: habitId, check_date: date });
      if (error) throw error;
      state.checkins.push({ habit_id: habitId, check_date: date });
    }
  }

  // ---------- 分析 ----------
  function expectedForCadence(cadence, days) {
    if (!RATE_CADENCES.has(cadence)) return 0;
    if (cadence === "daily") return days;
    if (cadence === "weekly") return Math.ceil(days / 7);
    if (cadence === "monthly") return Math.ceil(days / 30);
    if (cadence === "quarterly") return Math.ceil(days / 90);
    if (cadence === "yearly") return 1;
    return 0;
  }

  function computeStats() {
    const byHabit = {};
    state.checkins.forEach(c => { (byHabit[c.habit_id] = byHabit[c.habit_id] || new Set()).add(c.check_date); });
    const today = new Date(state.date + "T00:00:00");
    const windowStart = new Date(today); windowStart.setDate(today.getDate() - (REPORT_DAYS - 1));

    const habitStats = {};
    state.habits.forEach(h => {
      const days = byHabit[h.id] || new Set();
      const d30 = [...days].filter(d => { const dt = new Date(d + "T00:00:00"); return dt >= windowStart && dt <= today; });
      let streak = 0;
      if (h.cadence === "daily") {
        let cur = new Date(today);
        if (!days.has(cur.toISOString().slice(0, 10))) cur.setDate(cur.getDate() - 1);
        while (days.has(cur.toISOString().slice(0, 10))) { streak++; cur.setDate(cur.getDate() - 1); }
      }
      habitStats[h.id] = { total: days.size, d30: d30.length, streak, expected: expectedForCadence(h.cadence, REPORT_DAYS) };
    });

    const catAgg = {};
    state.habits.forEach(h => {
      const s = habitStats[h.id];
      const a = catAgg[h.category] = catAgg[h.category] || { done: 0, exp: 0, total: 0, d30: 0 };
      a.total += 1; a.d30 += s.d30;
      if (s.expected > 0) { a.done += Math.min(s.d30, s.expected); a.exp += s.expected; }
    });
    Object.values(catAgg).forEach(a => { a.rate = a.exp > 0 ? a.done / a.exp : null; });

    const total = state.habits.length;
    const dailyFrac = [];
    for (let i = 0; i < REPORT_DAYS; i++) {
      const d = new Date(windowStart); d.setDate(windowStart.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      const cnt = state.checkins.filter(c => c.check_date === iso).length;
      dailyFrac.push({ iso, frac: total ? cnt / total : 0, cnt });
    }
    const todayCnt = state.checkins.filter(c => c.check_date === state.date).length;
    return { habitStats, catAgg, dailyFrac, total, todayCnt };
  }

  // ---------- 渲染：今日打卡 ----------
  function renderToday() {
    const stats = computeStats();
    const pct = state.total ? Math.round((stats.todayCnt / state.total) * 100) : 0;
    $("todaySummary").innerHTML = `
      <div class="progress-wrap">
        <div class="progress-meta"><span>${state.date} 完成度</span><span>${stats.todayCnt} / ${state.total}（${pct}%）</span></div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      </div>`;

    const cats = {};
    state.habits.forEach(h => { (cats[h.category] = cats[h.category] || []).push(h); });
    const doneSet = new Set(state.checkins.filter(c => c.check_date === state.date).map(c => c.habit_id));

    const list = $("habitList"); list.innerHTML = "";
    Object.keys(cats).forEach(cat => {
      const block = document.createElement("div"); block.className = "cat-block";
      block.innerHTML = `<div class="cat-title">${cat}</div>`;
      const grid = document.createElement("div"); grid.className = "habit-grid";
      cats[cat].forEach(h => {
        const done = doneSet.has(h.id); const st = stats.habitStats[h.id];
        const el = document.createElement("button"); el.className = "habit" + (done ? " done" : "");
        el.innerHTML = `
          <div class="check">${done ? "✓" : ""}</div>
          <div class="info">
            <div class="name">${h.zh}<span class="cad-badge">${CADENCE_LABEL[h.cadence] || h.cadence}</span></div>
            <div class="src">${h.source || ""}</div>
            ${st.streak ? `<div class="streak">🔥 连续 ${st.streak} 天</div>` : ""}
          </div>`;
        el.addEventListener("click", () => onToggle(h.id, el));
        grid.appendChild(el);
      });
      block.appendChild(grid); list.appendChild(block);
    });
  }

  async function onToggle(habitId, el) {
    el.disabled = true;
    try {
      await toggleCheckin(habitId, state.date);
      renderToday();
      if (state.view === "report") renderReport();
      toast("已更新");
    } catch (e) { toast("操作失败：" + (e.message || e)); }
    finally { el.disabled = false; }
  }

  // ---------- 渲染：分析报告 ----------
  function renderReport() {
    const stats = computeStats();
    const catNames = Object.keys(stats.catAgg);
    const maxStreak = Math.max(0, ...state.habits.map(h => stats.habitStats[h.id].streak));
    const bestCat = catNames.filter(c => stats.catAgg[c].rate != null).sort((a, b) => stats.catAgg[b].rate - stats.catAgg[a].rate)[0];
    const worstCat = catNames.filter(c => stats.catAgg[c].rate != null).sort((a, b) => stats.catAgg[a].rate - stats.catAgg[b].rate)[0];
    $("reportCards").innerHTML = `
      <div class="card-box"><div class="num">${stats.todayCnt}/${state.total}</div><div class="lbl">今日完成</div></div>
      <div class="card-box"><div class="num">${stats.dailyFrac.reduce((s, d) => s + d.cnt, 0)}</div><div class="lbl">近30天总打卡</div></div>
      <div class="card-box"><div class="num">${maxStreak}</div><div class="lbl">最长连续(天)</div></div>
      <div class="card-box"><div class="num">${bestCat ? Math.round(stats.catAgg[bestCat].rate * 100) + "%" : "—"}</div><div class="lbl">最佳类别 ${bestCat || ""}</div></div>`;

    const ctx1 = $("catChart");
    if (state.charts.cat) state.charts.cat.destroy();
    state.charts.cat = new Chart(ctx1, {
      type: "bar",
      data: { labels: catNames, datasets: [{ label: "完成率", data: catNames.map(c => stats.catAgg[c].rate != null ? Math.round(stats.catAgg[c].rate * 100) : 0), backgroundColor: "#4a7dbe" }] },
      options: { scales: { y: { beginAtZero: true, max: 100, ticks: { callback: v => v + "%" } } }, plugins: { legend: { display: false } } },
    });

    const ctx2 = $("trendChart");
    if (state.charts.trend) state.charts.trend.destroy();
    state.charts.trend = new Chart(ctx2, {
      type: "line",
      data: { labels: stats.dailyFrac.map(d => d.iso.slice(5)), datasets: [{ label: "当日完成数", data: stats.dailyFrac.map(d => d.cnt), borderColor: "#2da44e", backgroundColor: "rgba(45,164,78,.15)", fill: true, tension: .3 }] },
      options: { scales: { y: { beginAtZero: true } }, plugins: { legend: { display: false } } },
    });

    const hm = $("heatmap"); hm.innerHTML = "";
    stats.dailyFrac.forEach(d => {
      const cell = document.createElement("div"); cell.className = "cell";
      cell.classList.add("lv" + Math.min(4, Math.floor(d.frac * 5)));
      cell.title = `${d.iso}：完成 ${d.cnt} 项（${Math.round(d.frac * 100)}%）`;
      hm.appendChild(cell);
    });

    const zeroDaily = state.habits.filter(h => h.cadence === "daily" && stats.habitStats[h.id].streak === 0 && stats.habitStats[h.id].d30 === 0).map(h => h.zh);
    const lines = [
      `【近${REPORT_DAYS}天习惯分析报告 · ${state.date}】`,
      `• 总打卡 ${stats.dailyFrac.reduce((s, d) => s + d.cnt, 0)} 次，今日完成 ${stats.todayCnt}/${state.total} 项。`,
      `• 最佳类别：${bestCat || "—"}（完成率 ${bestCat ? Math.round(stats.catAgg[bestCat].rate * 100) : 0}%）。`,
      `• 待加强类别：${worstCat || "—"}（完成率 ${worstCat ? Math.round(stats.catAgg[worstCat].rate * 100) : 0}%）。`,
      `• 最长连续打卡：${maxStreak} 天。`,
    ];
    if (zeroDaily.length) lines.push(`• ⚠️ 近30天从未完成的每日习惯（建议从1-2项起步）：${zeroDaily.join("、")}。`);
    else lines.push(`• 全部每日习惯均已启动，保持节奏即可。`);
    lines.push(`• 建议：每日先稳定 3-5 项（如 运动、睡前复盘、5秒法则），再逐步扩展。`);
    $("reportText").textContent = lines.join("\n");
  }

  // ---------- 视图切换 ----------
  function switchView(v) {
    state.view = v;
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.view === v));
    $("view-today").classList.toggle("hidden", v !== "today");
    $("view-report").classList.toggle("hidden", v !== "report");
    if (v === "report") renderReport();
  }

  // ---------- 初始化 ----------
  function wireUI() {
    document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => switchView(t.dataset.view)));
    $("datePicker").addEventListener("change", e => { state.date = e.target.value || todayISO(); renderToday(); if (state.view === "report") renderReport(); });
    $("refreshBtn").addEventListener("click", () => bootstrap());
    $("signOutBtn").addEventListener("click", signOut);
    // 认证 UI
    document.querySelectorAll(".auth-tab").forEach(b => b.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab").forEach(x => x.classList.toggle("active", x === b));
      $("authSubmit").textContent = b.dataset.mode === "signin" ? "登录" : "注册";
      $("authMsg").textContent = "";
    }));
    $("authSubmit").addEventListener("click", () => {
      const mode = document.querySelector(".auth-tab.active").dataset.mode;
      handleAuth(mode);
    });
  }

  async function init() {
    if (!CONFIGURED) {
      showBanner('⚠️ 尚未配置 Supabase anon key。请打开 <code>config.js</code>，把 <code>anonKey</code> 替换为项目 Settings → API 中的 anon public key，然后刷新页面。');
      return;
    }
    ensureClient();
    wireUI();
    $("datePicker").value = state.date;

    // 监听登录状态变化（登录/注册/退出自动接管 UI 与数据）
    client.auth.onAuthStateChange((_event, session) => {
      if (session && session.user) {
        UID = session.user.id;
        sessionEmail = session.user.email || "";
        showApp();
        bootstrap();
      } else {
        UID = null; sessionEmail = "";
        showAuth();
      }
    });

    const { data } = await client.auth.getSession();
    if (data.session && data.session.user) {
      UID = data.session.user.id;
      sessionEmail = data.session.user.email || "";
      showApp();
      await bootstrap();
    } else {
      showAuth();
    }
  }

  async function bootstrap() {
    if (!UID) return;
    try {
      const [habits, checkins] = await Promise.all([loadHabits(), loadCheckins()]);
      state.habits = habits; state.checkins = checkins;
      renderToday();
      if (state.view === "report") renderReport();
      hideBanner();
    } catch (e) {
      showBanner("⚠️ 数据加载失败：" + (e.message || e) + "。请检查网络、anon key 与 RLS 策略。");
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
