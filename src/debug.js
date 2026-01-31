export class Debugger {
  /**
   * @param {Object} config - { DEBUG_SAMPLE_RATE }
   */
  constructor(config) {
    this.sampleRate = config.DEBUG_SAMPLE_RATE || 0.1;
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
      const timing = this.buildServerTiming(metrics);
      resHeaders.set('Server-Timing', timing);
      console.log(`[PERF] ${context.method} ${context.pathname} | Status: ${context.status} | ${timing}`);
    }
  }
}
