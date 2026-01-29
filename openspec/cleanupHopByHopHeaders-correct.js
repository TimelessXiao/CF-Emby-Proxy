// RFC 7230 hop-by-hop header cleanup (CORRECT ORDER)
//
// 正确顺序（关键）：
// 1. 先读取 Connection 的值（如果存在）并解析 token
// 2. 再删除固定 hop-by-hop 列表
// 3. 再删除解析出来的 token 字段名
// 4. 最后删除 Connection 本身

function cleanupHopByHopHeaders(headers) {
  if (!headers) return

  // Step 1: 先读取并解析 Connection 头的值（在删除之前！）
  const connVal = headers.get('Connection') || headers.get('connection')
  const dynamicHopByHop = []
  if (connVal) {
    // Parse comma-separated field-names; case-insensitive; trim whitespace
    for (const token of connVal.split(',').map(t => t.trim()).filter(Boolean)) {
      dynamicHopByHop.push(token.toLowerCase())
    }
  }

  // Step 2: 删除固定 hop-by-hop 列表
  const fixed = [
    'connection',
    'keep-alive',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'proxy-authenticate',
    'proxy-authorization'
  ]
  for (const name of fixed) {
    headers.delete(name)
  }

  // Step 3: 删除 Connection 声明的动态字段
  for (const name of dynamicHopByHop) {
    headers.delete(name)
  }

  // Step 4: Connection 已在 Step 2 中删除，无需再次删除
}

// 验证示例：
// 输入：Connection: foo, bar
// Step 1: dynamicHopByHop = ['foo', 'bar']
// Step 2: 删除固定列表（包括connection）
// Step 3: 删除foo和bar
// 结果：Connection、foo、bar都被删除 ✅
