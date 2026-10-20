# DSH 远程访问

给绑在局域网地址上的 DSH Web profile 加上反向代理场景：启动自检、令牌会话交接、可选的目录选择器起点。浏览器只面对代理自己的认证，DSH 启动时打印的登录 token 不用记。

```
browser ──代理认证──▶ reverse_proxy ──token──▶ localhost:3080 ──▶ DSH Web
                     TLS + 自己的 auth        X-DSH-Remote-Token
```

插件只在本次运行声明了远程权威（`--trusted-host`）时生效；没有声明就不挂路由、不打日志，本地照常用。DSH 0.2.1 起，启动器接受一个具体的本机网卡地址并拒绝通配地址，绑定由启动参数决定，本包不改写 Web 服务行。

## 安装

1. 把本目录放到运行 DSH 的那台机器（下称 `localhost`，例如 `D:\DSH-plug`）。零依赖，不需要联网安装。
2. 安装 bundle：DSH Web → Plugins → 安装本地 bundle，填绝对路径；或 `plugin_manager install_bundle`。安装后插件列表多一行 `local-remote-access`，日志里没有出现 `remote-access:` 开头的行时，重启一次 `dsh`。
3. 启动：

   ```powershell
   dsh --profile web --host 192.168.1.1 --no-open --trusted-host dsh.example.com
   ```

   - `--host`：本机某块网卡的地址，通配地址会被拒绝；绑到另一台机器能连上的地址，反向代理才有意义。
   - `--trusted-host`：浏览器实际使用的权威，`域名` 或 `域名:端口`，可重复传。它同时是本插件的开关，不带就完全不启用；同网段直接访问 `http://<LAN IP>:3080` 时可以不带，监听地址本身已被接受。
   - `--no-open`：这台机器通常没人盯桌面，不要弹浏览器。`--port` 照旧生效。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `publicOrigin` | 空 | 浏览器实际使用的地址，如 `https://dsh.example.com`。会话交接按它绑定权威，启动时也用它检查 `/api` 的 Host 围栏是否接受（围栏只认 loopback、监听地址和 `--trusted-host`）；为空时从代理转发的请求里推导。 |
| `token` | 空 | 代理与 DSH 之间的共享令牌，至少 8 字节；为空表示不挂载会话交接。 |
| `tokenHeader` | `X-DSH-Remote-Token` | 代理承载令牌的请求头名。 |
| `browseRoot` | 空 | 应用内目录对话框默认打开的绝对路径，只在插件启用且本次用 `browse` 时生效；Windows 需要盘符或完整 UNC。 |

行 id 固定为 `local-remote-access`。`@deepseek-ai/dsh-base` 自己占用了 `remote-access`（Gateway 的访问策略服务），覆盖会让所有 Gateway 消费者一直等 `remoteAccess`。在 profile 的 `cordis.patch.yml` 里这样配：

```yaml
- id: local-remote-access
  config:
    publicOrigin: 'https://dsh.example.com'
    token: '<自己定的令牌，建议 16 字节以上随机值>'
    browseRoot: 'D:\MyWorkSpace'
```

## 会话交接

浏览器第一次进来时还没有 DSH 会话。代理发现请求里没有 `dsh-auth-*` cookie，就把 `GET /` 送到 `/__dsh/remote/login` 并注入令牌；插件比对令牌后用 DSH 自己的换取机制在进程内生成会话 cookie，303 回 `/`。之后浏览器带着 cookie，代理按普通请求转发即可。

`Host` 必须原样转发。cookie 名是 `dsh-auth-{base64url(sha256(authority))}`，签名也绑同一个 authority；Host 被改写成上游地址，浏览器就永远拿不到对得上的 cookie，表现是 401 或来回跳转。

代理侧：

- 令牌只注入 `/__dsh/remote/login`，不要发给所有请求。
- 交换路径不要缓存，`Set-Cookie` 不能丢。
- 没有配自动跳转时，第一次打开 `/` 会看到 401「dsh web authentication required」；手动访问一次 `https://dsh.example.com/__dsh/remote/login` 即可，令牌由代理在这条路径注入。

插件侧：

- 令牌不匹配、方法不是 GET、拼不出 origin、DSH 拒绝换取，一律 404，路由不可枚举。
- cookie 默认 30 天（`connection.cookieMaxAgeDays` 可调），过期或清掉后重走一次；换设备、换浏览器各自独立。
- 改 `token` 后同步更新代理注入的值。已拿到会话的浏览器在 cookie 过期前不受影响；要立刻让它们失效，删掉 credentials 里的 `browser-session` 记录并重启 DSH。
- DSH 的 launch token 每次重启都会换，插件是在进程内取当前值，重启后代理配置不用动。启动时打印的 `?token=` 地址是原生登录方式，插件不依赖它。

## 目录选择器

DSH 的目录选择器按绑定地址自适应：绑定地址不是 loopback（或声明了可信权威）时用 `browse`，即浏览器里的 in-app 对话框，而不是在宿主机桌面弹系统窗口。远程用户「Add workspace」时能浏览宿主机目录；拿到浏览器会话的人本来就有完整 agent 权限，需要隔离时用独立 OS 账户、容器或只读挂载。

`browseRoot` 只改对话框打开的位置和面包屑的 `home` 锚点：

