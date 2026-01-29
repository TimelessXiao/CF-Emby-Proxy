# 代码片段语法修正清单

## 问题：扩展运算符被Markdown吞掉

**错误示例**：
```javascript
cf: { .cfConfig, noTlsVerify: true }  // ❌ 语法错误
cf: { .cfConfig }                      // ❌ 语法错误
```

**正确写法**：
```javascript
cf: { ...cfConfig, noTlsVerify: true }  // ✅ 正确
cf: { ...cfConfig }                     // ✅ 正确
```

---

## 修正后的完整代码片段

### fetchOptions构造（正确版本）

```javascript
// BEFORE
const fetchOptions = {
  method: req.method,
  headers: proxyHeaders,
  body: reqBody,
  redirect: 'manual',
  // 在这里将 noTlsVerify 添加到 cf 对象中,忽略worker到上游emby的https验证
  cf: { ...cfConfig, noTlsVerify: true }  // 注意：三个点的扩展运算符
}

// AFTER
const fetchOptions = {
  method: req.method,
  headers: proxyHeaders,
  body: reqBody,
  redirect: 'manual',
  // 移除无效字段 noTlsVerify；只保留 Cloudflare 支持的 cf 选项
  cf: { ...cfConfig }  // 注意：三个点的扩展运算符
}
```

---

## 硬约束（防止AI生成错误代码）

**必须在实施计划中明确写明**：

1. **扩展运算符必须使用三个点**：`...cfConfig`
2. **禁止使用单点**：`.cfConfig`（这是语法错误）
3. **所有对象展开都必须使用扩展运算符**：`{ ...obj }`

**验证方法**：
- 全文搜索 `{ .` → 应该0命中
- 全文搜索 `{ ...` → 应该找到所有正确的扩展运算符使用

---

## 需要检查的所有位置

### 位置1：fetchOptions构造
```javascript
cf: { ...cfConfig }  // ✅ 必须有三个点
```

### 位置2：cfConfig对象展开（如果有其他地方使用）
```javascript
const newConfig = { ...cfConfig, someNewProp: value }  // ✅ 必须有三个点
```

---

## 实施时的强制检查

**在生成代码前**：
1. 检查所有 `{` 后面是否有 `.`
2. 如果有，确认是 `...` 而不是 `.`
3. 如果是单点，立即报错并修正

**在代码审查时**：
1. 使用正则搜索：`\{\s*\.(?!\.\.)`
2. 应该0命中（表示没有单点语法错误）
