# Proposal: CF Worker Streaming Optimization

**Change ID**: `cf-worker-streaming-optimization`
**Status**: Research Complete - Awaiting Implementation
**Created**: 2026-01-27
**Priority**: P0 (Critical Performance Issues)

---

## Context

### Problem Statement

The CF-Emby-Proxy Worker experiences three critical performance issues affecting user experience:

1. **Slow playback startup**: Initial buffering takes too long
2. **Throughput ramp-up**: Playback rate slowly climbs from 0.0 KB/s
3. **Occasional stuttering**: Intermittent buffering during playback

These issues stem from suboptimal timeout/retry logic, connection management, and CPU-intensive operations that violate Cloudflare Workers Free plan constraints.

### Current State

**Architecture**:
- Single-file Cloudflare Worker (~800 lines)
- Hono framework for routing
- KV-backed dynamic routing with in-memory cache
- Micro-caching for API/m3u8 (2-10s TTL)
- Streaming passthrough for media

**Deployment**:
- Cloudflare Workers Free plan
- Route: `*.abc.com/*`
- Overseas Emby upstream (uncontrollable)
- Priority clients: Android TV, iOS/Android, PC native clients

**Constraints** (Hard limits from Free plan):
- CPU time: 10ms per request
- Memory: 128MB per isolate
- Subrequests: 50 per request
- Concurrent connections: 6 per invocation
- KV quota: 100k reads/day, 1k writes/day
- Request quota: 100k/day, 1000/min burst

### Root Cause Analysis

**Issue 1: Hidden Double-Request Penalty**
- Location: `worker.js:162-165, 182-186`
- Pattern: `fetchWithTimeout()` aborts on timeout, then immediately retries
- Impact: Every timeout = 2 upstream requests, wasting quota and capacity
- Evidence: Codex analysis identified "timeout abort then immediate retry without backoff"

**Issue 2: Forced Connection Termination**
- Location: `worker.js:1001-1002`
- Pattern: Non-Android TV video streams forced `Connection: close`
- Impact: Repeated TLS handshakes cause throughput to ramp slowly from 0
- Evidence: Codex analysis noted "Connection: close may increase connection churn and CPU"

**Issue 3: Unnecessary CPU-Intensive Hashing**
- Location: `worker.js:880` (buildTokenKey called for all requests)
- Pattern: SHA-256 hash computed for every request including media
- Impact: Wastes precious 10ms CPU budget on requests that don't need cache keys
- Evidence: Codex analysis identified "Token/body hashing on every request adds CPU overhead"

---

## Requirements

### Functional Requirements

#### FR-1: Eliminate Double-Request Penalty
**Priority**: P0
**Rationale**: Directly causes slow startup and wastes request quota

**Scenarios**:
- **Scenario 1.1**: PlaybackInfo request to overseas upstream takes 4s
  - Current: Timeout at 2.5s → abort → retry → total 6.5s + 2 requests
  - Required: Single request with 8s timeout → total 4s + 1 request

- **Scenario 1.2**: m3u8 playlist request takes 3s
  - Current: Timeout at 2.5s → abort → retry → total 5.5s + 2 requests
  - Required: Single request with 8s timeout → total 3s + 1 request

**Acceptance Criteria**:
- ✅ Critical paths (PlaybackInfo, m3u8, Items/Resume) use extended timeout (8-10s)
- ✅ No retry after timeout for critical paths
- ✅ Media/Range requests never timeout or retry
- ✅ Subrequest count per request ≤ 5 (well below 50 limit)

#### FR-2: Enable Connection Reuse for All Clients
**Priority**: P0
**Rationale**: Directly causes throughput ramp-up issue

**Scenarios**:
- **Scenario 2.1**: Non-Android TV client requests video segment
  - Current: Response includes `Connection: close` → client closes connection → next segment requires new TLS handshake → throughput ramps slowly
  - Required: No forced connection termination → client reuses connection → immediate full throughput

- **Scenario 2.2**: Android TV client requests video segment
  - Current: Response includes `Connection: keep-alive` → works well
  - Required: Maintain current behavior (no regression)

