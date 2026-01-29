# Architecture Specification

## Overview

CF-Emby-Proxy is a Cloudflare Workers-based reverse proxy for Emby media servers, designed to accelerate access through intelligent caching strategies while maintaining streaming performance.

## Technology Stack

### Runtime Environment
- **Platform**: Cloudflare Workers (Free Plan)
- **Framework**: Hono v4.11.5
- **Language**: JavaScript (ES Modules)

### Storage
- **KV Namespace**: Dynamic routing configuration storage
- **Cache API**: Manual caching for API responses and playlists
- **Cloudflare Cache**: Automatic caching for static assets

## Core Components

### 1. Request Router
- **Location**: `worker.js` (Hono app)
- **Responsibility**: Route classification and request handling
- **Key Routes**:
  - `/manage/*` - Admin interface
  - `/*` - Proxy requests to upstream Emby server

### 2. Dynamic Routing System
- **Storage**: KV-backed with in-memory cache
- **Mechanism**: Subdomain-based routing to different upstream servers
- **Cache TTL**: 60 seconds (in-memory)
- **Key Functions**:
  - `loadRouteMappings()` - Load routes with cache
  - `publishRouteMappings()` - Publish new route versions

### 3. Caching Layer
- **Static Assets**: 1-year cache via Cloudflare Cache
- **API Micro-cache**: 5-10 second cache for slow APIs
- **m3u8 Playlists**: 2-second cache
- **PlaybackInfo**: 3-second cache
- **Isolation**: Token-aware cache keys (SHA-256 hash)

### 4. Streaming Passthrough
- **Video Streams**: Direct passthrough, no buffering
- **Range Requests**: Byte-range preservation
- **WebSocket**: Full support for real-time features

## Deployment Architecture

```
Client Request
    ↓
Cloudflare Edge (Global)
    ↓
Worker (Request Classification)
    ↓
├─ Static Assets → CF Cache (1 year)
├─ API Requests → Manual Cache (5-10s) → Upstream
├─ m3u8/PlaybackInfo → Manual Cache (2-3s) → Upstream
└─ Video/Range → Direct Passthrough → Upstream
```

## Constraints

### Hard Constraints (Cloudflare Workers Free Plan)
- **CPU Time**: 10ms per request
- **Memory**: 128MB per isolate
- **Subrequests**: 50 per request
- **Concurrent Connections**: 6 per invocation
- **KV Quota**: 100k reads/day, 1k writes/day
- **Request Quota**: 100k/day, 1000/min burst

### Design Constraints
- **No Media Buffering**: STRICTLY PROHIBIT buffering video/audio content
- **Cross-User Isolation**: Cache keys must be token-aware
- **Streaming Semantics**: Preserve byte-range and connection semantics

## Configuration

### Environment Variables
- `ADMIN_TOKEN` - Admin authentication token (required)
- `DEBUG` - Enable performance metrics (optional)

### KV Namespace
- `ROUTE_MAP` - Dynamic routing configuration storage

## Client Support

### Optimized Clients
- Android TV / ExoPlayer (extended timeouts, keep-alive)
- iOS / Android native clients
- PC native clients
- Web browsers

### Client Detection
- User-Agent based detection for Android TV
- Timeout adjustments: 6000ms (Android TV) vs 2500ms (others)
