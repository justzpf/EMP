/**
 * 每日领 VIP - EchoMusic 插件
 *
 * 复刻内置的「每日权益」逻辑：
 *   1. 用服务器时间（北京时间）算出今天日期
 *   2. GET /youth/day/vip        领取畅听会员（TVIP）
 *   3. GET /youth/day/vip/upgrade 升级概念会员（SVIP，297002 视为已升级）
 *   4. GET /youth/month/vip/record 判断今日是否已领取，避免重复请求
 *   5. GET /user/vip/detail       读取当前生效的会员及到期时间
 *
 * 「今日已完成」判定用服务端真值（不依赖本地持久化，跨客户端/重启可靠）：
 *   今日已领畅听（领取记录 API）且 概念会员当前生效（/user/vip/detail 的 busi_vip svip）。
 *   注：无纯只读 API 能直接回答「今日是否已升级概念会员」，故以「当前生效」近似；
 *   若早已有概念会员，再调升级接口也只会返回 297002，无收益。
 */

const SETTINGS_KEY = "settings";

const DEFAULTS = {
  auto: true, // 开启自动领取
  intervalHours: 1, // 自动检查间隔（小时）
};

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const BOOT_RETRY = 10; // 启动时探测登录态的重试次数
const BOOT_RETRY_DELAY = 2500; // 每次重试间隔（ms）
const MAX_UPGRADE_FAILS = 3; // 当日升级失败达到此次数后，当天不再重试（无资格账号防刷）

// ---------- 具名常量（替代魔法数字） ----------
const STATUS_OK = 1; // 酷狗业务 status 成功
const VIP_ACTIVE = 1; // 会员生效标志（is_vip）
const CODE_ALREADY_CLAIMED = 297002; // "今日已领取过 / 已升级过"错误码
const CODE_LOGIN_EXPIRED = 20018; // 登录已过期错误码
const CODE_NEED_VERIFY = 20028; // 需要安全验证错误码
const TS_SECOND_BOUND = 1e12; // 时间戳阈值：大于此值视为毫秒，否则视为秒
const VIP_TYPE_TVIP = "tvip"; // 畅听会员产品类型
const VIP_TYPE_SVIP = "svip"; // 概念会员产品类型
const INTERVAL_MIN_HOURS = 0.5; // 自动检查间隔下限（小时）
const INTERVAL_MAX_HOURS = 24; // 自动检查间隔上限（小时）
const RETRY_GAP_MINUTES = 5; // 失败后自动重试最小间隔（分钟，内置固定值）
const HISTORY_MAX = 8; // 设置面板最多展示的历史条数

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toBeijingDate = (ms) => new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 10);

const localBeijingDate = () => toBeijingDate(Date.now());

const asArray = (value) => (Array.isArray(value) ? value : []);

/** 酷狗业务是否成功：status === STATUS_OK */
const isStatusOk = (res) => Number(res && res.status) === STATUS_OK;

/** 兼容 { data } / { body } / 平铺三种响应形态 */
const pickData = (res) => {
  if (!res || typeof res !== "object") return null;
  if (res.data && typeof res.data === "object") return res.data;
  if (res.body && typeof res.body === "object") return res.body;
  return res;
};

const findActiveVip = (vipInfo, productType) => {
  const list = asArray(vipInfo && vipInfo.busi_vip);
  const hit = list.find(
    (item) => item && item.product_type === productType && Number(item.is_vip) === VIP_ACTIVE,
  );
  return hit || null;
};

const toTimestamp = (value) => {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number") return value > TS_SECOND_BOUND ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatVipExpire = (vip) => {
  const ms = toTimestamp(vip && vip.vip_end_time);
  return ms ? toBeijingDate(ms) : "";
};

/** 会员剩余天数（向上取整，最低 0；无有效到期时间返回 0） */
const daysLeft = (vip) => {
  const ms = toTimestamp(vip && vip.vip_end_time);
  if (!ms) return 0;
  return Math.max(0, Math.ceil((ms - Date.now()) / 86400000));
};

const formatTime = (ts) =>
  ts ? new Date(ts).toLocaleString("zh-CN", { hour12: false }) : "尚未执行";

