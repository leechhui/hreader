/* ================================================================
 * 简读 · 静态服务器 + 跨域代理（零依赖，Node 18+）
 *
 * 用法：
 *   node server.js          # 默认端口 8000
 *   node server.js 8080     # 指定端口
 *
 * 提供：
 *   1) 静态文件服务：当前目录（默认入口 index.html）
 *   2) /proxy?url=xxx ：服务端抓取 txt 直链，绕开浏览器跨域(CORS)
 *
 * 页面中使用：书库 → 链接导入 → 代理选「服务器 /proxy」
 *
 * 注意：
 *   - /proxy 仅解决 CORS；百度网盘等需要登录/提取码的分享链接，
 *     服务端同样无法解析（平台鉴权限制），请先下载到本地再导入。
 *   - 对外公开部署时，/proxy 可被他人用于抓取公网 URL（已拦截内网地址）。
 * ================================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = __dirname;
const PORT = parseInt(process.argv[2] || process.env.PORT || '8000', 10);
const TIMEOUT_MS = 30000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

function send(res, code, body, type){
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

/* 基本 SSRF 防护：拒绝内网/本机地址 */
function isInternalHost(host){
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return true;
  if (h.endsWith('.local') || h.endsWith('.localhost')) return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  return false;
}

const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); }
  catch(e){ return send(res, 400, '请求格式无效'); }

  /* ---------- 跨域代理 ---------- */
  if (u.pathname === '/proxy' || u.pathname === '/proxy/'){
    if (req.method !== 'GET') return send(res, 405, '仅支持 GET');
    const target = u.searchParams.get('url');
    if (!target || !/^https?:\/\//i.test(target)){
      return send(res, 400, '缺少 url 参数（仅支持 http/https 链接）');
    }
    try {
      const t = new URL(target);
      if (isInternalHost(t.hostname)){
        return send(res, 400, '不允许访问内网地址');
      }
    } catch(e){
      return send(res, 400, '链接格式无效');
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    fetch(target, { signal: ctrl.signal })
      .then(r => r.arrayBuffer())
      .then(buf => {
        clearTimeout(timer);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': buf.byteLength,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        res.end(Buffer.from(buf));
      })
      .catch(err => {
        clearTimeout(timer);
        send(res, 502, '抓取失败：' + err.message);
      });
    return;
  }

  /* ---------- 静态文件 ---------- */
  let p;
  try { p = decodeURIComponent(u.pathname); }
  catch(e){ return send(res, 400, '路径格式无效'); }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)){
    return send(res, 403, '禁止访问');
  }
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, '404 Not Found');
    const ext = path.extname(file).toLowerCase();
    send(res, 200, data, MIME[ext] || 'application/octet-stream');
  });
});

server.listen(PORT, () => {
  console.log('简读已启动：http://localhost:' + PORT);
  console.log('跨域代理：http://localhost:' + PORT + '/proxy?url=你的txt直链');
});
