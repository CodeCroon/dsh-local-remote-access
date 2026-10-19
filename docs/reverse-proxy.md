# 反向代理：把 `localhost` 上的 DSH 暴露出去

本页写给反向代理所在的那台机器，下称 `reverse_proxy`。`localhost` 侧按 README 装好插件、
启动即可；这里说的是 `reverse_proxy` 上怎么把它转出去。

Caddy、nginx、Traefik、Cloudflare Tunnel、frp 都可以，下面给三种最常见的形式，
其余照着四条约定改。

## 0. 四条约定

1. **原样保留 `Host`。**
   DSH 的会话 cookie 名是 `dsh-auth-{base64url(sha256(authority))}`，cookie 签名也绑定
   同一个 authority。反代把 `Host` 改成 `127.0.0.1:3080` 之类的值，浏览器就永远拿不到
   对得上的 cookie，表现是「打开页面 → 401 → 又回登录」。
2. **透明转发 WebSocket 与 SSE。**
   `/api/remote.mux` 是长期 WebSocket，会话流是 SSE。不要缓冲、不要改写 `Upgrade`，
   也不要给这类响应加压缩。
3. **在 `reverse_proxy` 上终止 TLS 并做认证。**
   DSH 自己只判断「这个请求有没有本进程的会话」，不区分公网与内网。先把公网访客挡在
   basic_auth / forward_auth / Cloudflare Access 之后。
4. **挂在主机名或独立端口上，不要挂在子路径下。**
   浏览器端资源用的是绝对路径（`/plugins/...`、`/api/...`），
   `https://example.com/dsh/` 这种前缀要么 404，要么整页白屏。

## 1. Caddy

```caddyfile
{
	email ops@example.com
}

dsh.example.com {
	encode zstd gzip

	# 外层认证：basic_auth 或 forward_auth 二选一
	basic_auth {
		ops $2a$14$REPLACE_WITH_BCRYPT_HASH
	}

	reverse_proxy 10.0.0.5:3080 {
		header_up Host {host}
		flush_interval -1
	}

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		-Server
	}
}
```

- `10.0.0.5` 换成 `localhost` 在 `reverse_proxy` 看来可达的地址（同网段内网 IP、
  Tailscale IP、ZeroTier IP 都行，能连通即可）。
- `basic_auth { ops <hash> }` 是 Caddy 自带的 HTTP Basic 认证：浏览器弹原生登录框，
  用户名 `ops`，密码只以 bcrypt 哈希形式存在配置里，`<hash>` 用
  `caddy hash-password --plaintext '你的密码'` 生成——别把明文密码填进去。
  它只负责挡浏览器，和插件的 `token` 是两件事；多用户或 MFA 场景换成 `forward_auth`
  / Cloudflare Access，或者把这段删掉、把认证交给上游网关。
- `caddy validate --config Caddyfile` 先过一遍语法。
- 想让浏览器免掉 DSH 登录，再把 §4 的会话交接加上。

## 2. nginx

```nginx
server {
	listen 443 ssl http2;
	server_name dsh.example.com;

	ssl_certificate     /etc/ssl/dsh.example.com.pem;
	ssl_certificate_key /etc/ssl/dsh.example.com.key;

	location / {
		proxy_pass http://10.0.0.5:3080;
		proxy_http_version 1.1;

		# 保留 Host：cookie 与签名受众都绑定它
		proxy_set_header Host $http_host;

		# WebSocket
		proxy_set_header Upgrade $http_upgrade;
		proxy_set_header Connection $connection_upgrade;

		# SSE 不缓冲
		proxy_buffering off;
		proxy_cache off;
		proxy_read_timeout 1h;
	}
}
```

`$connection_upgrade` 需要一行 map（放在 `http {}` 里）：

```nginx
map $http_upgrade $connection_upgrade {
	default upgrade;
	''      close;
}
```

## 3. `reverse_proxy` 没有公网 IP：Cloudflare Tunnel

TLS 由 Cloudflare 终止，隧道出口在 `reverse_proxy` 上：

```sh
cloudflared tunnel login
cloudflared tunnel create dsh
cloudflared tunnel route dns dsh dsh.example.com
cloudflared tunnel run --url http://127.0.0.1:8080 dsh
```

`reverse_proxy` 上的 Caddy 改成只监听本地 HTTP：

```caddyfile
:8080 {
	encode zstd gzip
	reverse_proxy 10.0.0.5:3080 {
		header_up Host {host}
		flush_interval -1
	}
}
```

- Cloudflare 转发的 `Host` 仍是 `dsh.example.com`，交给 DSH 前不要改。
- 认证交给 Cloudflare Access（Zero Trust 里给该域名加策略），Caddy 里可以不要 `basic_auth`；
  DSH 自己的会话校验仍然生效。
- 免费版对空闲 WebSocket/SSE 有超时；DSH 的 mux 有心跳，通常不受影响。

## 4. 会话交接（`token`）

浏览器第一次访问时还没有 DSH 会话。`reverse_proxy` 发现请求里没有 `dsh-auth-*` cookie，
就把 `GET /` 送到 `/__dsh/remote/login` 并注入令牌；插件比对令牌后用 DSH 自己的机制换出
会话 cookie，303 回 `/`，浏览器直接进入 UI。cookie 有效期内不再需要这一步。

**Caddy**