**Acceptance Criteria**:
- ✅ Remove forced `Connection: close` for all video streams
- ✅ Preserve Android TV keep-alive hints
- ✅ Do not set hop-by-hop headers that break connection reuse
- ✅ Throughput reaches maximum immediately (no 0→slow ramp)

#### FR-3: Skip CPU-Intensive Operations for Media
**Priority**: P0
**Rationale**: Violates 10ms CPU budget constraint

**Scenarios**:
- **Scenario 3.1**: Video segment request (no caching needed)
  - Current: Calls `buildTokenKey()` → `sha256Hex()` → wastes ~1-2ms CPU
  - Required: Skip hash computation entirely → save CPU for upstream wait

- **Scenario 3.2**: Range request (no caching needed)
  - Current: Calls `buildTokenKey()` → `sha256Hex()` → wastes CPU
  - Required: Skip hash computation entirely

- **Scenario 3.3**: PlaybackInfo POST (caching needed)
  - Current: Computes tokenHash + bodyHash → necessary overhead
  - Required: Maintain current behavior (hash needed for cache key)

**Acceptance Criteria**:
- ✅ Media requests (isVideo=true) skip `buildTokenKey()` call
- ✅ Range requests (hasRange=true) skip `buildTokenKey()` call
- ✅ Non-media cacheable requests still compute hash
- ✅ CPU time for media requests < 5ms (mostly waiting for upstream)

#### FR-4: Optimize KV Empty-State Caching
**Priority**: P1
**Rationale**: Improves first-publish visibility without breaking existing system

**Scenarios**:
- **Scenario 4.1**: First deployment with no routes configured
  - Current: Empty mapping cached for 60s → first publish invisible for up to 60s
  - Required: Empty mapping cached for 5-10s → first publish visible within 10s

- **Scenario 4.2**: Normal operation with routes configured
  - Current: Route mappings cached for 60s → works well
  - Required: Maintain 60s TTL for non-empty state (no regression)

**Acceptance Criteria**:
- ✅ Empty pointer state uses reduced TTL (5-10s)
- ✅ Non-empty state maintains 60s TTL
- ✅ No increase in KV read quota usage
- ✅ Existing KV routing logic preserved (micro-adjustment only)

### Non-Functional Requirements

#### NFR-1: Cloudflare Workers Free Plan Compliance
**Priority**: P0
**Constraints**:
- CPU time ≤ 10ms per request (excluding upstream wait)
- Memory usage ≤ 128MB per isolate
- Subrequests ≤ 50 per request (target: ≤ 10)
- Concurrent connections ≤ 6 per invocation
- KV reads ≤ 100k/day (target: ≤ 50k/day)
- Request quota ≤ 100k/day, 1000/min burst

**Verification**:
- Add DEBUG mode with Server-Timing headers
- Monitor: kv_read_ms, cache_hit, upstream_ms, retry_count, subreq_count

#### NFR-2: Streaming Passthrough Preservation
**Priority**: P0
**Constraints**:
- STRICTLY PROHIBIT buffering media response bodies
- Range requests must preserve byte-range semantics
- WebSocket connections must pass through unchanged
- No transformation or accumulation of streaming data

**Verification**:
- Verify Response.body is passed directly (not read/cloned)
- Test Range requests return correct byte ranges
- Test large video files stream without memory growth

#### NFR-3: Cross-User Isolation
**Priority**: P0
**Constraints**:
- Cache keys must be token-aware for all cached content
- No cross-user data leakage via cache
- Anonymous requests use 'anon:nodev' fallback

**Verification**:
- Test with different tokens → different cache entries
- Test anonymous requests → separate cache namespace
- Audit all cache key generation logic

#### NFR-4: Backward Compatibility
**Priority**: P1
**Constraints**:
- Preserve existing KV routing behavior
- Preserve /manage admin interface functionality
- No breaking changes to cache key format (would invalidate existing cache)
- Maintain support for all current client types

**Verification**:
- Test dynamic routing still works
- Test /manage CRUD operations
- Test Android TV, iOS, PC clients

---

## Success Criteria

