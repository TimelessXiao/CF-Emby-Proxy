// 截断常量
const TRUNCATE_LIMITS = {
  URL: 512,
  LOCATION: 512,
  UA: 256,
  HEADER_VALUE: 512,
  ERROR_MESSAGE: 512,
  ERROR_STACK: 2048
}

// 敏感 header 名（小写）
const REDACT_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie',
  'x-emby-token', 'x-mediabrowser-token', 'x-api-key'
])

// 敏感 query 参数（小写）
const REDACT_PARAMS = new Set([
  'api_key', 'token', 'x-emby-token', 'x-mediabrowser-token'
])

/**
 * 中间省略号截断
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
function truncateMiddle(str, maxLen) {
  if (typeof str !== 'string') return str
  if (str.length <= maxLen) return str
  const keep = Math.floor((maxLen - 1) / 2)
  return str.slice(0, keep) + '…' + str.slice(-keep)
}

/**
 * 脱敏：保留前4+后4字符，中间***
 * @param {string} str
 * @returns {string}
 */
function redactValue(str) {
  if (typeof str !== 'string') return str
  if (str.length <= 8) return '***'
  return str.slice(0, 4) + '***' + str.slice(-4)
}

export class Debugger {
  /**
   * @param {Object} config - { DEBUG_SAMPLE_RATE, DEBUG_LOG_NON_2XX, DEBUG_LOG_REDACT }
   */
  constructor(config) {
    this.sampleRate = config.DEBUG_SAMPLE_RATE || 0.1
    this.logNon2xx = config.DEBUG_LOG_NON_2XX === true || config.DEBUG_LOG_NON_2XX === 'true'
    this.redact = config.DEBUG_LOG_REDACT !== false && config.DEBUG_LOG_REDACT !== 'false'
  }

  /**
   * 判断是否应该记录日志
   * @param {string} kind - 请求类型 (media/range/m3u8/playbackinfo/api)
   * @param {boolean} isVideo - 是否为视频请求
   * @param {boolean} hasRange - 是否为 Range 请求
   * @returns {boolean}
   */
  shouldLog(kind, isVideo, hasRange) {
    // 媒体请求永远记录,其他请求按采样率
    return (isVideo || hasRange) || (Math.random() < this.sampleRate);
  }

  /**
   * 构建 Server-Timing 字符串
   * @param {Object} metrics - { kind, kvReadMs, cacheHit, upstreamMs, retryCount, subreqCount, playerHint }
   * @returns {string}
   */
  buildServerTiming(metrics) {
    const { kind, kvReadMs, cacheHit, upstreamMs, retryCount, subreqCount, playerHint } = metrics;
    const clientClass = 'client';
    const playerClass = playerHint || 'na';

    return [
      `kind;desc="${kind}"`,
      `client;desc="${clientClass}"`,
      `player_hint;desc="${playerClass}"`,
      `kv_read;dur=${kvReadMs}`,
      `cache_hit;desc="${cacheHit}"`,
      `upstream;dur=${upstreamMs}`,
      `retry;desc="${retryCount}"`,
      `subreq;desc="${subreqCount}"`
    ].join(', ');
  }

  /**
   * 注入 Server-Timing 头和控制台日志
   * @param {Headers} resHeaders - 响应头对象
   * @param {Object} metrics - 性能指标
   * @param {Object} context - 请求上下文 { method, pathname, status, isVideo, hasRange }
   */
  inject(resHeaders, metrics, context) {
    if (this.shouldLog(metrics.kind, context.isVideo, context.hasRange)) {
      const timing = this.buildServerTiming(metrics)
      resHeaders.set('Server-Timing', timing)
      console.log(`[PERF] ${context.method} ${context.pathname} | Status: ${context.status} | ${timing}`)
    }
  }

  /**
   * Headers 转普通对象（带脱敏/截断）
   * @param {Headers} headers
   * @returns {Object}
   */
  headersToObject(headers) {
    if (!headers) return {}
    const obj = {}
    for (const [k, v] of headers.entries()) {
      const lk = k.toLowerCase()
      if (this.redact && REDACT_HEADERS.has(lk)) {
        obj[k] = redactValue(v)
      } else {
        obj[k] = truncateMiddle(v, TRUNCATE_LIMITS.HEADER_VALUE)
      }
    }
    return obj
  }

  /**
   * URL 脱敏+截断
   * @param {string} urlStr
   * @returns {string}
   */
  sanitizeUrl(urlStr) {
    try {
      const u = new URL(urlStr)
      if (this.redact) {
        for (const key of u.searchParams.keys()) {
          if (REDACT_PARAMS.has(key.toLowerCase())) {
            u.searchParams.set(key, redactValue(u.searchParams.get(key)))
          }
        }
      }
      return truncateMiddle(u.toString(), TRUNCATE_LIMITS.URL)
    } catch {
      return truncateMiddle(urlStr, TRUNCATE_LIMITS.URL)
    }
  }

  /**
   * 详细日志输出（非2xx/异常时调用）
   * @param {Object} ctx - { req, res, metrics, context, error, env }
   */
  logDetailed(ctx) {
    const { req, res, metrics, context, error, env } = ctx
    const status = res?.status || 0

    // 确定日志级别
    let logFn = console.log
    if (error || status >= 500) logFn = console.error
    else if (status >= 400) logFn = console.warn

    // 构建日志 payload
    const payload = {
      ts: new Date().toISOString(),
      traceId: req?.headers?.get?.('cf-ray') || null,
      envFlags: env ? {
        DEBUG: env.DEBUG,
        DEBUG_LOG_NON_2XX: env.DEBUG_LOG_NON_2XX,
        DEBUG_LOG_REDACT: env.DEBUG_LOG_REDACT
      } : undefined
    }

    // 请求侧
    if (req) {
      let urlParts = null
      try {
        const url = new URL(req.url)
        urlParts = {
          hostname: url.hostname,
          pathname: truncateMiddle(url.pathname, 256),
          search: truncateMiddle(url.search, 256)
        }
      } catch (_) {
        urlParts = { hostname: null, pathname: null, search: null }
      }
      payload.req = {
        method: req.method,
        url: this.sanitizeUrl(req.url),
        urlParts,
        headers: this.headersToObject(req.headers),
        ua: truncateMiddle(req.headers?.get?.('user-agent') || '', TRUNCATE_LIMITS.UA),
        range: req.headers?.get?.('range') || null
      }
    }

    // 响应侧
    if (res) {
      payload.res = {
        status: status,
        headers: this.headersToObject(res.headers)
      }
      if (status >= 300 && status < 400) {
        payload.res.location = truncateMiddle(res.headers?.get?.('location') || '', TRUNCATE_LIMITS.LOCATION)
      }
    }

    // 性能指标
    if (metrics) {
      payload.perf = metrics
    }

    // 上下文
    if (context) {
      payload.ctx = context
    }

    // 错误信息
    if (error) {
      payload.err = {
        name: error.name || 'Error',
        message: truncateMiddle(error.message || String(error), TRUNCATE_LIMITS.ERROR_MESSAGE),
        stack: truncateMiddle(error.stack || '', TRUNCATE_LIMITS.ERROR_STACK)
      }
    }

    // 输出单行 JSON
    try {
      logFn(JSON.stringify(payload))
    } catch (e) {
      // 序列化失败时回退
      logFn(`[DEBUG_DETAIL] status=${status} error=${error?.message || 'none'}`)
    }
  }
}