/** 日期比较，兼容 "2026-09-25" 与 20260925 两种格式 */
const isSameDay = (value, today) => {
  if (value === undefined || value === null) return false;
  return String(value).replace(/\D/g, "") === String(today).replace(/\D/g, "");
};

/** 常见酷狗错误码 → 中文可读文案 */
const ERROR_CODE_TEXT = {
  [CODE_LOGIN_EXPIRED]: "登录已过期，请重新登录",
  [CODE_NEED_VERIFY]: "需要安全验证",
  [CODE_ALREADY_CLAIMED]: "今日已领取过",
};

/** 把接口错误码 / 错误信息转成可读文案 */
const describeError = (res, fallback) => {
  if (!res || typeof res !== "object") return fallback;
  const data = pickData(res) || {};
  const code = Number(res.error_code ?? res.errorCode ?? data.error_code ?? data.errorCode ?? 0);
  if (ERROR_CODE_TEXT[code]) return ERROR_CODE_TEXT[code];
  const message = res.error_msg ?? res.msg ?? data.error_msg ?? data.msg;
  if (message) return String(message);
  if (code) return `错误码 ${code}`;
  return fallback;
};

// 插件自身图标（与根目录 icon.svg 保持一致）：设置面板概览卡左侧展示。
// 为何内嵌为 data: URL：宿主未向插件渲染层暴露自身 icon URL，data: 最稳妥、不依赖宿主内部 API。
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <defs><linearGradient id="vipGrad" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#ffe08a"/><stop offset="0.55" stop-color="#ffc94d"/><stop offset="1" stop-color="#ff9d2e"/>
  </linearGradient></defs>
  <rect x="2" y="2" width="44" height="44" rx="12" fill="url(#vipGrad)"/>
  <path d="M9.5 28.5 L11.5 14.5 L19.5 20.5 L24 11.5 L28.5 20.5 L36.5 14.5 L38.5 28.5 Z" fill="#fff"/>
  <rect x="9.5" y="28.5" width="29" height="3.5" rx="1.75" fill="#fff"/>
  <circle cx="11.5" cy="13.5" r="1.8" fill="#fff"/><circle cx="24" cy="10.5" r="2" fill="#fff"/><circle cx="36.5" cy="13.5" r="1.8" fill="#fff"/>
  <text x="24" y="42.5" font-family="Arial, Helvetica, sans-serif" font-size="10.5" font-weight="900" fill="#fff" text-anchor="middle" letter-spacing="0.5">VIP</text>
