# DSH 远程访问

给一个绑在局域网地址上的 DSH Web profile 加两样东西：启动自检，以及由反向代理触发的
令牌会话交接。浏览器只面对代理自己的认证；`reverse_proxy` 到 `localhost` 这一跳用你
自己设定的 token 认证，DSH 启动时打印的登录 token 不再需要有人去记。

```
browser ──代理认证──▶ reverse_proxy ──token──▶ localhost:3080 ──▶ DSH Web
                      TLS + 自己的 auth        X-DSH-Remote-Token
```

从 0.2.1 起，启动器接受一个具体的本机网卡地址（`--host 192.168.1.1`），并拒绝通配地址；
绑定由启动参数决定，本包不再改写 Web 服务行。

## 提供的能力

- **启动自检**：日志给出实际监听地址与端口；绑的是 loopback 时提示换成本机 LAN 地址；
  配置了 `publicOrigin` 时，同时报告该权威是否被 `/api` 的 Host 围栏接受，不被接受就附上
  要补的启动参数。
- **会话交接**：`token` 非空时挂载 `GET /__dsh/remote/login`。代理在这一路径带上
  `X-DSH-Remote-Token`，插件校验通过后用 DSH 自己的换取机制在进程内生成会话 cookie，
  303 回 `/`，浏览器直接进 UI。

**开关是启动参数 `--trusted-host`**：只有这次运行声明了至少一个远程权威，上面的诊断与
交接才生效；没有声明就既不挂路由、也不打印日志，本地照常用。配置了 `token` 却忘了这个
参数时，会给一条告警提醒。

## 请求经过什么

浏览器只看到 `reverse_proxy` 的 https 地址，也只做一次代理侧的认证。`reverse_proxy`
把请求转给 `localhost:3080`：

- `Host` 要原样转发。DSH 的会话 cookie 名是 `dsh-auth-{base64url(sha256(authority))}`，
  签名受众也是同一个 authority；Host 被改写，浏览器就永远拿不到对得上的 cookie。
- `/api` 的 Host 围栏接受 loopback、监听地址本身，以及启动参数 `--trusted-host` 声明的权威。
- 会话由插件在进程内生成：它调用 DSH 的 token 交换拿到 `Set-Cookie`，自己 303 回 `/`。
  DSH 的 launch token 不出现在 URL、浏览器历史、或代理日志里。

## 浏览器侧

- 打开 `https://dsh.example.com/`，先过 `reverse_proxy` 自己的认证（basic_auth 弹窗或 SSO 跳转）。
- 浏览器第一次还没有 DSH 会话，代理把这次访问送到 `/__dsh/remote/login`（地址栏会短暂经过它），
  插件换出会话后 303 回 `/`，页面直接进入 UI。全程不需要输入或记住任何 DSH token。
- 之后同一个浏览器带着 `dsh-auth-*` cookie，刷新、新开标签、WebSocket 都直接可用；
  代理的外层认证仍然每次都生效。
- cookie 默认 30 天（`connection.cookieMaxAgeDays` 可调）。过期或清掉之后重走一次上面的流程；
  换设备、换浏览器各自独立，互不影响。
- 没有配代理侧自动跳转时，第一次打开 `/` 会看到 401「dsh web authentication required」；
  手动访问一次 `https://dsh.example.com/__dsh/remote/login` 即可，之后同样靠 cookie。

## 安装

1. 把本目录放到 `localhost`（运行 DSH 的那台机器，例如 `D:\DSH-plug`）。零依赖，
   不需要联网安装。
2. 安装 bundle：DSH Web → Plugins → 安装本地 bundle，填绝对路径；或
   `plugin_manager install_bundle`。安装后多一行 `local-remote-access`。
   日志里没有出现 `remote-access:` 开头的行时，重启一次 `dsh`。