```caddyfile
dsh.example.com {
	basic_auth { ops <hash> }

	# 没有 DSH 会话时，先去换一个
	@noSession {
		path /
		not header Cookie *dsh-auth-*
	}
	handle @noSession {
		redir /__dsh/remote/login
	}

	# 令牌只在这一条路径上注入
	@exchange path /__dsh/remote/login
	handle @exchange {
		reverse_proxy 10.0.0.5:3080 {
			header_up Host {host}
			header_up X-DSH-Remote-Token {env.DSH_REMOTE_TOKEN}
			flush_interval -1
		}
	}

	handle {
		reverse_proxy 10.0.0.5:3080 {
			header_up Host {host}
			flush_interval -1
		}
	}
}
```

**nginx**

```nginx
location = / {
	if ($http_cookie !~* "dsh-auth-") {
		return 302 /__dsh/remote/login;
	}
	proxy_pass http://10.0.0.5:3080;
	proxy_set_header Host $http_host;
	proxy_buffering off;
}

location = /__dsh/remote/login {
	proxy_pass http://10.0.0.5:3080;
	proxy_set_header Host $http_host;
	proxy_set_header X-DSH-Remote-Token REPLACE_WITH_TOKEN;
}

location / {
	proxy_pass http://10.0.0.5:3080;
	proxy_http_version 1.1;
	proxy_set_header Host $http_host;
	proxy_set_header Upgrade $http_upgrade;
	proxy_set_header Connection $connection_upgrade;
	proxy_buffering off;
	proxy_read_timeout 1h;
}
```

要点：

- `localhost` 侧必须用 `--trusted-host <域名>` 启动：它既是 `/api` 围栏的信任声明，也是
  插件的开关。不带这个参数时插件完全不启用，交换路径会 404。
- 用户侧：打开域名 → 过代理认证 → 自动换会话 → 直接进 UI；不需要输入令牌，cookie 过期后
  重走一次。
- DSH 自己的 launch token 每次进程重启都会换，但插件是在进程内取当前值，所以重启后代理
  配置不用动（已有 cookie 在有效期内照旧可用）；需要跟着改的只有你自己更换 `token` 的时候。
- 令牌只发给 `/__dsh/remote/login`，不要做成「所有请求都注入」。
- 交换请求的 `Host` 仍是公共权威，cookie 也按它签发，所以 Host 必须原样转发。
- 交换路径不要缓存；`Set-Cookie` 不能被代理丢掉，否则浏览器会一直重走这一步。
- 路径固定为 `/__dsh/remote/login`，令牌不匹配一律 404，不可枚举。
- 启用后，`reverse_proxy` 的外层认证就是公网到 DSH 会话之间唯一的门：basic_auth 可用，
  多因素场景请用 forward_auth / Cloudflare Access。

## 5. 验证

| 命令（在 `reverse_proxy` 上执行） | 期望 |
|---|---|
| `curl -sS -H 'Host: dsh.example.com' http://10.0.0.5:3080/ \| head` | 401 文本或登录页 HTML |
| `curl -sS -o /dev/null -w '%{http_code}' -H 'Host: evil.test' http://10.0.0.5:3080/api/x` | `403` |
| `curl -i -H 'Host: dsh.example.com' -H 'X-DSH-Remote-Token: <token>' http://10.0.0.5:3080/__dsh/remote/login` | `303` + `Set-Cookie: dsh-auth-...` |
| `curl -sS -o /dev/null -w '%{http_code}' https://dsh.example.com/` | `401`（或外部认证页） |
| 浏览器打开 `https://dsh.example.com/` | 自动换会话后进入 UI，刷新不掉登录 |
| 页面里发一条消息 | 有流式回复，无重连风暴 |

## 6. 排障

| 现象 | 原因 | 处置 |
|---|---|---|
| `/api` 全 403 | 浏览器来的 `Host` 不在 `trustedHosts` | 在 `localhost` 的启动命令补 `--trusted-host <域名>`；插件启动日志会提示 |
| 打开页面 401 循环 | 反代改写了 `Host` | 恢复 `header_up Host {host}` / `proxy_set_header Host $http_host` |
| 打开页面反复 302 | 交换请求没有成功写 cookie（令牌没注入、代理丢了 `Set-Cookie`、Host 变了） | 先按 §5 用 curl 单独打一次交换路径，确认 303 带 `Set-Cookie` |
| 502 / 连接被拒 | 两台机器不通、DSH 只绑了 `127.0.0.1`、防火墙 | 看 `localhost` 的启动日志确认监听地址；再查网络与防火墙 |
| 消息不流式、长时间空白 | 反代缓冲了 SSE | `flush_interval -1`（Caddy）/ `proxy_buffering off`（nginx） |
| WebSocket 连不上 | 没透传 `Upgrade` | 按上面两条示例补齐 |
| 会话交接 404 | 令牌头没注入、路径不对、`token` 没配 | 三处逐个核对；失败一律 404 是设计如此 |
| 登录后浏览器仍 401 | 进程重启后 launch token 轮换，旧 cookie 没换 | 清掉 `dsh-auth-*` cookie，重走一次会话交接 |

## 7. 安全提示

- **令牌只放在请求头里。** 它不进 URL，也不该出现在访问日志；Caddy 默认不记访问日志，
  要记录就别把自定义请求头打进日志。
- 会话 cookie 固定 `HttpOnly; SameSite=Strict; Path=/`，**没有 `Secure`**，所以公共入口
  必须是全站 HTTPS，并保持 http→https 跳转。
- cookie 默认 30 天且 UI 内不能单独撤销。对外暴露时在 `localhost` 上把
  `connection.cookieMaxAgeDays` 调小（≤7）；撤销时删掉 credentials 里的
  `browser-session` 记录。
- 只让 `reverse_proxy` 连到 `localhost` 的 3080（安全组、防火墙、隧道都行）；DSH 那边用
  `--host <本机 LAN 地址>` 启动，两者是两件事。
