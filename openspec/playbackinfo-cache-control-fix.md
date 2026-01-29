# PlaybackInfo Cache-Control 策略修正

## ⚠️ 重要声明

**本文档仅讨论Cache-Control策略修改（从public改为private）**

**❌ 本文档的代码片段不代表完整实现，特别是subreqCount统计位置不正确**

**✅ 完整的PlaybackInfo微缓存实现请参考**：
- `implementation-plan-v3-corrected.md` Phase 2任务2.1步骤4（正确的subreqCount位置）
- `v3-execution-patches-A-F.md` 优先级C（subreqCount统计规范）

**全局不变量**：
- subreqCount只统计upstream fetch次数
- subreqCount++必须在fetch()调用前增加
- cache.put不能计入subreqCount

---

## 问题分析

**当前问题**：
- m3u8已改为`private, max-age=2`
- 但PlaybackInfo仍使用`public, max-age=3`
- 这与"避免不可控复用"的原则冲突

**用户反馈**：
> PlaybackInfo 本身也是 token/body 相关的用户态数据；即使你边缘缓存 key 是隔离的，客户端/中间缓存 public 仍可能带来不可控复用风险（和你对 m3u8 的担心是同一类问题）。

---

## 修正方案

### 原则：统一用户态数据的Cache-Control策略

**用户态数据**（token/body相关）：
- m3u8播放清单
- PlaybackInfo播放信息
- 其他API响应

**策略**：
- 边缘缓存：通过`caches.default` + token-aware key控制
- 客户端Cache-Control：使用`private`避免共享缓存

---

## 代码修正

### 修改位置：PlaybackInfo POST微缓存分支

```javascript
// BEFORE
const resHeaders = new Headers(upstreamResp.headers)
cleanupHopByHopHeaders(resHeaders)
if (upstreamResp.ok && (resHeaders.get('content-type') || '').includes('application/json')) {
  resHeaders.set('Cache-Control', `public, max-age=${CONFIG.PLAYBACKINFO_TTL}`)  // ❌ public
  const toStore = new Response(upstreamResp.body, { status: upstreamResp.status, headers: resHeaders })
  subreqCount++
  c.executionCtx.waitUntil(caches.default.put(cacheReq, toStore.clone()))
  response = toStore
}

// AFTER
const resHeaders = new Headers(upstreamResp.headers)
cleanupHopByHopHeaders(resHeaders)
if (upstreamResp.ok && (resHeaders.get('content-type') || '').includes('application/json')) {
  resHeaders.set('Cache-Control', `private, max-age=${CONFIG.PLAYBACKINFO_TTL}`)  // ✅ private
  const toStore = new Response(upstreamResp.body, { status: upstreamResp.status, headers: resHeaders })
  subreqCount++
  c.executionCtx.waitUntil(caches.default.put(cacheReq, toStore.clone()))
  response = toStore
}
```

---

## 硬约束（写入实施计划）

**用户态数据的Cache-Control策略**：

1. **m3u8**：`private, max-age=2`
2. **PlaybackInfo**：`private, max-age=3`
3. **其他API微缓存**：如果未来添加，也必须使用`private`

**禁止**：
- 对token/body相关的用户态数据使用`public`
- 对需要token-aware缓存的内容使用`public`

**允许**：
- 静态资源（图片、CSS、JS）可以使用`public`
- 完全公开的、无用户态的内容可以使用`public`

---

## 验证方法

**检查点1**：m3u8响应头
```
Cache-Control: private, max-age=2  ✅
```

**检查点2**：PlaybackInfo响应头
```
Cache-Control: private, max-age=3  ✅
```

**检查点3**：静态资源响应头
```
Cache-Control: public, max-age=31536000, immutable  ✅（静态资源可以用public）
```

---

## 理由说明

**为什么PlaybackInfo也要用private**：

1. **用户态数据**：PlaybackInfo包含用户特定的播放信息
2. **token-aware**：边缘缓存key包含tokenHash
3. **一致性**：与m3u8策略保持一致
4. **安全性**：避免中间缓存/客户端缓存产生不可控复用

**边缘缓存不受影响**：
- `caches.default`仍然会缓存（通过token-aware key）
- `private`只影响客户端和中间代理的缓存行为
- 边缘缓存由`cfConfig.cacheKey`控制，不受Cache-Control影响