3. 启动（`--host` 写本机一块网卡的地址，通配地址会被拒绝）：

   ```powershell
   dsh --profile web --host 192.168.1.1 --no-open --trusted-host dsh.example.com
   ```

   - `--no-open`：这台机器通常没人盯桌面，不要弹浏览器。
   - `--host`：必须是本机某块网卡的具体 IP。只有另一台机器能连到这个地址，反向代理才有意义。
   - `--trusted-host`：浏览器实际使用的权威，`域名` 或 `域名:端口`，可重复传多个。
     监听地址本身不需要它，所以同网段直接用 `http://<LAN IP>:3080` 可以不带；
     但它同时是本插件的开关，不带就完全不启用。
   - `--port` 照旧生效。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `publicOrigin` | 空 | 浏览器使用的地址，如 `https://dsh.example.com`。用作会话交接的绑定权威，以及启动时判断围栏是否接受；为空时从代理转发的请求里推导。 |
| `token` | 空 | 你设定的共享令牌，至少 8 字节；为空表示不挂载会话交接。 |
| `tokenHeader` | `X-DSH-Remote-Token` | 代理承载令牌的请求头名。 |

行 id 固定为 `local-remote-access`：`@deepseek-ai/dsh-base` 自己占用了 `remote-access`
这个 id（Gateway 的访问策略服务），覆盖它会顶掉那一行，让所有 Gateway 消费者一直等
`remoteAccess` 服务。在 profile 的 `cordis.patch.yml` 里这样配：

```yaml
- id: local-remote-access
  config:
    publicOrigin: 'https://dsh.example.com'
    token: '<你自己定的令牌，建议 16 字节以上随机值>'
```

## 会话交接

浏览器第一次进来时还没有 DSH 会话，代理把它导向 `/__dsh/remote/login`；插件比对令牌后
用 DSH 自己的机制换出会话 cookie，303 回 `/`。之后浏览器带着 cookie，代理按普通请求
转发即可。

