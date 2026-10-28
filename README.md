# dsh-session-ref-unlimit

解除 DeepSeek Harness 原生「**一条消息最多引用 3 个会话**」的硬上限，做成可装卸的 Cordis 宿主插件，**不改 `app.asar`、不动官方包**。

## 它解决什么

在会话里 `@` 引用其他会话时，如果一条消息里引用了第 4 个会话，本轮会直接失败：

```
本轮运行失败  a message may reference at most 3 sessions   UNKNOWN
```

装上本插件后，该上限由配置文件决定，默认放宽到 **8**。

## 上限为什么在 3

原生包 `@deepseek-ai/dsh-session-reference` 把 3 写死在三个地方（`app.asar` 内）：

| 位置 | 内容 |
|---|---|
| `lib/types/config.js` | `export const MAX_REFERENCES = 3` |
| `static Config`（zod） | `maxReferences: z.number().step(1).min(1).max(3).default(3)` |
| `constructor` | `if (this.config.maxReferences > 3) throw SessionReferenceError(...)` |

关键在于：真正决定放行还是拒绝的，是**每次准备消息时的一次读取**——

```js
// SessionReferenceResolver.prepare()
const inputs = normalizeReferences(agent.id, references, this.config.maxReferences);
```

而 `this.config` 是实例上的**普通对象**。也就是说：只要在实例化**之后**改写它，上面三道闸都不会再被触发。本插件做的就是这件事。

> 本机 `dsh-mention-tuner` 插件已经在用同一手法改写 `resolver.config.candidateLimit`，路径经过实机验证。

## 安全阀：为什么必须同时收缩单条预算

原生每条来源的字节预算是「上下文窗口 × `referenceContextFraction`」，默认 `0.2`，3 条合计 `0.6`。

如果只把条数从 3 提到 8、比例不动，总注入量会从 `0.6` 个上下文窗口涨到 `1.6`——**直接把上下文撑爆**，表现为回答质量骤降或提前触发压缩。

因此本插件在提高条数的同时，按 `totalContextFraction` 反算单条比例：

```
单条比例 = min(原生比例, totalContextFraction / 条数)
```

默认 `totalContextFraction = 0.6`，恰好等于原生 `3 × 0.2`，所以：

- 条数配 3 → 行为与原生**完全一致**（比例仍是 0.2）
- 条数配 8 → 单条比例降到 0.075，总预算仍是 0.6

**多引用几个会话，靠的是把同样的总预算切得更细，而不是把预算变大。** 每条快照会更短；超长会话仍会按原生机制截断，并在上下文里给出 `omittedMessages` / `omittedBytes` 与完整快照的 spill 定位。

如果确实想让总预算更大，调高 `totalContextFraction`（上限 1.0）——但这会实打实挤占对话上下文，请自行权衡。

## 配置

首次加载时自动生成 `$DSH_HOME/session-ref-unlimit.json`（默认 `D:\DeepSeekHarness\.dsh\session-ref-unlimit.json`）：

```json
{
  "enabled": true,
  "maxReferences": 8,
  "totalContextFraction": 0.6,
  "perSourceMaxBytes": null
}
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 关掉即完全回到原生上限 3 |
| `maxReferences` | `8` | 一条消息最多引用几个会话；不会低于原生 3 |
| `totalContextFraction` | `0.6` | 所有来源合计占上下文窗口的比例上限，`(0, 1]` |
| `perSourceMaxBytes` | `null` | 显式指定单条来源的最大序列化字节数；`null` 用原生自动预算 |

**改完保存即生效**，约 1 秒内重新应用，不需要重启宿主。配置文件损坏或字段非法时会自动回退默认值并在控制台告警，不会影响宿主启动。

## 安装

把本仓库放到任意目录，然后在目标 profile 的 `node_modules` 下建 junction（Windows）。
**必须用 Junction，不能用符号链接**——Node 的 ESM 解析器不认符号链接。

```powershell
# 1) 建 junction（把 <repo> 换成你 clone 下来的实际路径）
New-Item -ItemType Junction `
  -Path "$env:DSH_HOME\profiles\desktop\node_modules\dsh-session-ref-unlimit" `
  -Target '<repo>\dsh-session-ref-unlimit'

# 2) 在 profile 的 cordis.patch.yml 末尾追加：
#    - insert:
#        - id: session-ref-unlimit
#          name: 'dsh-session-ref-unlimit'

# 3) 完全退出 DSH 再启动（宿主插件不支持热加载）
```

卸载：删掉 `cordis.patch.yml` 里那几行，再删 junction：

```powershell
[System.IO.Directory]::Delete("$env:DSH_HOME\profiles\desktop\node_modules\dsh-session-ref-unlimit", $false)
```

**不要用 `Remove-Item -Recurse` 删 junction**——它会穿透进目标目录把真包删掉。

## 边界与风险

1. **依赖宿主内部契约**：读的是 `sessionReferenceResolver` 服务实例与 `prepare()` 读 `this.config` 的行为。宿主若改成在 `prepare()` 里硬编码常量，本插件即失效（表现为上限退回 3，不会报错崩溃）。
2. **不是无限上下文**：放开的是「条数」，总预算仍受 `totalContextFraction` 约束。
3. **自引用仍被拒绝**：引用当前会话本身由原生逻辑拦截，本插件不改变这一点。
4. **不做 UI**：纯宿主插件，没有设置页；改 JSON 即可。

## 验证方法

不装插件也能先验证核心结论（抽 `app.asar` 里的真实校验函数跑一遍）：

```powershell
node _scratch\verify-unlimit.mjs
```

预期输出：上限 3 时 4 条被拒、8 条被拒；上限 8 时 4 条与 8 条放行、9 条被拒。

## License

MIT