### Quantitative Metrics

**Startup Performance**:
- ✅ PlaybackInfo TTFB: < 500ms (cached) or < 4s (uncached, down from 6.5s)
- ✅ m3u8 TTFB: < 200ms (cached) or < 3s (uncached, down from 5.5s)
- ✅ First frame time: < 2s (down from 4-6s)

**Throughput Stability**:
- ✅ Video segment throughput: Immediate maximum (no ramp-up period)
- ✅ Connection reuse rate: > 80% for multi-segment playback
- ✅ TLS handshake count: Reduced by 70-90% for non-Android TV

**Resource Efficiency**:
- ✅ Media request CPU time: < 5ms (down from 7-10ms)
- ✅ KV reads per request: ≤ 1 (cached routing)
- ✅ Subrequests per request: ≤ 5 (down from potential 10+)
- ✅ Request quota usage: Reduced by 30-50% (no double-fetch)

### Qualitative Behaviors

**User Experience**:
- ✅ Playback starts immediately without long buffering
- ✅ No "0.0 KB/s slowly climbing" phenomenon
- ✅ Smooth playback without stuttering
- ✅ Consistent experience across Android TV, iOS, PC clients

**Operational**:
- ✅ DEBUG mode provides actionable performance metrics
- ✅ No increase in error rates or edge cases
- ✅ Existing admin/management workflows unchanged
- ✅ First-time deployment route visibility improved

---

## Dependencies

### External Dependencies

**Cloudflare Workers Runtime**
- `caches.default` API for manual caching
- `crypto.subtle` for SHA-256 hashing
- `fetch` with `cf` options for cache control
- `executionCtx.waitUntil` for async operations

**Hono Framework** (v4.11.5)
- Routing and context management
- Cannot be removed without major refactor

**KV Namespace: ROUTE_MAP**
- Dynamic upstream routing
- Versioned document storage
- Must preserve existing data format

**External Emby Upstream**
- Overseas third-party service (uncontrollable)
- Variable latency (2-10s typical)
- Must handle timeouts gracefully

### Internal Dependencies

**Utility Functions** (must preserve):
- `sha256Hex()` - SHA-256 hashing
- `buildTokenKey()` - Cache key generation (optimize usage)
- `subdomainOf()` - Subdomain extraction
- `mappingToBase()` - URL construction

**KV Routing System** (micro-adjust only):
- `loadRouteMappings()` - Route loading with cache
- `publishRouteMappings()` - Route publishing
- `getPointerWithRetry()` - KV pointer reads
- `getVersionDocWithRetry()` - KV doc reads

**Management Interface** (preserve):
- `/manage` admin UI
- `/manage/api/*` CRUD endpoints
- Authentication via ADMIN_TOKEN

---

## Risk Mitigation

### P0 Risks (Critical)

**Risk: Removing Connection: close breaks legacy clients**
- Likelihood: Low
- Impact: High (playback failure)
- Mitigation:
  - Keep Android TV keep-alive hints (proven to work)
  - Remove only forced `close` for non-Android
  - Test with iOS, Android, PC clients before deploy
- Rollback: Revert to per-client connection headers

**Risk: Extended timeout causes request queue buildup**
- Likelihood: Medium
- Impact: Medium (increased latency under load)
- Mitigation:
  - Extended timeout only for critical paths (PlaybackInfo, m3u8)
  - Media/Range still use no timeout (direct passthrough)
  - Monitor request duration via DEBUG mode
- Rollback: Reduce timeout to 5s if queue issues observed

**Risk: Skipping hash breaks cache isolation**
- Likelihood: Very Low
- Impact: Critical (cross-user data leakage)
- Mitigation:
  - Only skip hash for media/Range (never cached)
  - Preserve hash for all cacheable requests
  - Audit all cache key generation paths
  - Add tests for token isolation
- Rollback: Revert to hash all requests

### P1 Risks (High)

**Risk: KV TTL change affects route propagation**
- Likelihood: Low
- Impact: Medium (delayed route updates)
- Mitigation:
  - Only reduce TTL for empty state (5-10s)
  - Preserve 60s TTL for non-empty state
  - No change to KV read/write patterns
