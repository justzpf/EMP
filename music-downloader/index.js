// ============================================================
// EchoMusic 音乐下载插件 — 单文件浏览器 ESM（宿主经 Blob URL 加载）
// 分区组织（单向依赖：UI挂点 → 编排 → 服务 → 基础设施）
// 硬约束：禁止 bare import / 相对 import；Vue 取自 ctx.vue；函数≤60行。
//
// manifest capabilities 兼容备选：若宿主拒绝"对象布尔"形式，
// 改为数组形式：
//   "capabilities": ["localFiles","downloads","kugouApi","kugouVerification"]
// （见设计文档 §5 契约风险，R3 实测项）
// ============================================================

// ============ §0 常量与工具 ============
const APP_ID = 'music-downloader';
const TASK_PREFIX = `${APP_ID}:`;
const SETTINGS_KEY = `${APP_ID}:settings`;
const DEFAULT_SETTINGS = { quality: '320', directoryId: null, conflict: 'rename', syncLyrics: true };
const QUALITY_OPTIONS = [
  { value: '128', label: '标准 128k' },
  { value: '320', label: '高品 320k' },
  { value: 'flac', label: '无损 FLAC' }
];
const CONFLICT_OPTIONS = [
  { value: 'fail', label: '重名时报错' },
  { value: 'rename', label: '自动改名' },
  { value: 'replace', label: '覆盖旧文件' }
];
// 质量回退链：首选质量失败后逐级降级（flac→320→128）
const QUALITY_FALLBACK_CHAIN = ['flac', '320', '128'];
// 设计文档 finish 状态用 'failed'（6.8）；宿主若用 'error' 见 markFailed 双态兼容
const FINISH_FAILED = 'failed';
const FINISH_ABORTED = 'aborted';
// 保守超时：酷狗签名直链短期有效，idle 过长易断（R4）
const DOWNLOAD_CONNECT_TIMEOUT = 15000;
const DOWNLOAD_IDLE_TIMEOUT = 30000;
const EXTRACT_DEPTH_MAX = 3; // extractUrl 深度上限；迭代栈实现天然无深度溢出
// 字节换算常量（formatBytes 具名化，禁魔法数）
const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1048576;
const BYTES_PER_GB = 1073741824;
// extractUrl 候选键：url 直链优先，data/result/records 为嵌套回退
const URL_KEYS = ['url', 'play_url', 'playUrl', 'downloadUrl', 'audio', 'data', 'result', 'records'];
// Windows 文件名非法字符与控制字符
const ILLEGAL_FILE_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
// Windows 保留设备名（加 "_" 前缀规避）
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// 歌词同步常量：写入通道 FileRef 对象形态（ADR-002 D8，走宿主资源 API 写授权目录）
const FILE_REF_KIND = 'directory-file';
// searchLyric duration 单位毫秒（宿主契约 D10：歌曲 duration（秒）×1000）
const MS_PER_SECOND = 1000;
const LYRICS_PROGRESS_LABEL = '正在下载歌词…';
// 歌词失败原因集中（设计 §5 错误表；调用方按 reason 决定静默跳过或提示）
const LRC_REASON = {
  disabled: 'disabled',
  noCandidates: 'no-candidates',
  noUsable: 'no-usable',
  emptyText: 'empty-text',
  verificationFailed: 'verification-failed',
  exists: 'exists',
  failed: 'failed'
};

let ctx = null; // 宿主上下文，activate 时注入

/** 深拷贝纯对象（storage 只存可克隆普通对象，禁 reactive/ref/函数/File/Error） */
function deepClone(obj) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(obj); } catch (e) { /* 回退 JSON */ }
  }
  return JSON.parse(JSON.stringify(obj));
}

/** 清理文件名：去 /\:*?"<>| 及控制字符、首尾空白、结尾点/空格；Windows 保留设备名加 "_" 前缀 */
function sanitizeFileName(name) {
  let s = String(name || '').replace(ILLEGAL_FILE_CHARS, '').trim();
  s = s.replace(/[. ]+$/, ''); // Windows 不允许文件名以点/空格结尾
  if (WINDOWS_RESERVED_NAME.test(s)) s = `_${s}`;
  return s;
}

/** 生成相对路径："歌手-歌名.ext"（紧凑，无空格，用户确认）；无歌手用"歌名.ext"；ext 为实际下载格式（来自 extractUrl）。
 *  防作者名重复：部分宿主曲目 title 已含 "作者 - 歌名"（如 "周杰伦 - 稻香"）或 "作者-歌名"，
 *  再拼会重复，故先剥离 title 里已带的作者前缀（两种分隔都处理，数据无关）。 */
function buildRelativePath(song, ext) {
  const artist = sanitizeFileName(artistOf(song));
  let title = sanitizeFileName(titleOf(song)) || 'untitled';
  if (artist) {
    const tight = `${artist}-`;
    const spaced = `${artist} - `;
    if (title.startsWith(tight)) title = title.slice(tight.length).trim() || title;
    else if (title.startsWith(spaced)) title = title.slice(spaced.length).trim() || title;
  }
  const base = artist ? `${artist}-${title}` : title;
  return `${base}.${ext || 'mp3'}`;
}

function titleOf(song) { return (song && (song.title || song.name || song.songname)) || '未命名'; }
function artistOf(song) { return (song && (song.artist || song.author || song.singer)) || ''; }

/** 秒 → 毫秒（searchLyric duration 单位毫秒 D10；无效/0 返回 0，调用方据此不传 duration） */
function durationSecondsToMs(sec) {
  const n = Number(sec);
  return isFinite(n) && n > 0 ? Math.round(n * MS_PER_SECOND) : 0;
}

/** 错误转可读文本 */
function errorMessage(err) {
  if (!err) return '未知错误';
  return err.message || err.msg || err.error || String(err);
}

/** 判断是否为取消/中止类错误（用户取消任务或 AbortError） */
function isAbortError(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return true;
  const msg = errorMessage(err).toLowerCase();
  return msg.includes('abort') || msg.includes('canceled') || msg.includes('cancelled');
}

/** 安全 toast：宿主 toast 不可用则静默，不阻断主流程 */
function toast(msg) {
  try { if (ctx && typeof ctx.toast === 'function') ctx.toast(msg); } catch (e) { /* 忽略 */ }
}

// ============ §1 存储（设置 + 目录授权） ============
const storageService = {
  /** 读设置：storage 合并 DEFAULT_SETTINGS；无值时返回默认副本（storage API 为异步 Promise） */
  async getSettings() {
    const saved = await safeStorageGet(SETTINGS_KEY);
    return Object.assign({}, DEFAULT_SETTINGS, saved || {});
  },
  /** 写设置：只写可克隆普通对象；禁写 reactive/ref/函数/File/Error */
  async saveSettings(patch) {
    const next = Object.assign({}, await this.getSettings(), deepClone(patch || {}));
    try { await ctx.storage.set(SETTINGS_KEY, next); } catch (e) { /* 存储失败不阻断 */ }
    return next;
  },
  async getDirectoryId() { return (await this.getSettings()).directoryId; },
  async setDirectoryId(id) { await this.saveSettings({ directoryId: id }); },
  async clearDirectoryId() { await this.saveSettings({ directoryId: null }); }
};

