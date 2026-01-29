# Caching Strategy Specification

## Overview

The caching strategy is designed to accelerate Emby access while maintaining data freshness and cross-user isolation. Different content types use different caching mechanisms and TTLs.

## Cache Layers

### Layer 1: Cloudflare Cache (Static Assets)
- **Content**: Images, CSS, JS, fonts
- **TTL**: 1 year (31536000 seconds)
- **Mechanism**: Automatic via `cf.cacheEverything`
- **Pattern**: `STATIC_REGEX` in CONFIG

**Matched Paths**:
- File extensions: `.jpg`, `.jpeg`, `.png`, `.gif`, `.css`, `.js`, `.ico`, `.svg`, `.webp`, `.woff`, `.woff2`
- Emby image paths: `/Images/Primary`, `/Images/Backdrop`, `/Images/Logo`, `/Images/Thumb`, `/Images/Banner`, `/Images/Art`

### Layer 2: Manual Cache API (API Micro-cache)
- **Content**: Slow API responses
- **TTL**: 5-10 seconds
- **Mechanism**: `caches.default` API
- **Pattern**: `API_CACHE_REGEX` in CONFIG

**Matched Paths**:
- `/Items/Resume` - Resume playback positions
- `/Users/*/Items/*` - User item queries

**Purpose**: Dramatically improve "back/forward" navigation smoothness without affecting data accuracy.

### Layer 3: Manual Cache API (Playlists)
- **Content**: m3u8 playlists
- **TTL**: 2 seconds
- **Mechanism**: `caches.default` API with token-aware keys
- **Pattern**: `M3U8_REGEX` in CONFIG

**Cache Key Format**:
```
${pathname}?${sortedQueryParams}::${tokenHash}
```

### Layer 4: Manual Cache API (PlaybackInfo)
- **Content**: POST /PlaybackInfo responses
- **TTL**: 3 seconds
- **Mechanism**: `caches.default` API with synthetic URL
- **Pattern**: `PLAYBACKINFO_REGEX` in CONFIG

**Cache Key Format**:
```
https://synthetic.cache/${pathname}?${sortedQueryParams}::${tokenHash}::${bodyHash}
```

## Cache Isolation

### Token-Aware Keys
All cached content uses token-aware cache keys to prevent cross-user data leakage.

**Token Extraction Sources** (priority order):
1. `X-Emby-Token` header
2. `X-MediaBrowser-Token` header
3. `api_key` query parameter
4. `Authorization` header (Token or Bearer format)

**Device ID Extraction**:
1. `X-Emby-Device-Id` header
2. `X-Device-Id` header
3. `Authorization` header (DeviceId field)

**Hash Computation**:
```javascript
tokenHash = SHA256(`${token || 'anon'}:${deviceId || 'nodev'}`)
```

**Fallback**: Anonymous requests use `'anon:nodev'` hash.

## No-Cache Rules

### Strictly Prohibited from Caching
1. **Video/Audio Streams**: Any path matching `VIDEO_REGEX`
2. **Range Requests**: Any request with `Range` header
3. **WebSocket Connections**: Upgrade requests
4. **POST Requests**: Except PlaybackInfo (explicitly cached)

**Enforcement**:
- `cfConfig.cacheEverything = false` for Range requests
- Direct passthrough for video streams
- No buffering of response bodies

## Cache Invalidation

### Automatic Invalidation
- **TTL Expiration**: All caches expire based on configured TTL
- **No Manual Purge**: Cloudflare Workers Free plan limitation

### Stale-While-Revalidate
Not implemented. All caches are hard TTL-based.

## Performance Targets

### Cache Hit Rates
- Static assets: > 95%
- API micro-cache: 60-80% (depends on user behavior)
- m3u8 playlists: 70-90%
- PlaybackInfo: 50-70%

### Latency Targets
- Static assets (cached): < 50ms
- API (cached): < 100ms
- m3u8 (cached): < 200ms
- PlaybackInfo (cached): < 500ms

## Configuration

### CONFIG Object (worker.js)
```javascript
{
  STATIC_REGEX: /(\.(jpg|jpeg|png|gif|css|js|ico|svg|webp|woff|woff2)|(\/Images\/(Primary|Backdrop|Logo|Thumb|Banner|Art)))/i,
  VIDEO_REGEX: /(\/Videos\/|\/Items\/.*\/Download|\/Items\/.*\/Stream)/i,
  API_CACHE_REGEX: /(\/Items\/Resume|\/Users\/.*\/Items\/)/i,
  M3U8_REGEX: /\.m3u8($|\?)/i,
  PLAYBACKINFO_REGEX: /\/PlaybackInfo/i,
  M3U8_TTL: 2,
  PLAYBACKINFO_TTL: 3
}
```