- Rollback: Revert to uniform 60s TTL

**Risk: DEBUG mode increases CPU usage**
- Likelihood: Medium
- Impact: Low (only when enabled)
- Mitigation:
  - DEBUG off by default
  - Timing collection uses performance.now() (low overhead)
  - No logging to console (avoids serialization cost)
- Rollback: Remove DEBUG mode if CPU impact observed

---

## Implementation Guidance

### Change Sequencing

**Phase 1: CPU Optimization (Lowest Risk)**
1. Add conditional hash computation
2. Skip `buildTokenKey()` for media/Range requests
3. Verify cache isolation still works
4. Expected impact: 20-30% CPU reduction for media requests

**Phase 2: Connection Management (Medium Risk)**
1. Remove forced `Connection: close` for non-Android video
2. Preserve Android TV keep-alive hints
3. Test with multiple client types
4. Expected impact: Eliminate throughput ramp-up

**Phase 3: Timeout/Retry Refactor (Medium Risk)**
1. Extend timeout for critical paths (8-10s)
2. Remove retry logic for critical paths
3. Keep media/Range as direct passthrough
4. Expected impact: 40-50% reduction in startup time

**Phase 4: KV Optimization (Lowest Risk)**
1. Add conditional TTL for empty state (5-10s)
2. Preserve 60s TTL for non-empty state
3. No change to KV read/write logic
4. Expected impact: Faster first-publish visibility

**Phase 5: Observability (Optional)**
1. Add DEBUG environment variable
2. Implement Server-Timing headers
3. Include: kv_read_ms, cache_hit, upstream_ms, retry_count, subreq_count
4. Expected impact: Better production debugging

### Critical Code Locations

**worker.js:880** - Request classification and hash computation
```javascript
// BEFORE: Always compute hash
const tokenHash = await buildTokenKey(req, url)

// AFTER: Conditional hash computation
const needsCacheKey = !isVideo && !hasRange && (isM3U8 || isPlaybackInfo || isApiCacheable)
const tokenHash = needsCacheKey ? await buildTokenKey(req, url) : null
```

**worker.js:1000-1006** - Connection header management
```javascript
// BEFORE: Force close for non-Android
if (isVideo) {
  if (isAndroidTV) {
    resHeaders.set('Connection', 'keep-alive')
    resHeaders.set('Keep-Alive', 'timeout=30, max=1000')
  } else {
    resHeaders.set('Connection', 'close') // REMOVE THIS
  }
}

// AFTER: Keep-alive for Android TV, no forced close for others
if (isVideo && isAndroidTV) {
  resHeaders.set('Connection', 'keep-alive')
  resHeaders.set('Keep-Alive', 'timeout=30, max=1000')
}
```

**worker.js:162-165, 182-186** - Timeout/retry logic
```javascript
// BEFORE: Timeout then immediate retry
try {
  response = await fetchWithTimeout(targetUrl, fetchOptions, timeout)
} catch (err) {
  response = await fetch(targetUrl, fetchOptions) // REMOVE RETRY
}

// AFTER: Extended timeout, no retry for critical paths
const isCriticalPath = isPlaybackInfo || isM3U8 || isApiCacheable
const timeout = isCriticalPath
  ? (isAndroidTV ? 10000 : 8000)  // Extended for critical paths
  : (isAndroidTV ? 6000 : 2500)   // Normal for others

if (isCriticalPath) {
  // No timeout wrapper, direct fetch with longer wait
  response = await fetch(targetUrl, fetchOptions)
} else {
  // Non-critical can still use timeout, but no retry
  try {
    response = await fetchWithTimeout(targetUrl, fetchOptions, timeout)
  } catch (err) {
    throw err // Propagate error, no retry
  }
}
```

