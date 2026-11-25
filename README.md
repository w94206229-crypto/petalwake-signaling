# Petalwake · Node.js 信令服务（Render）

兼容原始 `magic-petalwake-v4-mesh.html`，保持 Mesh All 全互联。`public/index.html` 是原文件逐字节复制，没有修改游戏、`mesh.js`、法术或网络拓扑。服务仅处理 WebRTC 协商和房间控制，不是游戏服务器、权威端、TURN 或游戏数据中继。

## 1. 本地启动

需要 Node.js 22.x 和 npm。

```bash
npm install
npm test
npm start
```

浏览器访问 `http://localhost:17280/`。在两个或更多标签页/设备中选择 Fly Together，创建房间后分享六位房间码。其他设备访问同一个服务地址；不要直接用 `file://` 打开 HTML。局域网调试时可用服务机器的 LAN IP（部分浏览器安全策略可能要求 HTTPS）。

环境变量 `PORT` 可覆盖本地默认端口。服务始终绑定 `0.0.0.0`，Render 自动注入 `PORT`。

## 2. 部署到 Render

### Blueprint（推荐）

1. 解压 ZIP，将本目录内的文件提交到自己的 GitHub/GitLab 仓库根目录，保留 `render.yaml` 和 `public/index.html`。
2. 登录 Render 控制台，选择 **New > Blueprint**，连接仓库，确认创建 `petalwake-signaling` Web Service。
3. 部署成功后访问 Render 分配的 `https://<service-name>.onrender.com/`，在页面内创建或加入房间。服务名和实际域名以控制台为准。
4. `https://<service-name>.onrender.com/healthz` 应返回 `{"ok":true,"service":"petalwake-signaling"}`。

### 手动创建 Web Service

| 设置 | 值 |
| --- | --- |
| Runtime | Node |
| Build Command | `npm install --omit=dev` |
| Start Command | `npm start` |
| Health Check Path | `/healthz` |
| Instance Type | Free（调试）或付费常驻实例 |
| Instances | 1（必须单实例） |
| Environment Variable | `NODE_ENV=production` |

不必设置 `PORT`、TLS、WebSocket 端口、数据库或 TURN。Render 会终止 TLS，浏览器自动使用同源 `wss://<service-name>.onrender.com/signal`。静态游戏和信令入口一起部署，以避免修改客户端 URL。部署成功后建议把首次 `npm install` 生成的 `package-lock.json` 提交到仓库，并将构建命令换成 `npm ci --omit=dev`；当前包锁定了 ws 的具体版本，但因构建环境 DNS 受限未生成 npm 锁文件。

Render 文档：
- https://render.com/docs/web-services
- https://render.com/docs/websocket
- https://render.com/docs/blueprint-spec
- https://render.com/docs/free

## 3. 网络拓扑

四名玩家对应六条点对点 WebRTC 连接，每条有两条直接 DataChannel：`data`（可靠）和 `pose`（无序、不重传）。服务只负责 WebSocket 信令，房间时钟与连接报告；施法、坐标、植被操作、快照、分数等仍通过 DataChannel 传输，不增加游戏数据的网络往返。

- 首个成员直接激活。其余成员在 SDP 交换完成且与所有已激活成员都报告两条 DataChannel 打开后才激活，防止未就绪通道被使用。
- `roster` 始终保持入房顺序，服装槽位可复用；由较晚入房者发起 offer，与现有客户端一致。并发入房按当前可完整连通的成员逐个激活，不让已在房内的玩家等待新成员。
- 建房者无服务端特权。离开后房间及单调时钟保留，直到最后一名成员离开。新成员可补位。
- 新成员直连失败时，移除未激活的成员；两个已激活成员的链路失败时移除报告故障的一方（服务无法判定哪端真正故障），以保持剩余成员全互联。
- 不提供 TURN，不接受 relay ICE candidate，也拒绝 SDP 内嵌 relay candidate。不跨房间传递信令。无通用数据转发 API。

## 4. 与 V4 客户端兼容的协议

所有 WebSocket 消息均为 JSON 文本；不接收二进制游戏数据。