- 插件启用且 DSH 选中 `browse` 时，`list()` 的缺省路径与 listing 的 `home` 指向该绝对路径，日志打印 `the in-app directory picker opens at ...`。
- 它不改 DSH 自己的 native/browse 选择：绑 loopback 且没有远程权威时仍是系统对话框，此时 `browseRoot` 只给一条告警。
- 它不是访问边界：顶部的「编辑路径」仍可输入其它绝对路径。要限制可访问范围，用独立 OS 账户、容器或只读挂载。
- 卸载或禁用本行后恢复原来的 `list()`，对话框回到宿主主目录。

## 监听所有网卡

`dsh web` 一次只绑一个具体地址：启动器与 webserver schema 都拒绝 `0.0.0.0` 和 `::`，`--trusted-host` 也没有通配写法。要让这台机器的每块网卡都能访问，就在它自己身上放一个小反向代理，代理绑 `0.0.0.0:3080`，DSH 绑 loopback 的另一个端口：

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
- `Host` 与同源 `Origin` 要一起改写成 `127.0.0.1:3081`。只改 Host 时，浏览器 POST/WS 带的 Origin 对不上，`/api` 判成跨站（403）；改掉以后这个本地代理不再区分同源与跨站，真正拦住别人的是 DSH 的会话 cookie（`SameSite=Strict`，只发给同主机）。
- cookie 按改写后的 authority 签发，浏览器按访问地址保存；每一跳改写一致，照常工作。
- 想让插件在这种拓扑下也启用会话交接，启动时加 `--trusted-host <LAN 地址>`，它本来就接受监听地址。
- 「只监听本机」的告警是按「代理在另一台机器」写的，本地代理挡在前面时属预期。

不想装 Caddy，Windows 自带的 TCP 转发也能做，但它不改 Host：

```powershell
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=3080 connectaddress=127.0.0.1 connectport=3081
```

此时 DSH 看到客户端原始的 `Host: 192.168.1.1:3080`，需要给每个会用到的地址加 `--trusted-host`（没有通配），地址一变就要改。

## 反向代理

反向代理放在另一台机器（`reverse_proxy`）上，要满足的条件和三种代理的完整配置都在 [docs/reverse-proxy.md](docs/reverse-proxy.md)。概括起来四件事：原样转发 `Host`、透传 WebSocket 与 SSE、在代理上终止 TLS 并做认证、挂在主机名或独立端口上（客户端资源用绝对路径，子路径会 404）。

## 验证

| 检查 | 位置 | 期望 |
|---|---|---|
| 启动日志 | `localhost` | `remote-access: listening on 192.168.1.1:3080; a reverse proxy on another machine can reach it` |
| 不带 `--trusted-host` 启动 | `localhost` | 日志里没有 `remote-access:` 开头的行，UI 照常 |
| `curl -H 'Host: dsh.example.com' http://<DSH 地址>:3080/` | `reverse_proxy` | 401 |
| `curl -H 'Host: evil.test' http://<DSH 地址>:3080/api/x` | `reverse_proxy` | 403 |
| `curl -i -H 'Host: dsh.example.com' -H 'X-DSH-Remote-Token: <token>' http://<DSH 地址>:3080/__dsh/remote/login` | `reverse_proxy` | `303` + `Set-Cookie: dsh-auth-...` |
| 启动日志（配了 `publicOrigin`） | `localhost` | `public entry https://...`，或未信任权威的 `--trusted-host` 提示 |
| 启动日志（配了 `browseRoot`） | `localhost` | `the in-app directory picker opens at ...`；native 模式则是 `no effect` 告警 |
| 直接打开 `https://dsh.example.com/` | 浏览器 | 自动换会话后进 UI，刷新不掉登录 |
| 发一条消息 | 浏览器 | 流式回复正常，无重连风暴 |
| 「Add workspace...」 | 浏览器 | in-app 目录对话框 |
| 「Add workspace...」（配了 `browseRoot`） | 浏览器 | 对话框从该目录开始，面包屑显示「主目录」 |
| `npm test` | 开发机 | 全绿 |

## 安全

- 会话 cookie 固定 `HttpOnly; SameSite=Strict; Path=/`，没有 `Secure`；公共入口用 https，并保持 http→https 跳转。
- `token` 走请求头，不进 URL，也不要写进代理日志。
- `--host <LAN 地址>` 会把端口开到那块网卡上。只让 `reverse_proxy` 连、其他网段拒绝，交给防火墙、安全组或隧道策略。
- 对外暴露时把 `connection.cookieMaxAgeDays` 调小（≤7）；撤销会话的办法见「会话交接」。
- `browseRoot` 只是对话框的默认位置，不构成访问边界。

## 回滚

移除 bundle：`local-remote-access` 行消失，会话交接路由与目录起点随之消失；Web 服务仍按启动参数绑定，不受影响。移除方式：DSH Web → Plugins → 移除，或 `plugin_manager remove_bundle @local/dsh-remote-access`。

## 开发

```powershell
npm test            # 纯函数 + 假 ctx 行为测试 + 对真实 DSH 安装的冒烟测试
npm run check:patch # 用 DSH 自己的方言解析 cordis.patch.yml，打印实际组合结果
```

`tools/` 只服务本地测试。运行时本包不导入任何 `@deepseek-ai/*`：从本地路径安装的 bundle 是链接进 profile 的，从链接位置解析不到这些包，所以 `index.js` 只依赖 Node 内建模块和同目录文件；冒烟测试借 DSH 的解析规则对真实安装做组合断言。默认指向本机 npx 缓存，可用 `DSH_DEV_MODULES` 覆盖。