/** 异步读 storage 键；异常返回 null（读失败按无值处理） */
async function safeStorageGet(key) {
  try { return (await ctx.storage.get(key)) || null; } catch (e) { return null; }
}

// ============ §2 目录授权服务 ============
const directoryService = {
  /**
   * 确保有可用目录授权。优先级：settings.directoryId 且 listDirectoryGrants 可用 →
   * 否则 requestDirectory 重新授权。
   * 返回 { ok, directory, reason? }；ok=false 时调用方应提示并中止（不静默）。
   */
  async ensureDirectory() {
    const id = await storageService.getDirectoryId();
    if (id) {
      const grant = await findAvailableGrant(id);
      if (grant) return { ok: true, directory: grant };
    }
    try {
      const dir = await this.selectDirectory();
      return { ok: true, directory: dir };
    } catch (err) {
      return { ok: false, reason: reasonOfAuthError(err), directory: null, error: err };
    }
  },
  /** 手动重选目录：requestDirectory → 成功则持久化 id 并返回；失败抛错 */
  async selectDirectory() {
    if (!ctx.fs || typeof ctx.fs.requestDirectory !== 'function') {
      throw new Error('当前版本不支持目录授权（需 EchoMusic ≥2.3.2-beta.10）');
    }
    const res = await ctx.fs.requestDirectory({
      access: 'read-write',
      purpose: '保存下载的音乐',
      persist: true
    });
    // 用户取消：宿主返回 {canceled:true}（不抛错）→ 统一抛含 cancel 的错误供 reasonOfAuthError 识别
    if (res && res.canceled) throw new Error('canceled by user');
    // 兼容返回 {id} 或 {directory:{id}} 两种形态
    const ref = (res && res.directory) || res;
    if (!ref || !ref.id) throw new Error('目录授权返回无效');
    await storageService.setDirectoryId(ref.id);
    return ref;
  },
  /** 撤销本地记忆：不主动调宿主 revoke，授权由宿主管理 */
  async forgetDirectory() { await storageService.clearDirectoryId(); }
};

/** 在 listDirectoryGrants 结果中查找仍可用的授权 */
async function findAvailableGrant(id) {
  try {
    if (!ctx.fs.listDirectoryGrants) return null;
    const raw = await ctx.fs.listDirectoryGrants();
    const grants = toGrantList(raw);
    return grants.find((g) => g && g.id === id && g.available !== false) || null;
  } catch (e) { return null; }
}

/** 兼容 listDirectoryGrants 返回 {grants:[]}/{directories:[]}/[] 形态 */
function toGrantList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.grants)) return raw.grants;
  if (raw && Array.isArray(raw.directories)) return raw.directories;
  return [];
}

function reasonOfAuthError(err) {
  const msg = errorMessage(err).toLowerCase();
  return msg.includes('cancel') ? 'canceled' : 'denied';
}

function describeDirRef(d) {
  return (d && (d.displayPath || d.path || d.name)) || '已授权';
}