| 方向 | 消息 | 说明 |
| --- | --- | --- |
| C → S | `{type:"join",code:""}` | 创建房间；非空六位十六进制码则加入 |
| S → C | `{type:"welcome",id,slot,code,age}` | 随机 UUID、服装槽位、房间码、房间年龄毫秒 |
| S → C | `{type:"roster",list:[{id,slot,active}]}` | 成员发现与激活状态，保留入房顺序 |
| C → S | `{type:"clock",echo}` | 时钟往返测量请求 |
| S → C | `{type:"clock",echo,age}` | 原样回显和单调房间年龄毫秒 |
| C → S | `{type:"signal",to,description}` | WebRTC SDP offer/answer（仅 DataChannel） |
| C → S | `{type:"signal",to,candidate}` | host/srflx/prflx ICE candidate |
| S → C | `{type:"signal",from,description}` 或 `{type:"signal",from,candidate}` | 仅同房间指定目标；from 由服务端赋值 |
| C → S | `{type:"link",to}` | 两条 DataChannel 均打开后的本端报告 |
| C → S | `{type:"failed",to}` | 直连失败报告 |
| S → C | `{type:"error",reason}` | 客户端已有翻译字典支持的错误 |

`age` 使用 Node.js 单调时钟 `performance.now()`，不受系统壁钟校时跳变影响；服务端仅提供时钟基准，不计算游戏状态或排序游戏操作。

## 5. 边界和防护

- 每房最多 4 个成员（含尚未激活者）；默认最多 256 房、1024 WebSocket 连接。
- 连接后 10 秒内须发 join，未激活成员 55 秒内完成握手（客户端自身超时为 60 秒）。
- 每 25 秒 ping/pong 探测；未响应的连接被清理，空房自动删除。
- 每连接 200 条突发额度、每秒补充 40 条；单条消息上限 128 KiB；积压超过 256 KiB 的连接终止。关闭 WebSocket 压缩。
- 浏览器默认允许同源 Origin；如将来需要其他前端来源，可通过 `ALLOWED_ORIGINS`（逗号分隔的完整 origin，例如 `https://example.com`）额外允许。但现有游戏仍按同源 URL 连接。非浏览器客户端可省略 Origin，Origin 不是身份认证。
- 房间码由加密随机数生成，仅作为分享入口，不是账号或强认证。没有账号、密码、封禁、分布式防刷或 DDoS 保障；公开规模化部署前需补足访问控制和限额。服务不会主动存储 SDP/ICE 或游戏信息；WebRTC 握手会让房间成员交换网络候选地址。
- 仅单实例，房间和计时在内存中，进程重启/重新部署会清空。原 V4 客户端一旦信令 WebSocket 断开就退出联机，因此保持信令连接是必要的，不应在握手后关闭 WebSocket。重启后需重新建房/加入；没有自动重连和房间恢复功能。
- 无 TURN 意味着某些 CGNAT、对称 NAT、企业防火墙或封锁 UDP 的网络可能无法直连。信令正常也不能保证任意网络组合可连通。
- Render Free 在 15 分钟没有入站流量时休眠，唤醒可能约需一分钟，且实例可能被替换；V4 入房期间存在 60 秒超时。长时间稳定开房建议付费常驻实例。即使是付费实例，重新部署也可能中断 WebSocket。

## 6. 验证

`npm test`：7 组真实本地 HTTP/WebSocket 集成测试，包含 4 人/6 对链路的模拟握手消息与双向 link 确认、并发入房、槽位回收、建房者退出、房间隔离、SDP/ICE 过滤、非法游戏包、心跳和超时等。这里的 WebSocket 是真实 TCP 连接；RTC 握手内容和 link 报告由测试客户端模拟，并非实际 DataChannel。

可选的真实浏览器测试：

```bash
python -m pip install playwright
python -m playwright install chromium
python test/webrtc-smoke.py
```

该脚本加载 `public/index.html` 内原封不动的 Mesh 模块，在四个独立 Chromium context 中建立实际 WebRTC 连接，验证直接 DataChannel 消息和创建者退出后的补位。脚本不加载 WebGL 游戏场景。可通过 `CHROMIUM_PATH` 指定本机 Chromium。

本次验证记录：Node.js 22.16.0；npm registry DNS 无法访问，真实 HTTP/WebSocket 集成测试通过当前环境已安装的 Playwright 内置 ws 实现运行（非部署锁定的 npm 版本）；7/7 通过。`test-results.txt` 提供测试输出。尝试运行真实浏览器测试时，本地 URL 被浏览器管理策略阻止（ERR_BLOCKED_BY_ADMINISTRATOR），尚未完成真实 ICE/DataChannel、Render 公网及跨 NAT 验证；部署前请在自己的环境执行 `npm install && npm test` 和可选浏览器测试，部署后再用不同网络的四台设备验证。
