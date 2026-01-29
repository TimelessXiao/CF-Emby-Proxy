# Constraints Analysis - CF Worker Streaming Optimization

## Executive Summary

This document consolidates findings from parallel multi-model exploration (Codex + Gemini) of the CF-Emby-Proxy codebase. It identifies hard constraints, soft constraints, dependencies, and risks that will guide the optimization implementation.

---

## 1. Hard Constraints (Cannot Be Violated)

### 1.1 Cloudflare Workers Free Plan Limits

**CPU Time: 10ms per request**
- Source: Task requirements
- Impact: Must minimize CPU-intensive operations (hashing, regex, JSON parsing)
- Current violations:
  - `buildTokenKey()` called for ALL requests including media (worker.js:880)
  - `sha256Hex()` computed even when cache key not needed
  - POST body hashing for PlaybackInfo adds overhead (worker.js:950)

**Memory: 128MB per isolate**
- Source: Task requirements
- Impact: STRICTLY PROHIBIT buffering media responses
- Current compliance: ✅ Video/Range requests stream directly (worker.js:976-985)
- Risk area: POST body buffering for non-media (worker.js:866-869)

**Subrequests: 50 per request**
- Source: Task requirements
- Impact: KV reads, Cache API calls, fetch all count toward limit
- Current usage pattern:
  - KV route loading: 1-2 subrequests (pointer + doc)
  - Cache match: 1 subrequest
  - Upstream fetch: 1 subrequest
  - Cache put (async): 1 subrequest
  - **Risk**: Retry logic can double subrequest count

**Concurrent connections: 6 per invocation**
- Source: Task requirements
- Impact: Cannot use "concurrent storm" patterns
- Current compliance: ✅ Sequential fetch pattern

**KV Quota: 100k reads/day, 1k writes/day**
- Source: Task requirements
- Impact: Must minimize KV operations
- Current optimization: ✅ In-memory cache with 60s TTL (worker.js:95-97)
- Risk: Empty pointer cached for full TTL delays first publish visibility

### 1.2 Streaming & Caching Constraints

**STRICTLY PROHIBIT caching media content**
- Source: Task requirements + Codex analysis
- Scope: Video/audio segments, direct media files, ANY Range (206) responses
- Current compliance: ✅ Range requests disable CF cache (worker.js:922-930)
- Enforcement: `cfConfig.cacheEverything = false` for hasRange

**Range requests must preserve byte-range semantics**
- Source: Codex analysis (worker.js constraints)
- Impact: No buffering, no transformation, no caching
- Current compliance: ✅ Streaming passthrough (worker.js:976-985)

**Cross-user isolation is mandatory**
- Source: Task requirements + Gemini analysis
- Mechanism: Cache keys must be token-aware
- Current implementation: `${pathname}?${sortedSearch}::${tokenHash}` (worker.js:898-919)
- Fallback: 'anon:nodev' for unauthenticated requests

---

## 2. Soft Constraints (Conventions & Preferences)

### 2.1 Timeout & Retry Conventions

**Current pattern** (worker.js:217-228):
```javascript
async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}
```

**Usage pattern** (worker.js:162-165, 182-186):
```javascript
try {
  response = await fetchWithTimeout(targetUrl, fetchOptions, timeout);
} catch (err) {
  response = await fetch(targetUrl, fetchOptions); // Immediate retry
}
```

**Identified issues**:
- ❌ Abort on timeout then immediate retry = hidden double-request penalty
- ❌ No backoff, no retry limit, no total time budget
- ❌ Wastes subrequest quota and upstream capacity

**Convention to preserve**:
- ✅ Android TV gets longer timeouts (6000ms vs 2500ms)
- ✅ Video/WebSocket bypass timeouts entirely

### 2.2 Connection Management Conventions

**Current pattern** (worker.js:1000-1006):
```javascript
if (isVideo) {
  if (isAndroidTV) {
    resHeaders.set('Connection', 'keep-alive');
    resHeaders.set('Keep-Alive', 'timeout=30, max=1000');
  } else {
    resHeaders.set('Connection', 'close'); // ❌ PROBLEM
  }
}
```

**Identified issue**:
- ❌ Forcing `Connection: close` for non-Android video breaks connection reuse
- Impact: Throughput slowly climbs from 0 due to repeated TLS handshakes
- Task requirement: "禁止对媒体/Range 响应强制 Connection: close"

### 2.3 Caching Conventions

**m3u8 micro-caching** (worker.js:916-923):
- TTL: 2 seconds
- Conditions: GET + no Range + has token
- Key: `${pathname}?${sortedSearch}::${tokenHash}`
- ⚠️ Issue: `searchParams.sort()` called but not verified to work correctly