// ============ §3 音源解析服务 ============
const sourceService = {
  /**
   * 解析酷狗直链。策略（ADR-003 修订 D3）：先 getSongUrl(qualityHash, quality)，
   * 抛错或空 url → 回退 getSongUrl(hash, '')（基 hash + 空串）。quality 为软偏好。
   * 返回 { ok, url, ext, resolvedQuality, sourceKey, error? }。
   */
  async resolveSongUrl(song, quality) {
    const hash = (song && song.hash) || '';
    if (!hash) return { ok: false, error: '歌曲缺少 hash' };

    // 为什么用质量专属 hash：宿主播放器按 relateGoods[].hash（每质量独立）请求，
    // 只传基 hash 会拿服务端默认质量，quality 变次级提示。本逻辑镜像宿主 doesRelateGoodMatchQuality（ADR-003）。
    const qualityHash = this.resolveQualityHash(song, quality);

    let result = null;
    let gotQuality = true;
    try {
      result = await this.fetchWithQuality(qualityHash, quality);
    } catch (err) {
      gotQuality = false; // 带 quality 失败 → 回退基 hash + 空串
    }
    if (!result || !this.extractUrl(result).url) {
      gotQuality = false;
      try {
        // 为什么传 '' 而非 null：宿主 getSongUrl 默认 '' 只对 undefined 生效（ADR-003 次因）
        result = await this.fetchWithQuality(hash, '');
      } catch (err) {
        return { ok: false, error: errorMessage(err) || '解析音源失败' };
      }
    }

    const extracted = this.extractUrl(result);
    if (!extracted.url) return { ok: false, error: '未解析到下载地址' };
    const resolvedQuality = gotQuality && quality ? quality : (extracted.quality || 'unknown');
    return {
      ok: true,
      url: extracted.url,
      ext: extracted.ext,
      resolvedQuality,
      sourceKey: `kugou:${hash}:${resolvedQuality}`
    };
  },

  /**
   * 从 relateGoods 解析质量专属 hash（镜像宿主 doesRelateGoodMatchQuality）：
   * 匹配质量档（128/320/flac）对应的 relateGoods 项取 .hash；无匹配或无 relateGoods → 基 hash。
   * 为什么：宿主播放器每质量有独立 hash，质量请求必须用专属 hash 才能命中服务端对应音质。
   */
  resolveQualityHash(song, quality) {
    const norm = String(quality || '').toLowerCase();
    const goods = (song && song.relateGoods) || [];
    const match = goods.find((g) => {
      const gq = g && g.quality ? String(g.quality).toLowerCase() : '';
      const level = g && g.level;
      if (norm === '128') return gq === '128' || level === 1 || level === 2;
      if (norm === '320') return gq === '320' || gq === 'hq' || level === 4;
      if (norm === 'flac') return gq === 'flac' || gq === 'sq' || level === 5;
      return gq === norm; // high/viper_* 等质量名透传
    });
    return (match && match.hash) || (song && song.hash) || '';
  },

  /** 单次拉取 + 验证码重试：遇 ssaCode/eventId（异常或返回体）→ 交宿主验证后重试一次 */
  async fetchWithQuality(hash, qualityArg) {
    let result;
    try {
      result = await ctx.kugou.music.getSongUrl(hash, qualityArg);
    } catch (err) {
      if (errorGuard.isVerificationError(err)) {
        return errorGuard.retryAfterVerification(
          () => ctx.kugou.music.getSongUrl(hash, qualityArg),
          errorGuard.eventIdOf(err)
        );
      }
      throw err;
    }
    if (errorGuard.isVerificationError(result)) {
      return errorGuard.retryAfterVerification(
        () => ctx.kugou.music.getSongUrl(hash, qualityArg),
        errorGuard.eventIdOf(result)
      );
    }
    return result;
  },

  /** 健壮提取直链：遍历 data.url / url / play_url / playUrl 等常见嵌套，取首个 http(s) 字符串 */
  extractUrl(payload) {
    const url = this.pickUrl(payload);
    if (!url) return { url: '', ext: 'mp3', quality: '' };
    return { url, ext: this.inferExt(url, payload), quality: this.inferQuality(payload) };
  },

  /** 迭代收集候选 URL（显式栈替代递归，无深度溢出）；仅接受 http(s) 直链 */
  pickUrl(root) {
    const stack = [{ node: root, depth: 0 }];
    while (stack.length > 0) {
      const item = stack.pop();
      const node = item.node;
      if (!node || item.depth > EXTRACT_DEPTH_MAX) continue;
      if (typeof node === 'string') {
        const s = node.trim();
        if (isUsableUrlString(s) && /^https?:\/\//i.test(s)) return s;
        continue;
      }
      pushUrlChildren(stack, node, item.depth);
    }
    return '';
  },

  /** 从 URL 扩展名或 content-type 推断下载格式（mp3/flac/m4a 常见） */
  inferExt(url, payload) {
    const m = url.match(/\.(mp3|flac|m4a|wav|ogg|aac)(?=$|[?#])/i);
    if (m) return m[1].toLowerCase();
    const meta = String(payload && (payload.content_type || payload['content-type'] || payload.format || payload.type || '')).toLowerCase();
    if (meta.includes('flac')) return 'flac';
    if (meta.includes('mpeg') || meta.includes('mp3')) return 'mp3';
    if (meta.includes('m4a') || meta.includes('mp4')) return 'm4a';
    return 'mp3';
  },

  /** 取质量字段首值（quality/bitrate/br/fileFormat 按序），供 inferQuality 的 data 与顶层两处复用 */
  readQualityField(obj) {
    if (!obj || typeof obj !== 'object') return null;
    return obj.quality || obj.bitrate || obj.br || obj.fileFormat;
  },

  /** 从返回体推断实际音质（带 quality 回退后用于 sourceKey）。先读 payload.data（若 object），再兜底读顶层。 */
  inferQuality(payload) {
    const nested = this.readQualityField(payload && payload.data);
    const q = nested || this.readQualityField(payload);
    if (!q) return '';
    const s = String(q).toLowerCase();
    if (s.includes('flac') || s.includes('lossless')) return 'flac';
    if (s.includes('128')) return '128';
    if (s.includes('320')) return '320';
    return '';
  }
};

/** 质量回退链：首选质量失败 → 逐级降级（flac→320→128），降级时 toast 提示 */
async function resolveWithFallback(song, preferredQuality) {
  const startIdx = QUALITY_FALLBACK_CHAIN.indexOf(preferredQuality);
  const chain = startIdx >= 0
    ? QUALITY_FALLBACK_CHAIN.slice(startIdx)
    : ['320', '128'];
  let lastError = '';
  for (let i = 0; i < chain.length; i++) {
    const q = chain[i];
    const res = await sourceService.resolveSongUrl(song, q);
    if (res.ok) {
      if (i > 0) toast(`音质降级为 ${labelOfQuality(q)}`);
      return res;
    }
    lastError = res.error || lastError;
  }
  return { ok: false, error: lastError || '解析音源失败' };
}

function labelOfQuality(q) {
  const opt = QUALITY_OPTIONS.find((o) => o.value === q);
  return opt ? opt.label : q;
}

/** 判定字符串是否为可用的 URL 候选（非空、非字面 "null"/"undefined"） */
function isUsableUrlString(s) {
  const t = String(s).trim();
  return t !== '' && t !== 'null' && t !== 'undefined';
}

/** 将节点子项压入候选栈（数组/对象反序压入，弹出时保持原始优先级顺序） */
function pushUrlChildren(stack, node, depth) {
  const nextDepth = depth + 1;
  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i--) stack.push({ node: node[i], depth: nextDepth });
    return;
  }
  for (let i = URL_KEYS.length - 1; i >= 0; i--) stack.push({ node: node[URL_KEYS[i]], depth: nextDepth });
}

// ============ §4 去重服务 ============
const dedupeService = {
  /** 文件是否已存在（ctx.fs.stat；错误 code=FILE_MISSING → 不存在）。非 FILE_MISSING 异常按不存在保守处理 */
  async findExistingFile(directory, relativePath) {
    try {
      await ctx.fs.stat({ directoryId: directory.id, path: relativePath });
      return { exists: true };
    } catch (err) {
      if (err && (err.code === 'FILE_MISSING' || err.code === 'ENOENT')) return { exists: false };
      return { exists: false };
    }
  }
};

// ============ §5 下载服务 ============
const downloadService = {
  /** 执行 ctx.net.download 并等待完成。参数见设计 6.7；resume:true 支持中断续传 */
  async run(handle, params) {
    const dl = await ctx.net.download({
      url: params.url,
      target: { directoryId: params.directoryId, relativePath: params.relativePath },
      name: fileNameOf(params.relativePath),
      sourceKey: params.sourceKey,
      idempotencyKey: params.sourceKey,
      conflict: params.conflict || 'rename',
      resume: true,
      signal: handle.signal,
      connectTimeoutMs: DOWNLOAD_CONNECT_TIMEOUT,
      idleTimeoutMs: DOWNLOAD_IDLE_TIMEOUT
    });
    const unsub = dl.subscribe((snap) => taskService.updateProgress(handle, snap));
    try {
      return await dl.wait({ signal: handle.signal });
    } finally {
      unsub();
    }
  }
};

function fileNameOf(relativePath) {
  const parts = String(relativePath).split('/');
  return parts[parts.length - 1] || relativePath;
}

// ============ §5.5 歌词同步服务 ============
// 歌词失败隔离（ADR-002 D9 演进 begin/finish）：歌词一切异常内部吞掉，不传播到 errorGuard.wrap，
// 音频照常 markCompleted（音频为主、歌词为辅）。写入经 ctx.fs.writeFile(FileRef) 写用户授权目录
// （ADR-002 D8：FileRef 对象通道走宿主资源 API 校验授权 read-write + safePath，非仅插件目录）。
// 为什么不用 string 路径通道：ctx.fs.writeFile('path') 只允许写插件私有目录（hostApis.ts:311），
// FileRef 对象形态（src/shared/pluginFiles.ts:16-18）才能写用户授权目录。

/** 探测 promise 是否已 settled（resolve/reject）。
 *  为什么用两跳微任务假值：p.then 回调入队后还需一跳微任务才传播到 race（共两跳）；
 *  若假值用 Promise.resolve(false)（仅一跳）会先赢 → 误判 pending。故假值也走
 *  Promise.resolve().then（两跳），p 已 settled 时其 then 先入队 → true 先赢。
 *  为什么需要：finish 只在预取未就绪时显示"正在下载歌词…"，已就绪时不闪 label（无等待感知）。 */
function isPromiseSettled(p) {
  return Promise.race([
    p.then(() => true, () => true),
    Promise.resolve().then(() => false)
  ]);
}

const lyricsService = {
  /** 开关：settings.syncLyrics === true 时执行（默认开，ADR-002 D12） */
  isEnabled(settings) {
    return !!(settings && settings.syncLyrics === true);
  },

  /**
   * 抓取 LRC 文本（ADR-002 D10：searchLyric 为单对象参数，duration 毫秒）。
   * 验证码复用 errorGuard 重试一次（失败即放弃，避免死循环）。
   * 返回 { ok, lrc, reason? }；ok=false 原因：no-candidates / no-usable / empty-text / verification-failed。
   */
  async fetchLrc(song) {
    try {
      const result = await retryLyricCall(() => ctx.kugou.music.searchLyric(buildLyricSearchParams(song)));
      const candidates = lyricCandidatesOf(result);
      if (candidates.length === 0) return { ok: false, reason: LRC_REASON.noCandidates };
      const candidate = usableLyricCandidates(result);
      if (!candidate) return { ok: false, reason: LRC_REASON.noUsable };
      const detail = await retryLyricCall(() => ctx.kugou.music.getLyric(candidate.id, candidate.accesskey));
      const lrc = extractLrcText(detail);
      if (!lrc) return { ok: false, reason: LRC_REASON.emptyText };
      return { ok: true, lrc };
    } catch (err) {
      // 验证码重试后仍失败 → 静默跳过；其余异常也吞掉（歌词为辅助，不阻断音频）
      if (errorGuard.isVerificationError(err)) return { ok: false, reason: LRC_REASON.verificationFailed };
      return { ok: false, reason: errorMessage(err) || LRC_REASON.failed };
    }
  },

  /** 歌词相对路径：音频下载后真实名 basename 换 .lrc（ADR-002 D11：conflict:'rename' 后歌词同名跟随） */
  buildLrcRelativePath(audioRelativePath) {
    return `${fileNameOf(audioRelativePath).replace(/\.[^.]+$/, '')}.lrc`;
  },

  /**
   * 写歌词到授权目录（ADR-002 D8）：FileRef 对象形态 + overwrite:false（不覆盖已有歌词）。
   * 成功返回 {ok:true}；FILE_EXISTS 返回 {ok:false, reason:'exists'}（静默跳过）；其他异常抛给调用方。
   */
  async writeToSongDir(directory, lrcRelativePath, lrc) {
    try {
      await ctx.fs.writeFile(
        { kind: FILE_REF_KIND, directoryId: directory.id, relativePath: lrcRelativePath },
        lrc,
        { overwrite: false }
      );
      return { ok: true };
    } catch (err) {
      if (err && err.code === 'FILE_EXISTS') return { ok: false, reason: LRC_REASON.exists };
      throw err;
    }
  },

  /**
   * 并行预取（begin/finish 拆分）：立即发起 fetchLrc 并返回其 promise，不 await。
   * 为什么并行预取：searchLyric+getLyric 为两跳网络往返，若音频完成后才串行发起，
   * 任务会在音频 100% 后仍挂"正在下载歌词…"数秒；与音频下载并行可隐藏该延迟。
   * fetchLrc 内部 catch 一切 → 返回的 promise 永不 reject（无 unhandled rejection 风险），
   * 音频下载失败时 finish 不 await 也不会泄漏/崩溃。不含 settings 判断（开关在调用方）。
   */
  begin(song) {
    return this.fetchLrc(song);
  },

  /**
   * 歌词收尾（对应 begin 的并行预取）：等待预取结果并写 .lrc。
   * 预取未就绪 → 先 markLyricsProgress（显示"正在下载歌词…"，保留 done/total/percent）；
   * 预取已就绪 → 不闪 label（音频完成即写 .lrc，感知上无歌词等待）。
   * 无歌词/接口失败 → 返回 {ok:false, reason?}（fetchLrc 已吞掉接口异常）。
   * 写入异常（授权失效/超限等）→ toast + console.error，不抛（不 fail 音频）。
   */
  async finish(fetchPromise, directory, audioRelativePath, handle) {
    if (!(await isPromiseSettled(fetchPromise))) taskService.markLyricsProgress(handle);
    const fetched = await fetchPromise;
    if (!fetched.ok || !fetched.lrc) return fetched;
    const lrcRelativePath = this.buildLrcRelativePath(audioRelativePath);
    try {
      return await this.writeToSongDir(directory, lrcRelativePath, fetched.lrc);
    } catch (err) {
      toast(`歌词下载失败：${errorMessage(err)}`);
      try { console.error('[music-downloader] 歌词下载失败:', err); } catch (e) { /* 忽略 */ }
      return { ok: false, reason: errorMessage(err) || LRC_REASON.failed };
    }
  }
};

/** searchLyric 对象参数构造（D10：单对象签名；duration 毫秒、缺失/0 不传；albumAudioId 存在才传） */
function buildLyricSearchParams(song) {
  const params = { hash: (song && song.hash) || '', man: 'yes' };
  const durationMs = durationSecondsToMs(song && song.duration);
  if (durationMs > 0) params.duration = durationMs;
  const albumAudioId = song && song.albumAudioId;
  if (albumAudioId) params.albumAudioId = albumAudioId;
  return params;
}

/** 歌词 API 调用 + 验证码重试一次（复用 errorGuard.retryAfterVerification；失败即放弃避免死循环） */
async function retryLyricCall(fn) {
  let result;
  try {
    result = await fn();
  } catch (err) {
    if (errorGuard.isVerificationError(err)) {
      return errorGuard.retryAfterVerification(fn, errorGuard.eventIdOf(err));
    }
    throw err;
  }
  if (errorGuard.isVerificationError(result)) {
    return errorGuard.retryAfterVerification(fn, errorGuard.eventIdOf(result));
  }
  return result;
}

/** 提取候选数组（宿主 lyric.ts normalizeSearchPayload 契约：data.candidates / candidates / data.info / info） */
function lyricCandidatesOf(payload) {
  if (!payload) return [];
  const arr = payload.candidates
    || (payload.data && payload.data.candidates)
    || (payload.data && payload.data.info)
    || payload.info;
  return Array.isArray(arr) ? arr : [];
}

/** 取首个可用候选（需 id && accesskey，宿主契约）；无则 null */
function usableLyricCandidates(payload) {
  return lyricCandidatesOf(payload).find((c) => c && c.id && c.accesskey) || null;
}

/** LRC 文本提取多态：data.decodeContent / decodeContent / data.lyric / lyric（回退 data.content / content） */
function extractLrcText(payload) {
  const d = payload && payload.data;
  const chain = [
    d && d.decodeContent, payload && payload.decodeContent,
    d && d.lyric, payload && payload.lyric,
    d && d.content, payload && payload.content
  ];
  for (const c of chain) {
    if (typeof c === 'string' && c.trim()) return c;
  }
  return '';
}

// ============ §6 任务服务 ============
const taskService = {
  /** 注册单曲下载任务；ID 同曲同 id 可复用。提供 cancel + retry action */
  async createSongTask(song) {
    if (!ctx.tasks || typeof ctx.tasks.register !== 'function') {
      throw new Error('当前版本不支持任务中心（ctx.tasks）');
    }
    const taskId = `${TASK_PREFIX}download:${song.hash}`;
    let handleRef = null;
    const handle = await ctx.tasks.register({
      id: taskId,
      name: `下载 ${titleOf(song)}`,
      status: 'running',
      retention: 'transient',
      progress: { done: 0, total: 0, percent: 0, label: '连接音源' },
      actions: [
        { id: 'cancel', label: '取消', variant: 'danger', onClick: () => { if (handleRef) handleRef.cancel(); } },
        { id: 'retry', label: '重试', onClick: () => { if (handleRef && handleRef.retry) handleRef.retry(); } }
      ]
    });
    handleRef = handle;
    return handle;
  },

  /** 由下载快照更新进度：receivedBytes/totalBytes → done/total/percent；label 含速度 */
  updateProgress(handle, snapshot) {
    const received = firstNumber(snapshot, ['receivedBytes', 'received', 'done', 'bytesReceived']);
    const total = firstNumber(snapshot, ['totalBytes', 'total', 'size', 'bytesTotal']);
    const percent = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;
    handle.update({
      progress: { done: received, total, percent, label: progressLabel(snapshot, received, total) }
    });
  },

  /** 下载成功：finish completed（含文件信息，B2 测试暴露缺口：此前漏调 completed） */
  markCompleted(handle, result) {
    try {
      handle.finish('completed', {
        file: result && result.file,
        bytes: result && result.bytes,
        sha256: result && result.sha256, // 与 design §3.2/§6.7 契约一致
      });
    } catch (e) { /* 忽略 */ }
  },

  /** 已完成去重跳过：finish completed + skipped 标记 */
  markSkipped(handle, note) {
    try { handle.finish('completed', { skipped: true, note }); } catch (e) { /* 忽略 */ }
  },

  /** 歌词同步下载进行中：保留 done/total/percent，仅换 label（设计 §5 任务 label 提示） */
  markLyricsProgress(handle) {
    try {
      // 宿主 handle 若暴露 state.progress 则原样保留；否则仅传 label（宿主按部分合并语义更新）
      const prev = (handle && handle.state && handle.state.progress) || null;
      handle.update({
        progress: prev
          ? { done: prev.done || 0, total: prev.total || 0, percent: prev.percent || 0, label: LYRICS_PROGRESS_LABEL }
          : { label: LYRICS_PROGRESS_LABEL }
      });
    } catch (e) { /* 忽略 */ }
  },

  /** 失败：双态兼容（设计用 'failed'，宿主可能用 'error'） */
  markFailed(handle, error) {
    const note = { error: errorMessage(error) };
    try { handle.finish(FINISH_FAILED, note); }
    catch (e) { try { handle.finish('error', note); } catch (e2) { /* 忽略 */ } }
  },

  /** 用户取消：优先 handle.cancel()（宿主中止任务），兜底 finish aborted */
  markCanceled(handle) {
    try {
      if (typeof handle.cancel === 'function') { handle.cancel(); return; }
      handle.finish(FINISH_ABORTED);
    } catch (e) {
      try { handle.finish(FINISH_ABORTED); } catch (e2) { /* 忽略 */ }
    }
  }
};

function firstNumber(snapshot, keys) {
  for (const k of keys) {
    const v = snapshot && snapshot[k];
    if (typeof v === 'number' && isFinite(v)) return v;
  }
  return 0;
}

function progressLabel(snapshot, received, total) {
  const speed = firstNumber(snapshot, ['rate', 'speed', 'bytesPerSecond']);
  const speedTxt = speed > 0 ? ` ${formatBytes(speed)}/s` : '';
  return total > 0 ? `${formatBytes(received)} / ${formatBytes(total)}${speedTxt}` : `${formatBytes(received)}${speedTxt}`;
}

function formatBytes(n) {
  if (n >= BYTES_PER_GB) return `${(n / BYTES_PER_GB).toFixed(1)} GB`;
  if (n >= BYTES_PER_MB) return `${(n / BYTES_PER_MB).toFixed(1)} MB`;
  if (n >= BYTES_PER_KB) return `${(n / BYTES_PER_KB).toFixed(1)} KB`;
  return `${n} B`;
}

// ============ §7 编排入口 ============
/** 唯一业务入口（外部兜底：永不 reject → 任何异常都有 toast 反馈，避免"点击没反应"静默） */
async function handleDownload(song) {
  try {
    await handleDownloadCore(song);
  } catch (err) {
    toast(`下载失败：${errorMessage(err)}`);
    try { console.error('[music-downloader] 下载异常:', err); } catch (e) { /* 忽略 */ }
  }
}

/** 核心下载流程：设置 → 目录授权 → 任务 → 音源 → 去重 → 下载 → 完成 */
async function handleDownloadCore(song) {
  if (!song || !song.hash) { toast('歌曲信息不完整'); return; }

  const settings = await storageService.getSettings();
  const dirResult = await directoryService.ensureDirectory();
  if (!dirResult.ok) {
    // 取消 → 提示取消；否则显示具体错误原因（如"版本不支持目录授权"），避免笼统提示掩盖根因
    const msg = dirResult.reason === 'canceled'
      ? '未选择保存目录，已取消'
      : (dirResult.error ? errorMessage(dirResult.error) : '目录授权不可用，请重新授权');
    toast(msg);
    return;
  }

  let handle;
  try {
    handle = await taskService.createSongTask(song);
  } catch (err) {
    toast(`任务创建失败：${errorMessage(err)}`);
    return;
  }
  await errorGuard.wrap(async () => {
    const src = await resolveWithFallback(song, settings.quality);
    if (!src.ok) throw new Error(src.error || '解析音源失败');

    const relativePath = buildRelativePath(song, src.ext);
    const existing = await dedupeService.findExistingFile(dirResult.directory, relativePath);
    if (existing.exists) {
      taskService.markSkipped(handle, '文件已存在，跳过');
      toast(`已存在，跳过：${relativePath}`);
      return;
    }

    // 并行预取歌词（ADR-002 D9 演进）：去重通过后即发起、不 await，与音频下载并行隐藏
    // searchLyric+getLyric 两跳网络延迟；开关关闭 → null（不查询）。fetchLrc 永不 reject，
    // 音频下载抛错时不 finish 也无泄漏（promise 后台完成，无 unhandled rejection）。
    const lyricFetch = lyricsService.isEnabled(settings) ? lyricsService.begin(song) : null;

    const result = await downloadService.run(handle, {
      url: src.url,
      directoryId: dirResult.directory.id,
      relativePath,
      sourceKey: src.sourceKey,
      conflict: settings.conflict,
      quality: src.resolvedQuality
    });
    // 歌词收尾：等待预取结果写 .lrc（finish 内部消化一切异常，不 fail 音频）；
    // 预取未就绪时 finish 内显示"正在下载歌词…"（保留 done/total/percent）
    if (lyricFetch) await lyricsService.finish(lyricFetch, dirResult.directory, (result && result.file && result.file.relativePath) || '', handle);
    taskService.markCompleted(handle, result);
    toast(`下载完成：${relativePath}`);
  }, handle);
}

/** 播放栏点击：取当前播放歌曲 → handleDownload；任何异常都有 toast 反馈，不静默 */
async function handlePlayerbarClick() {
  try {
    const track = detectCurrentTrack();
    if (!track) { toast('请先播放一首歌曲'); return; }
    await handleDownload(track);
  } catch (err) {
    toast(`下载失败：${errorMessage(err)}`);
    try { console.error('[music-downloader] 播放栏异常:', err); } catch (e) { /* 忽略 */ }
  }
}

/** 探测当前播放曲（R2 实测项）：优先 currentTrack（含 Vue computed .value），回退 player.current() */
function detectCurrentTrack() {
  const player = ctx && ctx.player;
  if (!player) return null;
  const t = player.currentTrack;
  if (t == null) return trackFromCurrent(player.current);
  if (typeof t === 'function') return t() || trackFromCurrent(player.current);
  // Vue computed 是对象且有 .value（文档明确）；普通对象直接使用
  const val = (typeof t === 'object' && 'value' in t) ? t.value : t;
  return val || trackFromCurrent(player.current);
}

/** 从 player.current()/current 属性提取当前曲对象（兼容 song/track 包裹） */
function trackFromCurrent(current) {
  const c = typeof current === 'function' ? current() : current;
  if (!c) return null;
  return c.song || c.track || c;
}

// ============ §8 错误守卫 ============
const errorGuard = {
  /** 统一包裹业务异常：取消→静默；其余→toast + task.finish('failed') */
  async wrap(fn, handle) {
    try {
      await fn();
    } catch (err) {
      if (isAbortError(err)) { taskService.markCanceled(handle); return; }
      taskService.markFailed(handle, err);
      toast(`下载失败：${errorMessage(err)}`);
    }
  },
  /** 判断是否验证码类错误：ssaCode/eventId/captcha 或错误文案含验证标识 */
  isVerificationError(err) {
    if (!err) return false;
    if (typeof err === 'string') return /验证|验证码|captcha/i.test(err);
    const hasField = (o) => o && (o.ssaCode || o.eventId || o.captcha || o.verifyCode);
    return hasField(err) || /验证码|验证失败|captcha/i.test(errorMessage(err));
  },
  /** 从错误对象取验证码 eventId */
  eventIdOf(err) {
    if (!err) return 'default';
    return err.eventId || err.ssaCode || err.captcha || err.verifyCode || 'default';
  },
  /** 调 ctx.kugouVerification.request(eventId) → 成功则重试原 fn 一次，失败抛错（避免死循环） */
  async retryAfterVerification(fn, eventId) {
    const ok = await ctx.kugouVerification.request(eventId || 'default');
    if (!ok) throw new Error('验证码验证未通过');
    return await fn();
  }
};

// ============ §9 UI 组件与挂点 ============
/** 目录状态文案（granted 用 describeDirRef 动态生成，其余为固定文案，集中一处避免措辞分叉） */
const DIR_STATUS_TEXT = {
  loading: '加载中…',
  none: '未选择保存目录',
  expired: '授权已失效，请重新选择'
};

/** 设置表单组件（ctx.vue 定义，非 import vue）。
 *  参考式设计（参考官方 spectrum-visualizer 插件）：概览卡 + 2 分组面板 + 字段行 + 状态胶囊，
 *  样式经 ctx.css.inject（§10 SETTINGS_CSS）注入，宿主 Select/Button 走 defineAsyncComponent。 */
function defineSettingsComponent() {
  const vue = ctx.vue;
  const { defineAsyncComponent, defineComponent, h, reactive } = vue;
  const onMounted = vue.onMounted || (() => {});
  // 宿主组件由 Vue 自行异步加载并渲染占位，无需手动 await / 原生兜底（文档示例即此用法）
  const Select = defineAsyncComponent(ctx.ui.components.Select);
  const Button = defineAsyncComponent(ctx.ui.components.Button);
  const Switch = defineAsyncComponent(ctx.ui.components.Switch);

  return defineComponent({
    name: 'MusicDownloaderSettings',
    setup() {
      // reactive 草稿：先给默认值渲染，挂载后异步覆盖为已存设置（参考文档示例）
      const settings = reactive(Object.assign({}, DEFAULT_SETTINGS));
      // 目录四态属 UI 层状态（loading/granted/none/expired），驱动路径文案与按钮文案
      const dirState = reactive({ status: 'loading', text: DIR_STATUS_TEXT.loading });

      onMounted(async () => {
        Object.assign(settings, await storageService.getSettings());
        Object.assign(dirState, await readDirectoryState());
      });

      // 改动即保存（本面板无保存按钮）：fire-and-forget，catch 避免 unhandled rejection
      const setQuality = (val) => {
        settings.quality = val;
        void storageService.saveSettings({ quality: val }).catch((e) => { console.error(e); });
      };
      const setConflict = (val) => {
        settings.conflict = val;
        void storageService.saveSettings({ conflict: val }).catch((e) => { console.error(e); });
      };
      // 歌词同步开关：改动即保存（同 setQuality 模式）
      const setSyncLyrics = (val) => {
        settings.syncLyrics = val;
        void storageService.saveSettings({ syncLyrics: val }).catch((e) => { console.error(e); });
      };
      const pickDir = async () => {
        try {
          const d = await directoryService.selectDirectory();
          // 选择成功即已知可用，无需再次查询授权列表
          Object.assign(dirState, { status: 'granted', text: describeDirRef(d) });
          toast('保存目录已更新');
        } catch (e) {
          // 用户取消是正常操作（短提示即可）；其他失败必须给出原因，否则用户误以为是自己取消了
          if (reasonOfAuthError(e) === 'canceled') { toast('选择目录已取消'); return; }
          toast(`选择目录失败：${errorMessage(e)}`);
          console.error('[music-downloader] 选择目录失败:', e);
        }
      };

      return { settings, dirState, setQuality, setConflict, setSyncLyrics, pickDir };
    },
    render() {
      // 渲染体抽到模块级函数：defineSettingsComponent 只保留组件装配，便于单函数长度受控
      return renderSettingsView(this, Select, Button, Switch, h);
    }
  });
}

// 设置面板视觉语言：参考官方插件 spectrum-visualizer 的设置面板（概览卡 + 分组面板 + 字段行）。
// 样式经 ctx.css.inject 全局注入（见 §10 SETTINGS_CSS），渲染层只留结构与 class 钩子，不再用 inline style。
// 为什么不用其他两条通道：manifest style.css 在宿主设置面板作用域不生效（实测）、
// 组件 props.style 透传不可靠（实测）；参考插件的 ctx.css.inject 通道官方验证可靠。
// class 用 md- 前缀隔离宿主；色值一律 var(--宿主, 兜底)。

/** 设置面板：概览卡 + 2 个分组面板（下载设置 / 保存位置） */
function renderSettingsView(vm, Select, Button, Switch, h) {
  return h('div', { class: 'md-settings' }, [
    renderOverviewCard(vm, h),
    renderDownloadSettingsPanel(vm, Select, Switch, h),
    renderSaveLocationPanel(vm, Button, h)
  ]);
}

/** 概览卡：左 mark（5 根 bars）+ 中 copy(h3+p) + 右目录状态胶囊 */
function renderOverviewCard(vm, h) {
  return h('div', { class: 'md-settings__overview' }, [
    h('img', { class: 'md-settings__mark', src: ICON_URL, alt: '' }),
    h('div', { class: 'md-settings__copy' }, [
      h('h3', '酷狗音乐下载'),
      h('p', '从酷狗在线音源下载歌曲到本地音乐库，进度在任务中心查看')
    ]),
    renderDirPill(vm.dirState, h)
  ]);
}

// 插件自身图标（与根目录 icon.svg 保持一致）：设置面板概览卡左侧展示。
// 为何内嵌为 data: URL：宿主未向插件渲染层暴露自身 icon URL，data: 最稳妥、不依赖宿主内部 API。
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#f4515e"/><stop offset="1" stop-color="#d9233a"/>
  </linearGradient></defs>
  <rect x="0.5" y="0.5" width="23" height="23" rx="5.5" fill="url(#bg)"/>
  <circle cx="9.2" cy="15.4" r="3.5" fill="#fff"/>
  <path d="M10.9 6.4v11.4" stroke="#fff" stroke-width="2.9" stroke-linecap="round"/>
  <path d="M10.9 7.0 C 14.5 5.7 17.4 6.5 17.6 9.5 C 17.7 11.4 16.4 12.5 14.9 12.1 C 13.7 11.8 12.9 10.8 12.9 9.7 C 12.9 8.4 13.7 7.6 14.8 7.4 C 13.7 7.8 12.5 8.1 10.9 8.4 Z" fill="#fff"/>
</svg>`;
const ICON_URL = `data:image/svg+xml,${encodeURIComponent(ICON_SVG)}`;

/** 目录状态胶囊：文案 = dirState.text，态色由 is-granted/is-expired 类表达（granted=绿/expired=红/none=次级） */
function renderDirPill(dirState, h) {
  return h('span', { class: `md-settings__dir-pill ${dirStatusClass(dirState.status)}` }, [
    h('i'),
    dirState.text || DIR_STATUS_TEXT.none
  ]);
}

/** 目录态 → 胶囊态色类：granted=绿、expired=红、其余=次级（无态色类） */
function dirStatusClass(status) {
  if (status === 'granted') return 'is-granted';
  if (status === 'expired') return 'is-expired';
  return '';
}

/** 分组「下载设置」：音质 + 冲突处理 Select 字段 + 同步下载歌词 Switch 字段 */
function renderDownloadSettingsPanel(vm, Select, Switch, h) {
  return renderPanel(h, '下载设置', '音质与同名文件处理方式', [
    renderSelectField(h, Select, '音质', '选择下载音质', vm.settings.quality, QUALITY_OPTIONS, vm.setQuality),
    renderSelectField(h, Select, '冲突处理', '同名文件时如何处理', vm.settings.conflict, CONFLICT_OPTIONS, vm.setConflict),
    renderSwitchField(h, Switch, '同步下载歌词', '下载歌曲时同时获取 .lrc 歌词', vm.settings.syncLyrics, vm.setSyncLyrics)
  ]);
}

/** 分组「保存位置」：目录路径 + 授权按钮（路径进文案、按钮做控件，符合参考字段行） */
function renderSaveLocationPanel(vm, Button, h) {
  return renderPanel(h, '保存位置', '下载歌曲保存的目录与授权', [
    renderDirField(vm, Button, h)
  ]);
}

/** 分组面板：heading(h3+p) + body(字段列表) */
function renderPanel(h, title, desc, fields) {
  return h('div', { class: 'md-settings__panel' }, [
    h('div', { class: 'md-settings__section-heading' }, [
      h('h3', title),
      h('p', desc)
    ]),
    h('div', { class: 'md-settings__section-body' }, fields)
  ]);
}

/** Select 字段行：左文案(strong+small) + 右 Select（class 透传宿主 root，参考插件验证可靠） */
function renderSelectField(h, Select, label, desc, modelValue, options, onUpdate) {
  return h('div', { class: 'md-settings__field' }, [
    fieldCopy(h, label, desc),
    h(Select, {
      class: 'md-settings__select',
      modelValue,
      options,
      'onUpdate:modelValue': onUpdate
    })
  ]);
}

/** Switch 字段行：左文案(strong+small) + 右 Switch（裸放，无 class/style 透传）。
 *  用 --switch 变体：控件列 auto，Switch 贴行右缘（与 Select/Button 右缘对齐），非 minmax 列左置 */
function renderSwitchField(h, Switch, label, desc, modelValue, onUpdate) {
  return h('div', { class: 'md-settings__field md-settings__field--switch' }, [
    fieldCopy(h, label, desc),
    h(Switch, { modelValue, 'onUpdate:modelValue': onUpdate })
  ]);
}

/** 保存目录字段：路径进 field-copy small（长路径 overflow-wrap:anywhere），按钮做控件 */
function renderDirField(vm, Button, h) {
  return h('div', { class: 'md-settings__field' }, [
    fieldCopy(h, '保存目录', vm.dirState.text || DIR_STATUS_TEXT.none),
    h(Button, { variant: 'outline', size: 'xs', onClick: vm.pickDir },
      { default: () => dirActionLabel(vm.dirState.status) })
  ]);
}

/** 字段左文案列：strong(13px/650) + small(12px secondary) */
function fieldCopy(h, label, desc) {
  return h('div', { class: 'md-settings__field-copy' }, [
    h('strong', label),
    h('small', desc)
  ]);
}

/** 目录态 → 按钮文案：告诉用户「现在该做什么」，而非固定一个「选择目录」 */
function dirActionLabel(status) {
  if (status === 'granted') return '重新选择';
  if (status === 'expired') return '重新授权';
  return '选择目录';
}

/** 读取持久化目录 → UI 四态（loading 由 dirState 初值表达，这里只产出确定态）。
 *  文案复用 DIR_STATUS_TEXT/describeDirRef，与设计 §7 状态表一一对应 */
async function readDirectoryState() {
  const id = await storageService.getDirectoryId();
  if (!id) return { status: 'none', text: DIR_STATUS_TEXT.none };
  const grant = await findAvailableGrant(id);
  if (!grant) return { status: 'expired', text: DIR_STATUS_TEXT.expired };
  return { status: 'granted', text: describeDirRef(grant) };
}

/** 注册歌曲右键菜单 */
function registerContextMenu() {
  ctx.ui.addSongContextMenuItem({
    id: `${APP_ID}:download`,
    label: '下载到 EchoMusic',
    onSelect: handleDownload
  });
}

/** 注册播放栏按钮（R2：取当前曲失败时仅保留右键入口，不报错） */
function registerPlayerbar() {
  ctx.ui.playerbar.register({
    id: `${APP_ID}:playerbar`,
    title: '下载当前歌曲',
    icon: 'tabler:download',
    defaultPlacement: 'more',
    onClick: handlePlayerbarClick
  });
}

/** 注册设置页 */
function registerSettings() {
  try {
    ctx.ui.settings.define({ title: '音乐下载', component: defineSettingsComponent() });
  } catch (e) { /* 设置注册失败不阻塞主功能 */ }
}

// ============ §10 生命周期 ============
// 设置面板注入 CSS（参考 spectrum-visualizer：概览卡 + 分组面板 + 字段行 + Select 撑满控件列）。
// 经 ctx.css.inject 运行时全局注入（参考插件即此法，官方验证可靠）；md- 前缀隔离宿主。
// 色值一律 var(--宿主, 兜底)；概览卡/分组面板统一 border-radius:16px + 参考式 shadow。
let cssDispose = null;

const SETTINGS_CSS = `
.md-settings { display: grid; gap: 14px; min-width: 0; color: var(--color-text-main, var(--text-main, #1d1d1f)); }
.md-settings__overview { display: grid; grid-template-columns: 52px minmax(0, 1fr) auto; align-items: center; gap: 14px; border: 1px solid var(--border-subtle, rgba(127,127,127,0.16)); border-radius: 16px; background: var(--color-bg-elevated, var(--surface-card-base, #fff)); padding: 14px; box-shadow: 0 2px 12px color-mix(in srgb, var(--color-text-main, #1d1d1f) 3%, transparent); }
.md-settings__mark { width: 48px; height: 48px; display: block; }
.md-settings__copy { display: grid; gap: 2px; min-width: 0; }
.md-settings__copy h3 { margin: 0; font-size: 13px; font-weight: 700; color: var(--color-text-main, var(--text-main, #1d1d1f)); }
.md-settings__copy p { margin: 0; font-size: 12px; color: var(--color-text-secondary, var(--text-secondary, #6b7280)); }
.md-settings__dir-pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--control-border, rgba(127,127,127,0.24)); background: var(--control-muted-bg, rgba(127,127,127,0.08)); font-size: 11px; font-weight: 650; color: var(--color-text-secondary, var(--text-secondary, #6b7280)); white-space: nowrap; }
.md-settings__dir-pill i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.md-settings__dir-pill.is-granted { color: #10b981; background: color-mix(in srgb, #10b981 12%, transparent); border-color: color-mix(in srgb, #10b981 30%, transparent); }
.md-settings__dir-pill.is-expired { color: #ef4444; background: color-mix(in srgb, #ef4444 12%, transparent); border-color: color-mix(in srgb, #ef4444 30%, transparent); }
.md-settings__panel { display: grid; border: 1px solid var(--border-subtle, rgba(127,127,127,0.16)); border-radius: 16px; overflow: hidden; background: var(--color-bg-elevated, var(--surface-card-base, #fff)); box-shadow: 0 2px 12px color-mix(in srgb, var(--color-text-main, #1d1d1f) 3%, transparent); }
.md-settings__section-heading { display: grid; gap: 3px; padding: 15px 18px 12px; }
.md-settings__section-heading h3 { margin: 0; font-size: 13px; font-weight: 700; color: var(--color-text-main, var(--text-main, #1d1d1f)); }
.md-settings__section-heading p { margin: 0; font-size: 12px; color: var(--color-text-secondary, var(--text-secondary, #6b7280)); }
.md-settings__section-body { display: grid; min-width: 0; }
.md-settings__field { display: grid; grid-template-columns: minmax(0, 1fr) minmax(200px, 250px); align-items: center; gap: 24px; min-width: 0; min-height: 58px; padding: 10px 18px; }
.md-settings__field--switch { grid-template-columns: minmax(0, 1fr) auto; }
.md-settings__field + .md-settings__field { border-top: 1px solid color-mix(in srgb, var(--color-text-main, #1d1d1f) 12%, transparent); }
.md-settings__field-copy { display: grid; gap: 2px; min-width: 0; }
.md-settings__field-copy strong { font-size: 13px; font-weight: 650; color: var(--color-text-main, var(--text-main, #1d1d1f)); }
.md-settings__field-copy small { font-size: 12px; color: var(--color-text-secondary, var(--text-secondary, #6b7280)); overflow-wrap: anywhere; }
.md-settings__select { width:100%; min-width:0; justify-content:space-between; }
`;

/** 设置面板样式注入：经 ctx.css 运行时全局注入（参考插件通道，官方验证可靠）。
 *  为什么不用其他两条通道：manifest style.css 在宿主设置面板作用域不生效（实测）；
 *  组件 props.style 透传未验证且实测无效。注入返回的 dispose 在 deactivate 时调用，
 *  宿主禁用/卸载时不依赖自动清理（双保险）。 */
function injectSettingsCss() {
  // 重入守卫：activate 重复调用时避免二次注入覆盖/泄漏首次注入的 dispose（审查 A3）
  if (cssDispose) return;
  try {
    if (typeof ctx.css?.inject !== 'function') return;
    cssDispose = ctx.css.inject(SETTINGS_CSS);
  } catch (e) {
    console.error('[music-downloader] 设置面板样式注入失败:', e);
  }
}

function init() {
  registerContextMenu();
  registerPlayerbar();
  registerSettings();
  injectSettingsCss();
}

/** 入口：宿主经 Blob URL 加载单文件 ESM */
export function activate(pluginCtx) {
  ctx = pluginCtx;
  init();
}

/** 可选清理钩子：注册项由宿主自动清理；样式注入的 dispose 需手动调用（宿主不保证自动清理） */
export function deactivate() {
  if (typeof cssDispose === 'function') {
    try { cssDispose(); } catch (e) { /* 忽略 */ }
    cssDispose = null;
  }
}
