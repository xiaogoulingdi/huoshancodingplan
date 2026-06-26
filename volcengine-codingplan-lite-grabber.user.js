// ==UserScript==
// @name         火山方舟 Coding Plan 抢购助手（Lite/Pro 可选）
// @namespace    https://github.com/xiaogoulingdi/huoshancodingplan
// @version      1.3.0
// @description  自动循环点击「立即订阅」按钮。间隔从上次点击时刻算起（非响应结束后），响应未回来不抢点。直接读取服务器响应判断有无货，支持 Lite/Pro，抢到后高亮+蜂鸣+弹窗提醒。
// @author       xiaogoulingdi
// @match        https://www.volcengine.com/activity/codingplan*
// @match        https://console.volcengine.com/ark*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @noframes
// @license      MIT
// ==/UserScript==

/*
  ┌──────────────────────────────────────────────────────────────────────┐
  │  火山方舟 Coding Plan 抢购助手  v1.3.0                                 │
  │  ───────────────────────────────────────────────────────────────────  │
  │  功能                                                                 │
  │   • 支持选择抢购 Lite Plan 或 Pro Plan（面板下拉框切换）               │
  │   • 自动定位目标 Plan 卡片的「立即订阅」按钮并循环点击                  │
  │   • 间隔从「上次点击时刻」算起（非响应结束后才计时），响应未回不抢点   │
  │   • 每 10 秒点击一次，带 ±2 秒随机抖动（可在面板调整）                   │
  │   • 直接读取服务器响应体判断有无货（不依赖页面弹窗，静默返回也能识别）  │
  │     - 命中失败关键词(库存不足/无货...) → 继续重试                       │
  │     - 命中成功关键词(下单成功/订单创建...) 或 URL 跳转 → 成功停止       │
  │   • 检测到验证码弹层 → 提示人工处理                                    │
  │   • 日志显示每次响应耗时和下次点击倒计时（计时透明化）                  │
  │   • 抢到后：停止点击 + 红色边框闪烁高亮 + 蜂鸣声 + 弹窗                 │
  │   • 悬浮可拖拽控制面板：版本/开始/暂停、间隔、抖动、最大次数、日志      │
  │   • 不会自动开始，每次刷新页面默认关闭，需手动点「开始抢购」             │
  │                                                                        │
  │  使用方法                                                              │
  │   1. 安装 Tampermonkey 浏览器扩展                                      │
  │   2. 新建脚本，粘贴本文件全部内容并保存（或直接导入 .user.js）          │
  │   3. 打开 https://www.volcengine.com/activity/codingplan 并登录         │
  │   4. 页面右上角出现控制面板，选择版本，点「开始抢购」即可                │
  │   5. 抢到后会有声音和弹窗提醒，请手动完成支付                            │
  │                                                                        │
  │  项目主页：https://github.com/xiaogoulingdi/huoshancodingplan           │
  │                                                                        │
  │  配置说明（面板内可改，默认值见下方 CONFIG）                            │
  │   • targetPlan   : 抢购版本，'Lite Plan' 或 'Pro Plan'                  │
  │   • intervalSec  : 点击间隔（秒），默认 10                              │
  │   • jitterSec    : 随机抖动（秒），默认 2，实际间隔 = interval ± jitter  │
  │   • maxAttempts  : 最大尝试次数，0 = 无限                              │
  │   • detectWindowMs: 点击后结果检测窗口（毫秒），默认 8000               │
  │                                                                        │
  │  风险提示                                                              │
  │   • 本脚本仅模拟人工点击，不绕过任何支付/验证流程                       │
  │   • 间隔过短可能触发风控，请保持合理间隔                                │
  │   • 请在已登录状态下使用，脚本不处理登录                                 │
  │   • 抢到后脚本只负责提醒，下单/支付需你手动完成                          │
  └──────────────────────────────────────────────────────────────────────┘
*/