</svg>`;
const ICON_URL = `data:image/svg+xml,${encodeURIComponent(ICON_SVG)}`;

// ---------- 设置面板样式（参考 music-downloader 视觉语言） ----------
// ⚠️ 实测（music-downloader）：manifest style.css 的 class 选择器在宿主设置面板作用域内不生效，
// 必须经 ctx.css.inject 运行时全局注入。kvip- 前缀隔离宿主；色值一律 var(--宿主, 兜底)。
const SETTINGS_CSS = `
.kvip-settings { display: grid; gap: 14px; min-width: 0; color: var(--color-text-main, var(--text-main, #1d1d1f)); }
.kvip-settings__overview { display: grid; grid-template-columns: 52px minmax(0, 1fr) auto; align-items: center; gap: 14px; border: 1px solid var(--border-subtle, rgba(127,127,127,0.16)); border-radius: 16px; background: var(--color-bg-elevated, var(--surface-card-base, #fff)); padding: 14px; box-shadow: 0 2px 12px color-mix(in srgb, var(--color-text-main, #1d1d1f) 3%, transparent); }
.kvip-settings__mark { width: 48px; height: 48px; display: block; }
.kvip-settings__copy { display: grid; gap: 2px; min-width: 0; }
.kvip-settings__copy h3 { margin: 0; font-size: 13px; font-weight: 700; color: var(--color-text-main, var(--text-main, #1d1d1f)); }
.kvip-settings__copy p { margin: 0; font-size: 12px; color: var(--color-text-secondary, var(--text-secondary, #6b7280)); }
.kvip-settings__pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--control-border, rgba(127,127,127,0.24)); background: var(--control-muted-bg, rgba(127,127,127,0.08)); font-size: 11px; font-weight: 650; color: var(--color-text-secondary, var(--text-secondary, #6b7280)); white-space: nowrap; }
.kvip-settings__pill i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.kvip-settings__pill.is-done { color: #10b981; background: color-mix(in srgb, #10b981 12%, transparent); border-color: color-mix(in srgb, #10b981 30%, transparent); }
.kvip-settings__panel { display: grid; border: 1px solid var(--border-subtle, rgba(127,127,127,0.16)); border-radius: 16px; overflow: hidden; background: var(--color-bg-elevated, var(--surface-card-base, #fff)); box-shadow: 0 2px 12px color-mix(in srgb, var(--color-text-main, #1d1d1f) 3%, transparent); }
.kvip-settings__section-heading { display: grid; gap: 3px; padding: 15px 18px 12px; }
.kvip-settings__section-heading h3 { margin: 0; font-size: 13px; font-weight: 700; color: var(--color-text-main, var(--text-main, #1d1d1f)); }
.kvip-settings__section-heading p { margin: 0; font-size: 12px; color: var(--color-text-secondary, var(--text-secondary, #6b7280)); }
.kvip-settings__section-body { display: grid; min-width: 0; }
.kvip-settings__field { display: grid; grid-template-columns: minmax(0, 1fr) minmax(200px, 250px); align-items: center; gap: 24px; min-width: 0; min-height: 58px; padding: 10px 18px; }
.kvip-settings__field--switch { grid-template-columns: minmax(0, 1fr) auto; }
.kvip-settings__field--info { grid-template-columns: minmax(0, 1fr); min-height: 0; padding: 6px 18px; }
.kvip-settings__field + .kvip-settings__field { border-top: 1px solid color-mix(in srgb, var(--color-text-main, #1d1d1f) 12%, transparent); }
.kvip-settings__field-copy { display: grid; gap: 2px; min-width: 0; }
.kvip-settings__field-copy strong { font-size: 13px; font-weight: 650; color: var(--color-text-main, var(--text-main, #1d1d1f)); }
.kvip-settings__field-copy small { font-size: 12px; color: var(--color-text-secondary, var(--text-secondary, #6b7280)); overflow-wrap: anywhere; }
.kvip-settings__select { width: 100%; min-width: 0; justify-content: space-between; }
.kvip-settings__actions { display: flex; gap: 8px; justify-content: flex-end; }
`;

let cssDispose = null; // 注入返回的 dispose；deactivate/ctx.dispose 时手动调用

/** 注入设置面板样式：重入守卫防重复注入；宿主不支持 ctx.css 则静默。 */
function injectSettingsCss(ctx) {
  if (cssDispose) return;
  try {
    if (typeof ctx.css?.inject !== "function") return;
    cssDispose = ctx.css.inject(SETTINGS_CSS);
  } catch (error) {
    console.error("[kugou-vip] 设置面板样式注入失败:", error);
  }
}

/** 卸载注入样式：宿主不保证自动清理，需手动 dispose（幂等）。 */
function disposeCss() {
  if (typeof cssDispose === "function") {
    try { cssDispose(); } catch (error) { /* 忽略 */ }
    cssDispose = null;
  }
}

export function activate(ctx) {
  const { defineAsyncComponent, defineComponent, h, reactive, computed } = ctx.vue;
  const Button = defineAsyncComponent(ctx.ui.components.Button);
  const Switch = defineAsyncComponent(ctx.ui.components.Switch);
  const Select = defineAsyncComponent(ctx.ui.components.Select);

  const state = reactive({
    auto: DEFAULTS.auto,
    intervalHours: DEFAULTS.intervalHours,
    loggedIn: false,
    probeReason: "", // 登录态探测失败的原始原因，便于排查
    running: false,
    today: "",
    claimedToday: false, // 今日是否已领取（来自领取记录 API）
    tvip: false, // 畅听会员当前是否生效
    svip: false, // 概念会员当前是否生效
    tvipExpire: "",
    svipExpire: "",
    tvipDays: 0, // 畅听会员剩余天数
    svipDays: 0, // 概念会员剩余天数
    nextCheckAt: 0,
    giveUpDate: "", // 今日升级放弃重试的日期（无资格防刷，仅限自动检查）
    upgradeFails: 0,
    lastAutoAttemptAt: 0,
  });

  const statusText = computed(() => {
    if (!state.loggedIn) return "未登录（请先登录 EchoMusic）";
    if (!state.today) return "获取中…";
    return `畅听会员 ${state.claimedToday ? "已领取" : "未领取"} / 概念会员 ${
      state.svip ? "已生效" : "未升级"
    }`;
  });

  const activeText = computed(() => {
    if (!state.loggedIn) return "";
    const parts = [];
    parts.push(
      state.tvip
        ? `畅听会员至 ${state.tvipExpire || "—"}（剩 ${state.tvipDays} 天）`
        : "畅听会员未生效",
    );
    parts.push(
      state.svip
        ? `概念会员至 ${state.svipExpire || "—"}（剩 ${state.svipDays} 天）`
        : "概念会员未生效",
    );
    return parts.join(" · ");
  });

  let timer = null;

  // ---------- 登录态探测 ----------

  /**
   * 插件 activate 可能早于 API 服务 / 登录态就绪，也可能拿到 503，
   * 这里做宽容判定：业务 status===1 即视为已登录，同时记录原始失败原因。
   */
  const probeLogin = async () => {
    try {
      const res = await ctx.kugou.user.getUserDetail();
      const status = Number(res && res.status);
      if (status === STATUS_OK) return { loggedIn: true, reason: "" };
      return { loggedIn: false, reason: describeError(res, `status=${status || "无"}`) };
    } catch (error) {
      return { loggedIn: false, reason: String((error && error.message) || error) };
    }
  };

  // ---------- 业务接口 ----------

  const getServerToday = async () => {
    try {
      const res = await ctx.kugou.user.getServerNow();
      const data = pickData(res) || {};
      const candidates = [
        data.now,
        data.time,
        data.timestamp,
        data.server_time,
        data.serverTime,
        data.data && data.data.now,
      ];
      for (const candidate of candidates) {
        const ts = toTimestamp(Number(candidate));
        if (ts > 0) return toBeijingDate(ts);
      }
    } catch (error) {
      // 忽略，走本地时间兜底
    }
    return localBeijingDate();
  };

  /** 今日是否已在领取记录中（接口异常时返回 null，表示未知） */
  const isClaimedToday = async (today) => {
    try {
      const res = await ctx.kugou.user.getVipMonthRecord();
      const data = pickData(res);
      const list = asArray(data && data.list !== undefined ? data.list : data);
      return list.some((item) => isSameDay(item && item.day, today));
    } catch (error) {
      return null;
    }
  };

  /** 读取当前生效的会员：优先 /user/vip/detail，回退 /user/detail 的 extendsInfo.vip */
  const refreshVipInfo = async () => {
    try {
      let vipInfo = null;

      try {
        const vipRes = await ctx.kugou.user.getUserVipDetail();
        if (isStatusOk(vipRes)) {
          const vipData = pickData(vipRes);
          if (vipData && (vipData.busi_vip || vipData.vip)) vipInfo = vipData.vip || vipData;
        }
      } catch (error) {
        // 回退到 user detail
      }

      if (!vipInfo) {
        const res = await ctx.kugou.user.getUserDetail();
        const data = pickData(res) || {};
        vipInfo = data.vip || (data.extendsInfo && data.extendsInfo.vip) || {};
      }

      const tvip = findActiveVip(vipInfo, VIP_TYPE_TVIP);
      const svip = findActiveVip(vipInfo, VIP_TYPE_SVIP);
      state.tvip = Boolean(tvip);
      state.svip = Boolean(svip);
      state.tvipExpire = formatVipExpire(tvip);
      state.svipExpire = formatVipExpire(svip);
      state.tvipDays = daysLeft(tvip);
      state.svipDays = daysLeft(svip);
    } catch (error) {
      // 刷新失败不阻塞领取
    }
  };

  const refreshAll = async () => {
    const probe = await probeLogin();
    state.loggedIn = probe.loggedIn;
    state.probeReason = probe.reason;
    if (!probe.loggedIn) {
      state.today = "";
      state.claimedToday = false;
      state.tvip = false;
      state.svip = false;
      state.tvipExpire = "";
      state.svipExpire = "";
      state.tvipDays = 0;
      state.svipDays = 0;
      return false;
    }
    state.today = await getServerToday();
    const claimed = await isClaimedToday(state.today);
    state.claimedToday = claimed === null ? state.claimedToday : claimed;
    await refreshVipInfo();
    return true;
  };

  // ---------- 领取流程 ----------

  const runClaim = async () => {
    if (state.running) return null;
    state.running = true;

    const result = { tvip: false, svip: false, already: false, error: "" };
    try {
      const probe = await probeLogin();
      state.loggedIn = probe.loggedIn;
      state.probeReason = probe.reason;
      if (!probe.loggedIn) {
        result.error = probe.reason
          ? `未登录或登录已过期（${probe.reason}）`
          : "未登录或登录已过期";
        return result;
      }

      const today = await getServerToday();
      state.today = today;

      // 已领过则直接走升级，避免重复请求；记录接口异常时照样尝试领取
      const claimed = await isClaimedToday(today);
      if (claimed === true) {
        result.already = true;
        result.tvip = true;
      } else {
        const claimRes = await ctx.kugou.user.claimDayVip(today);
        result.tvip = isStatusOk(claimRes);
        if (!result.tvip) {
          result.error = describeError(claimRes, "领取畅听会员失败");
        }
      }

      // 畅听会员到账后尝试升级概念会员
      if (result.tvip) {
        try {
          const upgradeRes = await ctx.kugou.user.upgradeDayVip();
          result.svip =
            isStatusOk(upgradeRes) ||
            // 297002：今日已升级过，视为成功（服务端每日限一次）
            Number(upgradeRes && upgradeRes.error_code) === CODE_ALREADY_CLAIMED;
          if (!result.svip && !result.error) {
            result.error = describeError(upgradeRes, "升级概念会员失败");
          }
        } catch (error) {
          if (!result.error) result.error = String((error && error.message) || error);
        }
      }

      state.claimedToday = result.already || result.tvip || state.claimedToday;
      await refreshVipInfo();
    } catch (error) {
      result.error = String((error && error.message) || error);
    } finally {
      state.running = false;

      // 无资格防刷：当日升级连续失败达上限后，自动检查当天不再重试升级。
      // 只影响自动检查（autoRun），不影响"立即领取"手动按钮与状态显示（后者看服务端真值）。
      if (result.tvip) {
        const today = localBeijingDate();
        if (state.giveUpDate !== today) {
          state.giveUpDate = today;
          state.upgradeFails = 0;
        }
        if (result.svip) state.upgradeFails = 0;
        else state.upgradeFails += 1;
        if (state.upgradeFails >= MAX_UPGRADE_FAILS) state.giveUpDate = today;
      }
    }

    return result;
  };

  // ---------- 定时器 ----------

  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
    state.nextCheckAt = 0;
  };

  const startTimer = () => {
    stopTimer();
    if (!state.auto) return;
    const hours = Math.min(INTERVAL_MAX_HOURS, Math.max(INTERVAL_MIN_HOURS, Number(state.intervalHours) || 1));
    const intervalMs = hours * 3600 * 1000;
    state.nextCheckAt = Date.now() + intervalMs;
    timer = setInterval(() => {
      void autoRun();
    }, intervalMs);
  };

  // ---------- 自动领取（带休眠判断） ----------

  /** 今日是否已完成：今日已领畅听（领取记录 API）且 概念会员当前生效（/user/vip/detail busi_vip svip）。
   *  服务端真值，跨客户端/重启可靠；无纯只读 API 能直接回答"今日已升级概念会员"，故以"当前生效"近似。 */
  const isDoneToday = () => state.claimedToday && state.svip;

  /** 今日是否已放弃升级重试（无资格防刷，仅限自动检查；手动"立即领取"不受限） */
  const isGiveUpToday = () => state.giveUpDate === localBeijingDate();

  /**
   * 定时器 / 播放事件共用的自动领取入口：
   * - 今日已完成 → 直接返回，零请求
   * - 今日已放弃升级重试（无资格）→ 直接返回，零请求
   * - 距上次自动尝试不足内置"失败重试间隔"（5 分钟）→ 跳过，避免连续切歌反复打接口
   */
  const autoRun = async () => {
    if (!state.auto || state.running) return;
    if (isDoneToday() || isGiveUpToday()) return;
    const now = Date.now();
    const gapMs = RETRY_GAP_MINUTES * 60 * 1000;
    if (now - state.lastAutoAttemptAt < gapMs) return;
    state.lastAutoAttemptAt = now;
    await runClaim();
  };

  // ---------- 设置持久化 ----------

  const persist = async () => {
    try {
      await ctx.storage.set(SETTINGS_KEY, {
        auto: state.auto,
        intervalHours: state.intervalHours,
      });
    } catch (error) {
      // 忽略存储失败
    }
  };

  const onAutoChange = async (value) => {
    state.auto = Boolean(value);
    await persist();
    startTimer();
    // 用户主动开启：忽略冷却间隔立即尝试一次（今日已完成的仍会休眠）
    state.lastAutoAttemptAt = 0;
    if (state.auto) void autoRun();
  };

  const onIntervalChange = async (value) => {
    state.intervalHours = Number(value) || DEFAULTS.intervalHours;
    await persist();
    startTimer();
  };

  // ---------- 设置面板（参考 music-downloader 视觉语言：概览卡 + 分组面板 + 字段行） ----------

  /** 概览卡状态胶囊：未登录/领取中/待领取（次级）；今日已完成（绿）。 */
  const statusPill = () => {
    if (!state.loggedIn) return { text: "未登录", cls: "" };
    if (state.running) return { text: "领取中…", cls: "" };
    if (isDoneToday()) return { text: "今日已完成", cls: "is-done" };
    return { text: "待领取", cls: "" };
  };

  const renderOverviewCard = (h) => {
    const pill = statusPill();
    return h("div", { class: "kvip-settings__overview" }, [
      h("img", { class: "kvip-settings__mark", src: ICON_URL, alt: "" }),
      h("div", { class: "kvip-settings__copy" }, [
        h("h3", "每日领 VIP"),
        h("p", "自动领取畅听会员并升级概念会员"),
      ]),
      h("span", { class: `kvip-settings__pill ${pill.cls}` }, [h("i"), pill.text]),
    ]);
  };

  const fieldCopy = (h, label, desc) =>
    h("div", { class: "kvip-settings__field-copy" }, [h("strong", label), h("small", desc)]);

  const renderSwitchField = (h, Switch, label, desc, modelValue, onUpdate) =>
    h("div", { class: "kvip-settings__field kvip-settings__field--switch" }, [
      fieldCopy(h, label, desc),
      h(Switch, { modelValue, "onUpdate:modelValue": onUpdate }),
    ]);

  const renderSelectField = (h, Select, label, desc, modelValue, options, onUpdate) =>
    h("div", { class: "kvip-settings__field" }, [
      fieldCopy(h, label, desc),
      h(Select, { class: "kvip-settings__select", modelValue, options, "onUpdate:modelValue": onUpdate }),
    ]);

  const renderInfoField = (h, label, value) =>
    h("div", { class: "kvip-settings__field kvip-settings__field--info" }, [fieldCopy(h, label, value)]);

  const renderPanel = (h, title, desc, fields) =>
    h("div", { class: "kvip-settings__panel" }, [
      h("div", { class: "kvip-settings__section-heading" }, [h("h3", title), h("p", desc)]),
      h("div", { class: "kvip-settings__section-body" }, fields),
    ]);

  /** 领取设置分组：自动领取开关 + 检查间隔选择 */
  const renderClaimPanel = (h, Switch, Select) =>
    renderPanel(h, "领取设置", "自动领取与检查间隔", [
      renderSwitchField(h, Switch, "自动领取", "每天自动领取畅听会员并升级概念会员", state.auto, onAutoChange),
      renderSelectField(
        h,
        Select,
        "检查间隔",
        "自动检查频率",
        state.intervalHours,
        [
          { label: "每 1 小时", value: 1 },
          { label: "每 2 小时", value: 2 },
          { label: "每 6 小时", value: 6 },
          { label: "每 12 小时", value: 12 },
        ],
        onIntervalChange,
      ),
    ]);

  /** 运行状态分组：信息行按 state 显隐 */
  const renderStatusPanel = (h) =>
    renderPanel(h, "运行状态", "今日领取与会员生效情况", [
      renderInfoField(h, "今日状态", statusText.value),
      state.loggedIn && activeText.value ? renderInfoField(h, "生效状态", activeText.value) : null,
      state.auto && state.nextCheckAt && !isDoneToday()
        ? renderInfoField(h, "下次检查", formatTime(state.nextCheckAt))
        : null,
      state.auto && isDoneToday()
        ? renderInfoField(h, "自动检查", "今日已领取完成，自动检查已休眠（零请求）")
        : null,
      !isDoneToday() && isGiveUpToday()
        ? renderInfoField(h, "升级重试", "今日已暂停（可能无升级资格），手动立即领取仍可重试")
        : null,
      !state.loggedIn && state.probeReason ? renderInfoField(h, "探测详情", state.probeReason) : null,
    ]);

  const renderActions = (h, Button) =>
    h("div", { class: "kvip-settings__actions" }, [
      h(
        Button,
        { variant: "outline", size: "xs", disabled: state.running, onClick: () => void refreshAll() },
        { default: () => "刷新状态" },
      ),
      h(
        Button,
        { size: "xs", disabled: state.running, onClick: () => void runClaim() },
        { default: () => (state.running ? "领取中…" : "立即领取") },
      ),
    ]);

  const renderSettingsView = (h, Switch, Select, Button) =>
    h("div", { class: "kvip-settings" }, [
      renderOverviewCard(h),
      renderClaimPanel(h, Switch, Select),
      renderStatusPanel(h),
      renderActions(h, Button),
    ]);

  const SettingsPanel = defineComponent({
    setup() {
      return () => renderSettingsView(h, Switch, Select, Button);
    },
  });

  ctx.ui.settings.define({
    title: "每日领 VIP",
    component: SettingsPanel,
  });

  // 播放触发：开软件后没赶上启动领取（如启动时接口未就绪）、或跨天首次播放时，立即补领
  let offTrackChange = null;
  if (ctx.events && typeof ctx.events.onTrackChange === "function") {
    offTrackChange =
      ctx.events.onTrackChange(() => {
        void autoRun();
      }) || null;
  }

  // ---------- 启动 ----------

  const loadSettings = async () => {
    try {
      const saved = await ctx.storage.get(SETTINGS_KEY);
      if (saved && typeof saved === "object") {
        if (typeof saved.auto === "boolean") state.auto = saved.auto;
        if (Number(saved.intervalHours) > 0) state.intervalHours = Number(saved.intervalHours);
      }
    } catch (error) {
      // 使用默认设置
    }
  };

  const boot = async () => {
    injectSettingsCss(ctx);
    await loadSettings();

    // 激活时机可能早于 API 服务 / 登录态就绪，重试探测而不是直接判未登录
    for (let attempt = 0; attempt < BOOT_RETRY; attempt += 1) {
      if (await refreshAll()) break;
      // 最后一次失败不再等待，直接进入定时器
      if (attempt < BOOT_RETRY - 1) await sleep(BOOT_RETRY_DELAY);
    }

    startTimer();
    if (state.auto && state.loggedIn) void runClaim();
  };

  void boot();

  ctx.dispose(() => {
    stopTimer();
    disposeCss();
    if (typeof offTrackChange === "function") offTrackChange();
  });
}

/** 可选清理钩子：样式注入的 dispose 需手动调用（宿主不保证自动清理） */
export function deactivate() {
  disposeCss();
}