- 令牌只在这一条路径上注入，不要发给所有请求。
- 让这一步自动发生的办法，是在代理上判断浏览器有没有 `dsh-auth-*` cookie，没有就送往
  交换路径；Caddy 与 nginx 的写法见
  [docs/reverse-proxy.md](docs/reverse-proxy.md#4-会话交接token)。
- 令牌不匹配、方法不是 GET、拼不出 origin、DSH 拒绝换取，一律 404，路由不可枚举。
- `token` 是跨机器那一跳的唯一凭据：拿到它就能让 DSH 发会话，建议 16 字节以上的随机值。
- 改 `token` 后同步更新代理注入的值；已经拿到会话的浏览器在 cookie 过期前不受影响，
  要立刻让它们失效就删掉 credentials 里的 `browser-session` 记录并重启 DSH。
- DSH 自己的 launch token 每次进程重启都会换，插件是在进程内取当前值，所以重启后代理配置
  不用动，已有 cookie 在有效期内也继续可用。
- DSH 启动时打印的 `?token=` 地址是原生登录方式，插件不依赖它；想手工验证一次也可以直接用。

## 目录选择器

DSH 的目录选择器按绑定地址自适应：绑定地址不是 loopback（或声明了可信权威）时选
`browse`，即浏览器里的 in-app 目录对话框，而不是在本机桌面弹系统窗口。远程用户
「Add workspace」时能正常浏览宿主机目录；拿到浏览器会话的人本来就有完整 agent 权限，
需要隔离时用独立 OS 账户、容器或只读挂载。

## 监听所有网卡 / 多网卡

`dsh web` 一次只绑一个具体地址：启动器与 webserver schema 都拒绝 `0.0.0.0` 和 `::`，
`--trusted-host` 也没有通配写法。要让这台机器的每块网卡都能访问，就在它自己身上放一个
小反向代理，代理绑 `0.0.0.0:3080`，DSH 绑 loopback 的另一个端口：

```caddyfile
:3080 {
	reverse_proxy 127.0.0.1:3081 {
		header_up Host 127.0.0.1:3081
		header_up Origin http://127.0.0.1:3081
		flush_interval -1
	}
}
```

```powershell
dsh --profile web --host 127.0.0.1 --port 3081 --no-open
```

- 两个监听器不抢端口：代理在 `0.0.0.0:3080`，DSH 在 `127.0.0.1:3081`。
- `Host` 与同源 `Origin` 要一起改写成 `127.0.0.1:3081`。只改 Host 时，浏览器 POST/WS 带的
  Origin 会对不上，`/api` 判成跨站（403）；改掉以后这个本地代理不再区分同源与跨站，
  真正拦住别人的是 DSH 自己的会话 cookie（`SameSite=Strict`，只发给同主机）。
- cookie 按改写后的 authority 签发，浏览器按访问地址保存；每一跳改写一致，所以照常工作。
- 想让插件在这种拓扑下也启用会话交接，启动时加 `--trusted-host <LAN 地址>` 即可
  （它本来就接受监听地址，多声明一个无害）。

不想额外装 Caddy，Windows 自带的 TCP 转发也能做，但它不改 Host：

```powershell
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=3080 connectaddress=127.0.0.1 connectport=3081
```

此时 DSH 看到的是客户端原始的 `Host: 192.168.1.1:3080`，需要给每个会用到的地址加
`--trusted-host`（没有通配），地址一变就要改。

> 「只监听本机」的告警是按「代理在另一台机器」写的；本地代理挡在前面时属预期。

## 反向代理

反向代理放在 `reverse_proxy` 上：终止 TLS、挡在公网前面做认证、原样转发 `Host`、
透传 WebSocket 与 SSE，并挂在主机名或独立端口上（客户端资源用绝对路径，子路径会 404）。
Caddy、nginx、Cloudflare Tunnel 的可用配置、验证清单与排障表见
[docs/reverse-proxy.md](docs/reverse-proxy.md)。

## 验证

| 检查 | 位置 | 期望 |
|---|---|---|
| 启动日志 | `localhost` | `remote-access: listening on 192.168.1.1:3080; a reverse proxy on another machine can reach it` |
| 不带 `--trusted-host` 启动 | `localhost` | 日志里没有 `remote-access:` 开头的行，UI 照常 |
| `curl -H 'Host: dsh.example.com' http://<DSH 地址>:3080/` | `reverse_proxy` | 401 |
| `curl -H 'Host: evil.test' http://<DSH 地址>:3080/api/x` | `reverse_proxy` | 403 |
| `curl -i -H 'Host: dsh.example.com' -H 'X-DSH-Remote-Token: <token>' http://<DSH 地址>:3080/__dsh/remote/login` | `reverse_proxy` | `303` + `Set-Cookie: dsh-auth-...` |
| 启动日志（配了 `publicOrigin`） | `localhost` | `public entry https://...` 或未信任权威的 `--trusted-host` 提示 |
| 直接打开 `https://dsh.example.com/` | 浏览器 | 自动换会话后进 UI，刷新不掉登录 |
| 发一条消息 | 浏览器 | 流式回复正常，无重连风暴 |
| 「Add workspace...」 | 浏览器 | in-app 目录对话框 |
| `npm test` | 开发机 | 全绿 |

## 安全

- 会话 cookie 由 DSH 固定为 `HttpOnly; SameSite=Strict; Path=/`，没有 `Secure`；
  公共入口用 https，并保持 http→https 跳转。
- `token` 走请求头，不进 URL；代理日志里不会出现，也不要把它写进日志或 URL。
- `--host <LAN 地址>` 会把端口开到那块网卡上。只让 `reverse_proxy` 连、其他网段拒绝，
  交给防火墙、安全组或隧道策略。
- cookie 默认 30 天，UI 内不能单独撤销；对外暴露时把 `connection.cookieMaxAgeDays`
  调小（≤7）更稳妥。

## 回滚

移除 bundle：`local-remote-access` 行消失，会话交接路由随行消失；Web 服务仍按启动参数
绑定，不受影响。

```powershell
# DSH Web → Plugins → 移除；或
# plugin_manager remove_bundle @local/dsh-remote-access
```

## 开发

```powershell
npm test            # 纯函数 + 假 ctx 行为测试 + 对真实 DSH 安装的冒烟测试
npm run check:patch # 用 DSH 自己的方言解析 cordis.patch.yml，打印实际组合结果
```

`tools/` 只服务本地测试。运行时本包不导入任何 `@deepseek-ai/*`：从本地路径安装的 bundle
是链接进 profile 的，从链接位置解析不到这些包，所以 `index.js` 只依赖 Node 内建模块和
同目录文件；冒烟测试借 DSH 的解析规则对真实安装做组合断言。默认指向本机 npx 缓存，
可用 `DSH_DEV_MODULES` 覆盖。
