# 反向代理：把 `localhost` 上的 DSH 暴露出去

本页写给反向代理所在的那台机器，下称 `reverse_proxy`。`localhost` 侧按 [README](../README.md) 装好插件、启动即可，这里只说怎么把它转出去。

Caddy、nginx、Traefik、Cloudflare Tunnel、frp 都能用，下面给三种常见形式，其余照着这四条改：

1. `Host` 原样转发。会话 cookie 名与签名都绑浏览器看到的 authority，改成上游地址就是 401 循环。
2. 透传 WebSocket 与 SSE。`/api/remote.mux` 是长期 WebSocket，会话流是 SSE；不要缓冲、不要改写 `Upgrade`、不要给这类响应加压缩。
3. 在 `reverse_proxy` 上终止 TLS 并做认证。DSH 自己只判断「请求有没有本进程的会话」，不区分公网与内网，先把公网访客挡在 basic_auth / forward_auth / Cloudflare Access 之后。
4. 挂在主机名或独立端口上。浏览器端资源用绝对路径（`/plugins/...`、`/api/...`），`https://example.com/dsh/` 这种前缀要么 404，要么整页白屏。

## Caddy

```caddyfile
{
	email ops@example.com
}

dsh.example.com {
	encode zstd gzip

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

- `10.0.0.5` 换成从 `reverse_proxy` 能连到的 `localhost` 地址：同网段 IP、Tailscale 或 ZeroTier 都行。
- `basic_auth` 是 Caddy 自带的 HTTP Basic 认证：浏览器弹原生登录框，密码只以 bcrypt 哈希存在配置里，`<hash>` 用 `caddy hash-password --plaintext '你的密码'` 生成。它只挡浏览器，和插件的 `token` 是两件事；多用户或 MFA 换成 `forward_auth` / Cloudflare Access，或者删掉这段把认证交给上游网关。
- `caddy validate --config Caddyfile` 先过语法。
- 想免掉 DSH 登录，把「会话交接」那节的配置加上。

## nginx

```nginx
server {
	listen 443 ssl http2;
	server_name dsh.example.com;

	ssl_certificate     /etc/ssl/dsh.example.com.pem;
	ssl_certificate_key /etc/ssl/dsh.example.com.key;

	location / {
		proxy_pass http://10.0.0.5:3080;
		proxy_http_version 1.1;
		proxy_set_header Host $http_host;

		proxy_set_header Upgrade $http_upgrade;
		proxy_set_header Connection $connection_upgrade;

		proxy_buffering off;
		proxy_cache off;
		proxy_read_timeout 1h;
	}
}
```

`$connection_upgrade` 的 map 放在 `http {}` 里：

```nginx
map $http_upgrade $connection_upgrade {
	default upgrade;
	''      close;
}
```

`$http_host` 会把浏览器带的端口一起保留，和 `header_up Host {host}` 等价。

## Cloudflare Tunnel

`reverse_proxy` 没有公网 IP 时，TLS 由 Cloudflare 终止，隧道出口在 `reverse_proxy` 上：

```sh
cloudflared tunnel login
cloudflared tunnel create dsh
cloudflared tunnel route dns dsh dsh.example.com
cloudflared tunnel run --url http://127.0.0.1:8080 dsh
```

Caddy 改成不终止 TLS，监听 `:8080`：

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
- 认证交给 Cloudflare Access（Zero Trust 里给该域名加策略），Caddy 里可以不要 `basic_auth`；DSH 自己的会话校验仍然生效。
- 免费版对空闲 WebSocket/SSE 有超时；DSH 的 mux 有心跳，通常不受影响。

## 会话交接

浏览器第一次访问时还没有 DSH 会话。代理发现请求里没有 `dsh-auth-*` cookie，就把 `GET /` 送到 `/__dsh/remote/login` 并注入令牌；插件换出会话后 303 回 `/`，cookie 有效期内不再需要这一步。完整原理见 [README 的会话交接](../README.md#会话交接)。

Caddy 的写法：

```caddyfile
dsh.example.com {
	basic_auth { ops <hash> }

	@noSession {
		path /
		not header Cookie *dsh-auth-*
	}
	handle @noSession {
		redir /__dsh/remote/login
	}

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

nginx 的写法：

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

几点：

- `localhost` 侧必须用 `--trusted-host <域名>` 启动，不带这个参数插件完全不启用，交换路径会 404。
- 令牌只发给 `/__dsh/remote/login`，不要做成所有请求都注入。
- 交换路径不要缓存，`Set-Cookie` 不能被代理丢掉，否则浏览器会一直重走这一步。
- 路径固定，令牌不匹配一律 404，不是配置错误。
- 启用后，代理的外层认证就是公网到 DSH 会话之间唯一的门：basic_auth 够用，多因素用 forward_auth / Cloudflare Access。

## 验证

| 命令（在 `reverse_proxy` 上执行） | 期望 |
|---|---|
| `curl -sS -H 'Host: dsh.example.com' http://10.0.0.5:3080/ \| head` | 401 文本或登录页 HTML |
| `curl -sS -o /dev/null -w '%{http_code}' -H 'Host: evil.test' http://10.0.0.5:3080/api/x` | `403` |
| `curl -i -H 'Host: dsh.example.com' -H 'X-DSH-Remote-Token: <token>' http://10.0.0.5:3080/__dsh/remote/login` | `303` + `Set-Cookie: dsh-auth-...` |
| `curl -sS -o /dev/null -w '%{http_code}' https://dsh.example.com/` | `401`（或外部认证页） |
| 浏览器打开 `https://dsh.example.com/` | 自动换会话后进入 UI，刷新不掉登录 |
| 页面里发一条消息 | 有流式回复，无重连风暴 |

## 排障

| 现象 | 原因 | 处置 |
|---|---|---|
| `/api` 全 403 | 浏览器来的 `Host` 不在 `trustedHosts` | 在 `localhost` 的启动命令补 `--trusted-host <域名>`；插件启动日志会提示 |
| 打开页面 401 循环 | 反代改写了 `Host` | 恢复 `header_up Host {host}` / `proxy_set_header Host $http_host` |
| 打开页面反复跳登录 | 交换请求没成功写 cookie：令牌没注入、代理丢了 `Set-Cookie`、Host 变了 | 先按「验证」用 curl 单独打一次交换路径，确认 303 带 `Set-Cookie` |
| 502 / 连接被拒 | 两台机器不通、DSH 只绑了 `127.0.0.1`、防火墙 | 看 `localhost` 的启动日志确认监听地址，再查网络与防火墙 |
| 消息不流式、长时间空白 | 反代缓冲了 SSE | `flush_interval -1`（Caddy）/ `proxy_buffering off`（nginx） |
| WebSocket 连不上 | 没透传 `Upgrade` | 按上面两个示例补齐 |
| 会话交接 404 | 令牌头没注入、路径不对、`token` 没配 | 三处逐个核对；失败一律 404 是设计如此 |

## 安全

- 令牌只放在请求头里：不进 URL，也不要出现在访问日志；Caddy 默认不记访问日志，要记就别把 `X-DSH-Remote-Token` 打进日志。
- 公共入口必须全站 HTTPS 并保持 http→https 跳转：会话 cookie 只有 `HttpOnly; SameSite=Strict`，没有 `Secure`。
- 只放这一个入口：`localhost` 的 3080 只允许 `reverse_proxy` 连（安全组、防火墙、隧道都行）；DSH 那边用 `--host <本机 LAN 地址>` 启动。
- cookie 的有效期与撤销见 README 的「会话交接」，`browseRoot` 的边界见「安全」一节。