**worker.js:142-147** - KV empty state caching
```javascript
// BEFORE: Uniform 60s TTL
globalThis[ROUTE_CACHE_KEY] = {
  version: null,
  mappings: {},
  expiresAt: now + CONFIG.ROUTE_CACHE_TTL * 1000
}

// AFTER: Reduced TTL for empty state
const ttl = ptr.version ? CONFIG.ROUTE_CACHE_TTL : 10 // 10s for empty, 60s for non-empty
globalThis[ROUTE_CACHE_KEY] = {
  version: null,
  mappings: {},
  expiresAt: now + ttl * 1000
}
```

### Testing Checklist

**Unit Tests**:
- ✅ `buildTokenKey()` not called for isVideo=true
- ✅ `buildTokenKey()` not called for hasRange=true
- ✅ `buildTokenKey()` still called for cacheable requests
- ✅ Empty KV state uses 10s TTL
- ✅ Non-empty KV state uses 60s TTL

**Integration Tests**:
- ✅ PlaybackInfo request completes in < 4s (uncached)
- ✅ m3u8 request completes in < 3s (uncached)
- ✅ Video segment streams without buffering
- ✅ Range request returns correct byte range
- ✅ No double-fetch on timeout (check subrequest count)

**Client Tests**:
- ✅ Android TV: Playback starts immediately, no stuttering
- ✅ iOS: Playback starts immediately, no stuttering
- ✅ Android: Playback starts immediately, no stuttering
- ✅ PC: Playback starts immediately, no stuttering
- ✅ All clients: Throughput reaches max immediately (no ramp)

**Performance Tests**:
- ✅ Media request CPU time < 5ms
- ✅ KV reads per request ≤ 1
- ✅ Subrequests per request ≤ 5
- ✅ Connection reuse rate > 80%

**Security Tests**:
- ✅ Different tokens → different cache entries
- ✅ Anonymous requests → separate cache namespace
- ✅ No cross-user data leakage

---

## Deployment Plan

### Pre-Deployment

1. **Backup current worker.js**
2. **Review all changes** against this proposal
3. **Test in local dev environment** (`wrangler dev`)
4. **Verify DEBUG mode** works correctly

### Deployment Steps

1. **Deploy to Cloudflare Workers**
   ```bash
   wrangler deploy --config wrangler.json
   ```

2. **Monitor initial traffic** (first 10 minutes)
   - Check error rates in Cloudflare dashboard
   - Enable DEBUG mode temporarily if issues observed
   - Watch for increased CPU time or memory usage

3. **Verify improvements** (after 1 hour)
   - Test playback startup time
   - Test throughput stability
   - Check KV read quota usage

4. **Rollback if needed**
   - Redeploy previous worker.js version
   - Investigate issues via DEBUG headers
   - Adjust parameters and retry

### Post-Deployment

1. **Monitor for 24 hours**
   - Error rates should remain stable
   - KV quota usage should decrease
   - Request quota usage should decrease 30-50%

2. **Collect user feedback**
   - Playback startup experience
   - Streaming stability
   - Any new issues

3. **Fine-tune if needed**
   - Adjust timeouts based on actual latency
   - Adjust KV TTL based on update frequency
   - Optimize DEBUG output format

---

## Appendix

### Environment Variables

**Required**:
- `ADMIN_TOKEN` - Admin authentication token (existing)

**Optional**:
- `DEBUG` - Enable Server-Timing headers (default: false)
  - Set to "true" or "1" to enable
  - Adds performance metrics to response headers
  - No sensitive data exposed (tokens/URLs redacted)

### Server-Timing Header Format (DEBUG mode)

```
Server-Timing: kind;desc="media", kv_read;dur=0, cache_hit;desc="0", upstream;dur=1234, retry;desc="0", subreq;desc="2"
```

**Fields**:
- `kind` - Request type (media|range|m3u8|playbackinfo|api|manage)
- `kv_read` - KV read duration in ms
- `cache_hit` - Cache hit status (0=miss, 1=hit) + category
- `upstream` - Upstream fetch duration in ms
- `retry` - Retry count
- `subreq` - Total subrequest count

### Related Documents

- `constraints-analysis.md` - Detailed constraint analysis from exploration phase
- `worker.js` - Current implementation (to be modified)
- `README.md` - Project documentation
- `wrangler.json` - Deployment configuration

---

**End of Proposal**

