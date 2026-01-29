# Dynamic Routing Specification

## Overview

KV-backed dynamic routing system that allows subdomain-based routing to different upstream Emby servers without redeployment.

## Architecture

### Storage Layer
- **KV Namespace**: `ROUTE_MAP`
- **Pointer Key**: `routes:current` - Points to current version
- **Version Key**: `routes:v{timestamp}` - Versioned route documents

### Cache Layer
- **In-Memory Cache**: `globalThis[ROUTE_CACHE_KEY]`
- **TTL**: 60 seconds (configurable via `CONFIG.ROUTE_CACHE_TTL`)
- **Structure**:
  ```javascript
  {
    version: "v1234567890",
    mappings: { subdomain: { host, port, protocol } },
    expiresAt: timestamp
  }
  ```

## Routing Logic

### Subdomain Extraction
```javascript
function subdomainOf(hostname) {
  const parts = hostname.split('.')
  return parts.length > 2 ? parts[0] : null
}
```

### Upstream URL Construction
```javascript
function mappingToBase(mapping) {
  const protocol = mapping.protocol || 'https'
  const port = mapping.port ? `:${mapping.port}` : ''
  return `${protocol}://${mapping.host}${port}`
}
```

### Route Resolution Flow
1. Extract subdomain from request hostname
2. Check in-memory cache (60s TTL)
3. If cache miss or expired:
   - Read pointer from KV (`routes:current`)
   - Read version document from KV (`routes:v{version}`)
   - Update in-memory cache
4. Lookup subdomain in mappings
5. Construct upstream URL
6. Fallback to `CONFIG.UPSTREAM_URL` if no mapping found

## Management API

### Endpoints
- `GET /manage` - Admin UI
- `GET /manage/api/routes` - List all routes
- `POST /manage/api/routes` - Create/update route
- `DELETE /manage/api/routes/:subdomain` - Delete route

### Authentication
- Header: `Authorization: Bearer {ADMIN_TOKEN}`
- Environment variable: `ADMIN_TOKEN`

### Route Document Format
```json
{
  "subdomain1": {
    "host": "emby1.example.com",
    "port": 8096,
    "protocol": "https"
  },
  "subdomain2": {
    "host": "emby2.example.com",
    "protocol": "https"
  }
}
```

## Versioning

### Version ID Format
- Pattern: `v{timestamp}`
- Example: `v1706342400000`
- Generated: `Date.now()`

### Publish Flow
1. Generate new version ID
2. Write new document to KV (`routes:v{newVersion}`)
3. Update pointer to new version (`routes:current`)
4. In-memory cache auto-expires after 60s

## Performance Characteristics

### Read Path
- **Cache Hit**: 0 KV reads, < 1ms
- **Cache Miss**: 1-2 KV reads, 10-50ms
- **Cache TTL**: 60 seconds

### Write Path
- **KV Writes**: 2 per publish (document + pointer)
- **Propagation**: Up to 60s (cache TTL)

## Configuration

### CONFIG Object
```javascript
{
  ROUTE_CACHE_TTL: 60  // seconds
}
```

### KV Namespace Binding
```toml
# wrangler.json
[[kv_namespaces]]
binding = "ROUTE_MAP"
id = "your-kv-namespace-id"
```