(function () {
  'use strict';

  /* ======================== 配置 ======================== */
  const CONFIG = {
    intervalSec: 10,      // 点击间隔（秒）
    jitterSec: 2,         // 随机抖动（秒）
    maxAttempts: 0,       // 最大尝试次数，0 = 无限
    detectWindowMs: 8000, // 点击后结果检测窗口（毫秒）
    // 失败关键词（响应体/弹窗文字命中任一即视为本轮失败，继续重试）
    failKeywords: ['库存不足', '暂不可下单', '售罄', '缺货', '下单失败', '购买失败', '暂时无法购买', '无货', 'insufficient', 'out of stock', 'sold out', 'no inventory', 'soldout'],
    // 成功关键词（响应体命中即视为成功，配合 URL 跳转判定）
    successKeywords: ['下单成功', '订单创建成功', '创建订单成功', '订阅成功', 'subscribe success', 'order created', 'tradeNo', 'orderId', 'order_id', 'payOrderNo', '支付订单'],
    // 成功判定：URL 离开活动页（跳转到 console 下单/支付页）
    activityUrlPattern: /volcengine\.com\/activity\/codingplan/i,
    // 只捕获 URL 含这些关键词的请求的响应体（过滤掉埋点/统计/轮询等无关请求，避免卡顿）
    relevantUrlKeywords: ['order', 'trade', 'subscribe', 'subscri', 'pay', 'buy', 'cart', 'submit', 'stock', 'invent', 'purchase', 'codingplan', 'plan'],
    // 目标套餐（可选 'Lite Plan' 或 'Pro Plan'，对应 data-monitor-comp-topic 属性值）
    targetPlan: 'Lite Plan',
  };

  /* ======================== 状态 ======================== */
  const STATE = {
    running: false,        // 是否正在抢购
    attempts: 0,           // 已尝试次数
    lastResult: '待开始',   // 上次结果
    lastClickTime: 0,      // 上次点击时间戳
    roundEndTime: 0,       // 本轮响应检测结束时间戳
    nextClickAt: 0,        // 下次点击时间戳
    timer: null,           // setTimeout 句柄
    cdTimer: null,         // 倒计时刷新 setInterval 句柄
    observer: null,        // MutationObserver
    roundFailed: false,    // 本轮是否已判定为失败
    roundDomHit: null,     // 本轮 DOM 命中的关键词证据
    success: false,        // 是否已成功
    captureActive: false,  // 是否正在采集本轮响应
    roundResponses: [],    // 本轮捕获的网络响应
  };

  const STORE = {
    get running() { return GM_getValue('vcp_running', false); },
    set running(v) { GM_setValue('vcp_running', v); },
  };

  /* ======================== 日志 ======================== */
  const LOG_MAX = 60;
  const logs = [];
  function log(msg, type) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const line = `[${time}] ${msg}`;
    logs.push({ line, type: type || 'info' });
    if (logs.length > LOG_MAX) logs.shift();
    console.log('%c[Lite抢购] ' + line, type === 'fail' ? 'color:#e53935' : type === 'ok' ? 'color:#43a047' : 'color:#1e88e5');
    renderLog();
  }

  /* ======================== 网络拦截：捕获响应体（URL 过滤，仅下单相关） ======================== */
  let netHookInstalled = false;
  function isRelevantUrl(url) {
    if (!url) return false;
    const u = url.toLowerCase();
    for (const kw of CONFIG.relevantUrlKeywords) {
      if (u.indexOf(kw) !== -1) return true;
    }
    return false;
  }
  function installNetHook() {
    if (netHookInstalled) return;
    netHookInstalled = true;
    const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    const BODY_CAP = 4096;

    // 拦截 fetch：仅对相关 URL 且采集期开启时才 clone+text
    const _fetch = win.fetch;
    if (_fetch) {
      win.fetch = function () {
        const url = String((arguments[0] && (arguments[0].url || arguments[0])) || '');
        const relevant = isRelevantUrl(url);
        const p = _fetch.apply(this, arguments);
        if (STATE.captureActive && relevant) {
          const rec = { kind: 'fetch', url: url, t: Date.now(), status: null, body: '' };
          STATE.roundResponses.push(rec);
          p.then(function (r) {
            try { rec.status = r.status; } catch (e) {}
            try {
              const clone = r.clone();
              clone.text().then(function (txt) { rec.body = (txt || '').slice(0, BODY_CAP); }).catch(function () {});
            } catch (e) {}
          }).catch(function () {});
        }
        return p;
      };
    }
    // 拦截 XHR：仅对相关 URL 且采集期开启时才记录
    const _open = win.XMLHttpRequest.prototype.open;
    const _send = win.XMLHttpRequest.prototype.send;
    win.XMLHttpRequest.prototype.open = function (method, url) {
      this.__vcpUrl = String(url); this.__vcpMethod = method;
      return _open.apply(this, arguments);
    };
    win.XMLHttpRequest.prototype.send = function () {
      const xhr = this;
      if (STATE.captureActive && isRelevantUrl(this.__vcpUrl)) {
        const rec = { kind: 'xhr', url: this.__vcpUrl, method: this.__vcpMethod, t: Date.now(), status: null, body: '' };
        this.addEventListener('loadend', function () {
          try { rec.status = xhr.status; } catch (e) {}
          try { rec.body = (xhr.responseText || String(xhr.response || '')).slice(0, BODY_CAP); } catch (e) {}
        });
        STATE.roundResponses.push(rec);
      }
      return _send.apply(this, arguments);
    };
  }

  /* ======================== 验证码检测（轻量，不用 getComputedStyle） ======================== */
  function visibleFast(el) {
    if (!el) return false;
    if (el.offsetParent === null && el.tagName !== 'BODY') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function detectCaptcha() {
    const sels = [
      'iframe[src*="captcha"]', 'iframe[src*="verify"]', 'iframe[src*="bdms"]',
      '#tcaptcha_iframe', '#captcha', '[class*="captcha"]', '[class*="Captcha"]'
    ];
    for (const sel of sels) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        if (visibleFast(el)) return sel;
      }
    }
    return null;
  }

  /* ======================== 响应体扫描（优化：预计算小写，避免重复转换） ======================== */
  const failKwLower = CONFIG.failKeywords.map(function (k) { return k.toLowerCase(); });
  const successKwLower = CONFIG.successKeywords.map(function (k) { return k.toLowerCase(); });
  function scanResponses() {
    for (const r of STATE.roundResponses) {
      const text = ((r.body || '') + ' ' + (r.url || '')).toLowerCase();
      for (const kw of failKwLower) {
        if (text.indexOf(kw) !== -1) return { result: 'fail', hit: { kw: kw, url: r.url } };
      }
    }
    for (const r of STATE.roundResponses) {
      const text = ((r.body || '') + ' ' + (r.url || '')).toLowerCase();
      for (const kw of successKwLower) {
        if (text.indexOf(kw) !== -1) return { result: 'success', hit: { kw: kw, url: r.url } };
      }
    }
    return { result: null, hit: null };
  }

  /* ======================== DOM 定位 ======================== */
  // 判断元素是否可见（排除响应式隐藏副本）
  function isVisible(el) {
    if (!el) return false;
    if (el.offsetParent === null) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
  }

  // 主策略：用业务属性定位目标 Plan 卡片内的「立即订阅」按钮
  function findTargetButton() {
    const plan = CONFIG.targetPlan;
    // 1) 业务属性定位卡片容器
    const cards = document.querySelectorAll('[data-monitor-comp-topic="' + plan + '"]');
    for (const card of cards) {
      const btn = findSubscribeButtonIn(card);
      if (btn) return btn;
    }
    // 2) 回退：全页找「立即订阅」文字按钮，且最近祖先卡片含目标 Plan 文字
    const allBtns = Array.from(document.querySelectorAll('[class*="goodsButton"], [class*="primaryBtn"]'));
    for (const btn of allBtns) {
      if (!isVisible(btn)) continue;
      if (btn.textContent.trim().indexOf('立即订阅') === -1) continue;
      const card = btn.closest('[data-monitor-comp-topic]') || btn.closest('[class*="cardContainer"]') || btn.parentElement;
      if (card && card.textContent.indexOf(plan) !== -1) return btn;
    }
    return null;
  }

  // 在卡片容器内找可点击的订阅按钮
  function findSubscribeButtonIn(card) {
    const candidates = card.querySelectorAll('[class*="goodsButton"], [class*="primaryBtn"], [data-monitor-click-id]');
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      if (el.textContent.trim().indexOf('立即订阅') !== -1) return el;
      const label = el.querySelector('[class*="buttonLabel"]');
      if (label && label.textContent.trim().indexOf('立即订阅') !== -1) return el;
    }
    return null;
  }

  // 按钮是否被禁用（无货时可能置灰）
  function isButtonDisabled(btn) {
    if (!btn) return true;
    if (btn.getAttribute('data-disabled') === 'true') return true;
    if (btn.getAttribute('aria-disabled') === 'true') return true;
    const style = getComputedStyle(btn);
    if (style.pointerEvents === 'none') return true;
    if (style.opacity !== '' && parseFloat(style.opacity) < 0.5) return true;
    return false;
  }

  // 真实点击：派发完整事件序列，兼容 React 合成事件（部分组件监听 mousedown/click）
  function realClick(el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    // 注意：不传 view 字段。油猴沙箱的 window 与页面真实 window 不一致，
    // 传 view:window 会导致 "Failed to convert value to 'window'" 报错。
    const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 };
    const dispatch = function (Type, name) {
      try { el.dispatchEvent(new Type(name, opts)); } catch (e) { /* 降级 */ }
    };
    let PE = window.PointerEvent;
    dispatch(PE || MouseEvent, PE ? 'pointerdown' : 'mousedown');
    dispatch(MouseEvent, 'mousedown');
    if (PE) dispatch(PE, 'pointerup');
    dispatch(MouseEvent, 'mouseup');
    dispatch(MouseEvent, 'click');
    // 兜底：原生 click
    try { el.click(); } catch (e) {}
  }

  /* ======================== 结果检测 ======================== */
  // 返回命中的失败关键词（证据），未命中返回 null
  function matchFailKeyword(text) {
    if (!text) return null;
    const low = text.toLowerCase();
    for (const kw of failKwLower) {
      if (low.indexOf(kw) !== -1) return kw;
    }
    return null;
  }

  // 启动 MutationObserver 监听新增节点（debounce 300ms 批量扫描，避免高频回调卡顿）
  // 仅在 captureActive（本轮采集期）内计数，避免把无关 DOM 变化误判为本轮反馈
  let moTimer = null;
  let moPending = [];
  function startObserver() {
    stopObserver();
    STATE.observer = new MutationObserver(function (mutations) {
      if (!STATE.captureActive) return; // 非采集期忽略，防止误报
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) moPending.push(node);
        }
      }
      if (moPending.length && !moTimer) {
        moTimer = setTimeout(function () {
          moTimer = null;
          const nodes = moPending.splice(0, 50);
          for (const node of nodes) {
            const txt = node.textContent || '';
            const hit = matchFailKeyword(txt);
            if (hit) {
              STATE.roundFailed = true;
              STATE.roundDomHit = hit; // 记录命中的具体关键词作为证据
              break;
            }
          }
        }, 300);
      }
    });
    STATE.observer.observe(document.body, { childList: true, subtree: true });
  }
  function stopObserver() {
    if (STATE.observer) { STATE.observer.disconnect(); STATE.observer = null; }
    if (moTimer) { clearTimeout(moTimer); moTimer = null; }
    moPending = [];
  }

  /* ======================== 点击循环 ======================== */
  function randJitter() {
    // ±jitter 秒，均匀分布
    const j = CONFIG.jitterSec;
    return (Math.random() * 2 - 1) * j * 1000;
  }

  function scheduleNext() {
    if (!STATE.running) return;
    const now = Date.now();
    const base = CONFIG.intervalSec * 1000;
    const jitter = randJitter();
    // 间隔从「上次点击时刻」算起，而非从「响应结束时刻」算起
    // 这样响应快时严格保持 10s 节奏；响应慢时也不会在上一个响应没回来时抢点
    const minBuffer = 800; // 响应结束后至少留 800ms 给页面状态更新
    const fromClick = STATE.lastClickTime + base + jitter; // 从点击时刻起算的目标时间
    const fromNow = now + minBuffer;                       // 至少等 800ms 缓冲
    const targetTime = Math.max(fromClick, fromNow);
    const delay = Math.max(500, targetTime - now);
    STATE.nextClickAt = targetTime;
    // 日志透明化：显示响应耗时和实际下次点击延迟
    const respMs = STATE.roundEndTime - STATE.lastClickTime;
    const remain = Math.round(delay / 100) / 10;
    log('第 ' + STATE.attempts + ' 次：响应耗时 ' + (respMs > 0 ? (Math.round(respMs / 100) / 10) + 's' : '?') + '，' + (delay < base ? '间隔已到，' : '需等待间隔，') + '下次点击 ' + remain + 's 后', 'info');
    STATE.timer = setTimeout(performRound, delay);
  }

  function performRound() {
    if (!STATE.running || STATE.success) return;

    // 成功判定 1：URL 已离开活动页 → 跳到下单/支付页
    if (!CONFIG.activityUrlPattern.test(location.href)) {
      onSuccess();
      return;
    }

    STATE.attempts++;
    STATE.roundFailed = false;
    STATE.lastClickTime = Date.now();
    renderStatus();

    const btn = findTargetButton();
    if (!btn) {
      // 按钮找不到：可能页面加载中或已跳转
      if (!CONFIG.activityUrlPattern.test(location.href)) {
        onSuccess();
        return;
      }
      log('第 ' + STATE.attempts + ' 次：未找到 ' + CONFIG.targetPlan + ' 订阅按钮，等待页面就绪', 'fail');
      STATE.lastResult = '未找到按钮';
      renderStatus();
      finishRound();
      return;
    }

    if (isButtonDisabled(btn)) {
      log('第 ' + STATE.attempts + ' 次：按钮已禁用（无货），继续重试', 'fail');
      STATE.lastResult = '无货(按钮禁用)';
      renderStatus();
      finishRound();
      return;
    }

    // 点击（完整事件序列，兼容 React 合成事件）
    log('第 ' + STATE.attempts + ' 次：点击 ' + CONFIG.targetPlan + ' 按钮 <' + btn.tagName + ' class="' + (btn.className || '').slice(0, 60) + '">', 'ok');

    // 开启本轮响应采集（捕获点击触发的网络请求及其响应体）
    STATE.captureActive = true;
    STATE.roundResponses = [];
    STATE.roundDomHit = null;
    STATE.roundFailed = false;

    try { realClick(btn); } catch (e) { log('点击异常: ' + e.message, 'fail'); }
    STATE.lastResult = '已点击，等待服务器响应...';
    renderStatus();

    // 在检测窗口内等待结果（600ms 步进，DOM/验证码扫描每 3 次才跑，降低开销）
    let waited = 0;
    let tick = 0;
    const step = 600;
    const check = setInterval(function () {
      waited += step; tick++;
      // 成功判定 1：URL 跳转
      if (!CONFIG.activityUrlPattern.test(location.href)) {
        clearInterval(check);
        STATE.captureActive = false;
        onSuccess();
        return;
      }
      // 判定 2：扫描服务器响应体（轻量，每次都跑，只扫已过滤的少量相关响应）
      const respScan = scanResponses();
      if (respScan.result === 'success') {
        clearInterval(check);
        STATE.captureActive = false;
        log('第 ' + STATE.attempts + ' 次：✅ 成功！服务器响应含「' + respScan.hit.kw + '」（URL: ' + shortUrl(respScan.hit.url) + '）', 'ok');
        onSuccess();
        return;
      }
      if (respScan.result === 'fail') {
        clearInterval(check);
        STATE.captureActive = false;
        STATE.roundFailed = true;
        STATE.lastResult = '无货：服务器返回「' + respScan.hit.kw + '」';
        log('第 ' + STATE.attempts + ' 次：无货。服务器响应含「' + respScan.hit.kw + '」（URL: ' + shortUrl(respScan.hit.url) + '），继续重试', 'fail');
        renderStatus();
        finishRound();
        return;
      }
      // 判定 3：DOM 弹窗 + 验证码（重扫描，每 3 次 tick 跑一次，约 1.8s）
      if (tick % 3 === 0) {
        // observer 命中（本轮采集期内新增的含失败关键词节点）
        if (STATE.roundDomHit) {
          clearInterval(check);
          STATE.captureActive = false;
          STATE.roundFailed = true;
          STATE.lastResult = '无货：页面弹窗「' + STATE.roundDomHit + '」';
          log('第 ' + STATE.attempts + ' 次：无货。页面弹窗含「' + STATE.roundDomHit + '」（点击后新出现的 DOM），继续重试', 'fail');
          renderStatus();
          finishRound();
          return;
        }
        // 主动扫描可见弹窗（兜底）
        const domHit = scanForFailTextHit();
        if (domHit) {
          clearInterval(check);
          STATE.captureActive = false;
          STATE.roundFailed = true;
          STATE.lastResult = '无货：页面弹窗「' + domHit + '」';
          log('第 ' + STATE.attempts + ' 次：无货。页面可见弹窗含「' + domHit + '」，继续重试', 'fail');
          renderStatus();
          finishRound();
          return;
        }
        const captcha = detectCaptcha();
        if (captcha) {
          clearInterval(check);
          STATE.captureActive = false;
          STATE.lastResult = '弹出验证码，需人工处理';
          log('第 ' + STATE.attempts + ' 次：⚠ 检测到验证码弹层(' + captcha + ')，请手动过验证码', 'fail');
          renderStatus();
          finishRound();
          return;
        }
      }
      if (waited >= CONFIG.detectWindowMs) {
        clearInterval(check);
        STATE.captureActive = false;
        const n = STATE.roundResponses.length;
        if (n > 0) {
          // 有响应但无关键词——把响应片段显示出来，方便你判断真实情况
          const sample = STATE.roundResponses[0];
          const bodySnippet = (sample.body || '').slice(0, 120).replace(/\s+/g, ' ');
          STATE.lastResult = '收到' + n + '个响应但无已知关键词';
          log('第 ' + STATE.attempts + ' 次：收到 ' + n + ' 个相关响应，但未命中成功/失败关键词。示例: [' + sample.status + '] ' + shortUrl(sample.url) + ' body="' + bodySnippet + '..."，继续下一轮', 'info');
        } else {
          STATE.lastResult = '本轮无任何相关响应';
          log('第 ' + STATE.attempts + ' 次：未捕获到任何下单相关网络响应（可能点击未触发请求，或请求URL不在过滤词内），继续下一轮', 'info');
        }
        renderStatus();
        finishRound();
      }
    }, step);
  }

  // 截短 URL 用于日志显示
  function shortUrl(url) {
    if (!url) return '?';
    const s = String(url);
    return s.length > 70 ? s.slice(0, 70) + '...' : s;
  }

  // 扫描可见弹窗，返回命中的关键词（证据），未命中返回 null
  function scanForFailTextHit() {
    const containers = document.querySelectorAll(
      '[class*="arco-message"], [class*="arco-notification"], [class*="arco-modal"], [role="alert"]'
    );
    for (const c of containers) {
      if (!visibleFast(c)) continue;
      const hit = matchFailKeyword(c.textContent);
      if (hit) return hit;
    }
    return null;
  }

  function finishRound() {
    if (!STATE.running) return;
    STATE.roundEndTime = Date.now(); // 记录本轮响应检测结束时间，供 scheduleNext 计算用
    // 达到最大次数
    if (CONFIG.maxAttempts > 0 && STATE.attempts >= CONFIG.maxAttempts) {
      log('已达到最大尝试次数 ' + CONFIG.maxAttempts + '，停止', 'info');
      stop(true);
      return;
    }
    scheduleNext();
  }

  /* ======================== 成功处理 ======================== */
  function onSuccess() {
    if (STATE.success) return;
    STATE.success = true;
    STATE.lastResult = '抢购成功！请手动完成支付';
    log('🎉 抢购成功！已跳转，请立即手动完成支付', 'ok');
    stop(false); // 不清除断点标志由 stop 处理
    highlightPage();
    beep();
    setTimeout(function () {
      alert('【' + CONFIG.targetPlan + ' 抢购成功】\n\n已检测到页面跳转，请立即手动完成支付！\n\n脚本已停止点击。');
    }, 300);
  }

  // 红色边框闪烁高亮
  function highlightPage() {
    let flash = document.createElement('div');
    flash.id = 'vcp-flash';
    flash.style.cssText = 'position:fixed;inset:0;border:6px solid #e53935;z-index:2147483646;pointer-events:none;animation:vcp-flash-anim 1s ease-in-out 6;';
    document.body.appendChild(flash);
  }

  // 蜂鸣声（Web Audio，3 声短促）
  function beep() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      function tone(t, freq) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.001, t);
        gain.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(t); osc.stop(t + 0.26);
      }
      const now = ctx.currentTime;
      tone(now, 880); tone(now + 0.3, 880); tone(now + 0.6, 1100);
    } catch (e) { /* 忽略 */ }
  }

  /* ======================== 启停控制 ======================== */
  function start() {
    if (STATE.running) return;
    STATE.running = true;
    STATE.success = false;
    STORE.running = true;
    startObserver();
    startCountdown();
    log('开始抢购 ' + CONFIG.targetPlan + '（间隔 ' + CONFIG.intervalSec + 's ± ' + CONFIG.jitterSec + 's）', 'ok');
    STATE.lastResult = '运行中';
    renderStatus();
    // 立即执行第一轮
    performRound();
  }

  function stop(manual) {
    STATE.running = false;
    STORE.running = false;
    if (STATE.timer) { clearTimeout(STATE.timer); STATE.timer = null; }
    stopCountdown();
    stopObserver();
    if (manual) {
      STATE.lastResult = '已停止';
      log('已手动停止', 'info');
    }
    renderStatus();
    renderButtons();
  }

  /* ======================== UI 面板 ======================== */
  GM_addStyle('\
    #vcp-panel { position:fixed; top:16px; right:16px; z-index:2147483647; width:300px; \
      background:#fff; border:1px solid #e0e0e0; border-radius:10px; \
      box-shadow:0 4px 20px rgba(0,0,0,0.15); font-family:-apple-system,"Microsoft YaHei",sans-serif; \
      font-size:13px; color:#333; user-select:none; } \
    #vcp-panel .vcp-head { padding:10px 14px; background:linear-gradient(135deg,#1e88e5,#1565c0); \
      color:#fff; border-radius:10px 10px 0 0; cursor:move; font-weight:600; display:flex; justify-content:space-between; align-items:center; } \
    #vcp-panel .vcp-head .vcp-title { font-size:13px; } \
    #vcp-panel .vcp-body { padding:12px 14px; } \
    #vcp-panel .vcp-row { display:flex; align-items:center; justify-content:space-between; margin:7px 0; } \
    #vcp-panel .vcp-row label { color:#666; } \
    #vcp-panel input[type=number] { width:64px; padding:3px 6px; border:1px solid #ddd; border-radius:5px; text-align:center; } \
    #vcp-panel select { padding:3px 6px; border:1px solid #ddd; border-radius:5px; font-size:13px; } \
    #vcp-panel .vcp-btns { display:flex; gap:8px; margin:10px 0; } \
    #vcp-panel button { flex:1; padding:8px 0; border:none; border-radius:6px; cursor:pointer; font-size:13px; font-weight:600; } \
    #vcp-panel .vcp-start { background:#43a047; color:#fff; } \
    #vcp-panel .vcp-start:disabled { background:#bdbdbd; cursor:not-allowed; } \
    #vcp-panel .vcp-stop { background:#e53935; color:#fff; } \
    #vcp-panel .vcp-stop:disabled { background:#bdbdbd; cursor:not-allowed; } \
    #vcp-panel .vcp-status { background:#f5f5f5; border-radius:6px; padding:8px 10px; margin:8px 0; line-height:1.7; } \
    #vcp-panel .vcp-status .vcp-k { color:#999; } \
    #vcp-panel .vcp-status .vcp-v { color:#333; font-weight:600; } \
    #vcp-panel .vcp-log { height:130px; overflow-y:auto; background:#fafafa; border:1px solid #eee; \
      border-radius:6px; padding:6px 8px; font-family:Consolas,Monaco,monospace; font-size:11px; line-height:1.5; } \
    #vcp-panel .vcp-log .vcp-l-fail { color:#e53935; } \
    #vcp-panel .vcp-log .vcp-l-ok { color:#43a047; } \
    #vcp-panel .vcp-log .vcp-l-info { color:#1e88e5; } \
    #vcp-panel .vcp-log::-webkit-scrollbar { width:6px; } \
    #vcp-panel .vcp-log::-webkit-scrollbar-thumb { background:#ccc; border-radius:3px; } \
    @keyframes vcp-flash-anim { 0%,100%{opacity:0;} 50%{opacity:1;} } \
  ');

  function buildPanel() {
    if (document.getElementById('vcp-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'vcp-panel';
    panel.innerHTML = '\
      <div class="vcp-head" id="vcp-head">\
        <span class="vcp-title" id="vcp-title">抢购助手</span>\
        <span style="font-size:11px;opacity:0.85;">v1.3.0</span>\
      </div>\
      <div class="vcp-body">\
        <div class="vcp-row"><label>抢购版本</label><select id="vcp-plan"><option value="Lite Plan">Lite Plan (9.9元)</option><option value="Pro Plan">Pro Plan</option></select></div>\
        <div class="vcp-row"><label>间隔（秒）</label><input id="vcp-interval" type="number" min="1" value="' + CONFIG.intervalSec + '"></div>\
        <div class="vcp-row"><label>抖动（秒）</label><input id="vcp-jitter" type="number" min="0" value="' + CONFIG.jitterSec + '"></div>\
        <div class="vcp-row"><label>最大次数（0=无限）</label><input id="vcp-max" type="number" min="0" value="' + CONFIG.maxAttempts + '"></div>\
        <div class="vcp-btns">\
          <button class="vcp-start" id="vcp-btn-start">开始抢购</button>\
          <button class="vcp-stop" id="vcp-btn-stop" disabled>停止</button>\
        </div>\
        <div class="vcp-status" id="vcp-status"></div>\
        <div class="vcp-log" id="vcp-log"></div>\
      </div>';
    document.body.appendChild(panel);

    // 初始化下拉框默认值
    document.getElementById('vcp-plan').value = CONFIG.targetPlan;
    document.getElementById('vcp-title').textContent = CONFIG.targetPlan + ' 抢购助手';

    document.getElementById('vcp-btn-start').addEventListener('click', onStartClick);
    document.getElementById('vcp-btn-stop').addEventListener('click', function () { stop(true); });
    document.getElementById('vcp-plan').addEventListener('change', function (e) {
      CONFIG.targetPlan = e.target.value;
      document.getElementById('vcp-title').textContent = CONFIG.targetPlan + ' 抢购助手';
      log('目标改为 ' + CONFIG.targetPlan, 'info');
    });
    document.getElementById('vcp-interval').addEventListener('change', function (e) {
      const v = parseInt(e.target.value, 10);
      if (v >= 1) { CONFIG.intervalSec = v; log('间隔改为 ' + v + 's', 'info'); }
    });
    document.getElementById('vcp-jitter').addEventListener('change', function (e) {
      const v = Math.max(0, parseInt(e.target.value, 10));
      CONFIG.jitterSec = v; log('抖动改为 ±' + v + 's', 'info');
    });
    document.getElementById('vcp-max').addEventListener('change', function (e) {
      const v = Math.max(0, parseInt(e.target.value, 10));
      CONFIG.maxAttempts = v; log('最大次数改为 ' + (v === 0 ? '无限' : v), 'info');
    });

    makeDraggable(panel, document.getElementById('vcp-head'));
  }

  function onStartClick() {
    // 读取面板最新值
    CONFIG.targetPlan = document.getElementById('vcp-plan').value || 'Lite Plan';
    CONFIG.intervalSec = Math.max(1, parseInt(document.getElementById('vcp-interval').value, 10) || 10);
    CONFIG.jitterSec = Math.max(0, parseInt(document.getElementById('vcp-jitter').value, 10) || 0);
    CONFIG.maxAttempts = Math.max(0, parseInt(document.getElementById('vcp-max').value, 10) || 0);
    start();
    renderButtons();
  }

  function renderButtons() {
    const s = document.getElementById('vcp-btn-start');
    const t = document.getElementById('vcp-btn-stop');
    if (s) s.disabled = STATE.running;
    if (t) t.disabled = !STATE.running;
  }

  function renderStatus() {
    const el = document.getElementById('vcp-status');
    if (!el) return;
    const stateText = STATE.success ? '抢购成功' : (STATE.running ? '运行中' : '已停止');
    const stateColor = STATE.success ? '#43a047' : (STATE.running ? '#1e88e5' : '#999');
    el.innerHTML =
      '<div><span class="vcp-k">状态：</span><span class="vcp-v" style="color:' + stateColor + '">' + stateText + '</span></div>' +
      '<div><span class="vcp-k">尝试次数：</span><span class="vcp-v">' + STATE.attempts + '</span></div>' +
      '<div><span class="vcp-k">下次点击：</span><span class="vcp-v" id="vcp-cd">—</span></div>' +
      '<div><span class="vcp-k">上次结果：</span><span class="vcp-v" style="font-size:11px;">' + escapeHtml(STATE.lastResult) + '</span></div>';
    renderButtons();
  }

  function renderLog() {
    const el = document.getElementById('vcp-log');
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    el.innerHTML = logs.map(function (l) {
      return '<div class="vcp-l-' + (l.type || 'info') + '">' + escapeHtml(l.line) + '</div>';
    }).join('');
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 倒计时刷新：低频 setInterval，只更新倒计时 span，不重建状态区（避免卡顿）
  function startCountdown() {
    stopCountdown();
    STATE.cdTimer = setInterval(function () {
      const cd = document.getElementById('vcp-cd');
      if (!cd) return;
      if (STATE.running && STATE.nextClickAt && !STATE.success) {
        cd.textContent = Math.max(0, Math.ceil((STATE.nextClickAt - Date.now()) / 1000)) + 's';
      } else {
        cd.textContent = '—';
      }
    }, 500);
  }
  function stopCountdown() {
    if (STATE.cdTimer) { clearInterval(STATE.cdTimer); STATE.cdTimer = null; }
  }

  // 拖拽
  function makeDraggable(panel, handle) {
    let dragging = false, ox = 0, oy = 0;
    handle.addEventListener('mousedown', function (e) {
      dragging = true;
      const rect = panel.getBoundingClientRect();
      ox = e.clientX - rect.left; oy = e.clientY - rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      let x = e.clientX - ox, y = e.clientY - oy;
      x = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, x));
      y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, y));
      panel.style.left = x + 'px'; panel.style.top = y + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', function () { dragging = false; });
  }

  /* ======================== 初始化 ======================== */
  function init() {
    const onActivityPage = CONFIG.activityUrlPattern.test(location.href);

    // 在非活动页（如下单/控制台页）：若是从抢购跳转过来的，提醒成功；否则静默
    if (!onActivityPage) {
      if (STORE.running) {
        STORE.running = false;
        onSuccess();
      }
      return;
    }

    // 活动页：显示面板，默认停止状态，绝不自动开始（需手动点「开始抢购」）
    STORE.running = false;
    installNetHook(); // 提前装好网络钩子，仅诊断模式开启时才记录
    buildPanel();
    renderStatus();
    renderLog();
    log('脚本已加载。选版本→点「开始抢购」即可（自动读取服务器响应判断有无货）', 'info');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