**PlaybackInfo POST caching** (worker.js:943-975):
- TTL: 3 seconds
- Mechanism: Manual Cache API (caches.default)
- Key: Synthetic URL + tokenHash + bodyHash
- ⚠️ Issue: Body hashing adds CPU overhead for every POST

---

## 3. Dependencies

### 3.1 External Dependencies

**Hono framework** (worker.js:1)
- Routing and context management
- Cannot be removed without major refactor

**Cloudflare Workers Runtime**
- `caches.default` for manual caching
- `crypto.subtle` for SHA-256 hashing
- `c.executionCtx.waitUntil` for async cache writes
- `fetch` with `cf` options for CF cache control

**KV Namespace: ROUTE_MAP**
- Dynamic upstream routing
- Versioned document storage
- Pointer-based current version tracking

**External Emby upstream**
- Overseas third-party service (cannot control)
- Variable latency and reliability

### 3.2 Internal Dependencies

**Utility functions**:
- `sha256Hex()` - Used for token/body hashing
- `buildTokenKey()` - Generates cache isolation keys
- `subdomainOf()` - Extracts subdomain for routing
- `mappingToBase()` - Constructs upstream base URL

**KV routing helpers**:
- `loadRouteMappings()` - Loads routes with in-memory cache
- `publishRouteMappings()` - Publishes new route versions
- `getPointerWithRetry()` - Reads KV pointer with retry
- `getVersionDocWithRetry()` - Reads KV doc with retry

---

## 4. Risks & Blockers

### 4.1 Performance Risks (P0 - Critical)

**Risk: Hidden double-request penalty**
- Location: worker.js:162-165, 182-186
- Impact: Every timeout triggers 2 upstream requests
- Mitigation: Refactor retry logic with proper backoff and limits

**Risk: Connection churn for non-Android video**
- Location: worker.js:1001-1002
- Impact: Repeated TLS handshakes slow throughput ramp
- Mitigation: Remove forced `Connection: close`

**Risk: Unnecessary CPU-intensive hashing**
- Location: worker.js:880 (buildTokenKey called for all requests)
- Impact: Wastes 10ms CPU budget on media requests
- Mitigation: Only compute hash when cache key needed

### 4.2 Caching Risks (P1 - High)

**Risk: Cache poisoning via token collision**
- Likelihood: Low (SHA-256 collision resistant)
- Impact: Cross-user data leakage
- Mitigation: Already mitigated by tokenHash design

**Risk: Stale PlaybackInfo during high concurrency**
- Likelihood: Medium (3s TTL with concurrent requests)
- Impact: Slightly stale playback positions
- Mitigation: Acceptable trade-off per task requirements

**Risk: Memory pressure from POST body buffering**
- Likelihood: Low (PlaybackInfo bodies typically small)
- Impact: Could hit 128MB limit under load
- Mitigation: Monitor and add size checks if needed

### 4.3 KV Routing Risks (P2 - Medium)

**Risk: Empty pointer cached for full TTL**
- Location: worker.js:142-147
- Impact: First publish invisible for up to 60 seconds
- Mitigation: Reduce TTL for empty state or add jitter

**Risk: Version ID collision (same-ms publishes)**
- Location: worker.js:175 (`v${Date.now()}`)
- Likelihood: Very low
- Impact: Last-write-wins ambiguity
- Mitigation: Add random suffix if needed

**Risk: Indefinite stale cache on KV errors**
- Location: worker.js:158-162
- Impact: Critical fixes delayed during KV outages
- Mitigation: Add max stale age or force refresh logic

---

## 5. Success Criteria (Observable Behaviors)

### 5.1 Startup Performance
- ✅ TTFB for PlaybackInfo < 500ms (cached) or < 3s (uncached)
- ✅ m3u8 playlist requests < 200ms (cached) or < 2s (uncached)
- ✅ No hidden double-fetch on timeout (verify via DEBUG headers)

### 5.2 Streaming Stability
- ✅ Video/Range requests are pure passthrough (no buffering)
- ✅ Android TV maintains persistent connections (keep-alive)
- ✅ Non-Android TV also benefits from connection reuse
- ✅ Throughput ramps immediately (no 0→slow climb)

### 5.3 Resource Efficiency
- ✅ Media requests: 0 KV reads, 0 cache operations, 0 hash computations
- ✅ API requests: ≤1 KV read (cached), ≤2 cache operations (match+put)
- ✅ Total subrequests per request: < 10 (well below 50 limit)

### 5.4 Caching Correctness
- ✅ No cross-user cache leakage (token-aware keys)
- ✅ No Range responses cached
- ✅ Static assets cached long (1 year)
- ✅ API micro-cache respects TTL (2-10s)

---

## Next Steps

1. **User Interaction** (Step 6): Present open questions to user for clarification
2. **OPSX Proposal** (Step 7): Transform constraints into formal proposal
3. **Implementation Planning**: Design changes based on approved constraints
