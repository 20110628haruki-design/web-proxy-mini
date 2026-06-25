const express = require('express');
const { fetch } = require('undici');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

function isPrivateHost(host) {
  const h = host.replace(/^
$$|$$$/g, "").split(":")[0];
  if (h === "localhost") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(h) || /^169\.254\./.test(h)) return true;
  return false;
}

// 学習用: 最初は安全なドメインだけ許可（動作確認が目的）
const ALLOW_ANY = false;
const ALLOWED_HOSTS = ["example.com", "wikipedia.org", "developer.mozilla.org"];

function isAllowedHost(host) {
  if (ALLOW_ANY) return true;
  const h = host.split(":")[0].toLowerCase();
  return ALLOWED_HOSTS.some(d => h === d || h.endsWith(`.${d}`));
}

function toProxyUrl(u) {
  return '/proxy?url=' + encodeURIComponent(u);
}

// 超かんたんHTML書き換え: href/src/action/srcset を /proxy?url=... に差し替え
function rewriteHtml(html, baseUrl) {
  const skip = /^(data:|mailto:|tel:|javascript:|blob:)/i;

  // 汎用属性（href, src, action）
  html = html.replace(/(\s)(href|src|action)=("([^"]+)"|'([^']+)'|([^'">\s]+))/gi,
    (m, sp, attr, whole, dq, sq, bare) => {
      const orig = dq || sq || bare || "";
      if (!orig || skip.test(orig)) return m;
      try {
        const abs = new URL(orig, baseUrl);
        if (!/^https?:$/.test(abs.protocol)) return m;
        const val = toProxyUrl(abs.toString());
        const quote = dq !== undefined ? '"' : (sq !== undefined ? "'" : '');
        return `${sp}${attr}=${quote}${val}${quote}`;
      } catch { return m; }
    });

  // srcset（画像の複数解像度指定）
  html = html.replace(/(\ssrcset)=("([^"]+)"|'([^']+)')/gi, (m, sp, whole, dq, sq) => {
    const val = dq || sq || '';
    const out = val.split(',').map(seg => {
      const t = seg.trim();
      if (!t) return t;
      const parts = t.split(/\s+/);
      const url = parts[0];
      if (!url || skip.test(url)) return t;
      try {
        const abs = new URL(url, baseUrl);
        if (!/^https?:$/.test(abs.protocol)) return t;
        parts[0] = toProxyUrl(abs.toString());
        return parts.join(' ');
      } catch { return t; }
    }).join(', ');
    const quote = dq !== undefined ? '"' : "'";
    return `${sp}=${quote}${out}${quote}`;
  });

  // 目印バナーを<body>直後に
  const banner = '<div style="background:#fffae6;padding:8px;border:1px solid #f0e6b6;margin:8px 0;">学習用プロキシ経由の表示です（無課金/簡易）。動作は限定的です。</div>';
  html = html.replace(/<body([^>]*)>/i, (m, attrs) => `<body${attrs}>${banner}`);

  return html;
}

app.get('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('url クエリが必要です。例: /proxy?url=https://example.com');

  let u;
  try {
    u = new URL(target);
    if (!['http:', 'https:'].includes(u.protocol)) {
      return res.status(400).send('http/https 以外のプロトコルは不可です');
    }
    if (isPrivateHost(u.hostname)) {
      return res.status(400).send('その宛先は許可されていません（ローカル/プライベートIP）');
    }
    if (!isAllowedHost(u.hostname)) {
      return res.status(403).send('このホストは現在の設定で許可されていません');
    }
  } catch {
    return res.status(400).send('URL が不正です');
  }

  try {
    const upstream = await fetch(u.toString(), {
      headers: {
        'user-agent': 'Mozilla/5.0 (WebProxy Mini)',
        'accept': '*/*'
      },
      redirect: 'follow'
    });

    const ct = upstream.headers.get('content-type') || 'application/octet-stream';
    res.status(upstream.status);
    res.setHeader('content-type', ct);
    res.setHeader('cache-control', 'no-store');

    if (ct.includes('text/html')) {
      const text = await upstream.text();
      const base = upstream.url || u.toString();
      const out = rewriteHtml(text, base);
      return res.send(out);
    }

    // HTML以外はバッファで返す（学習用の簡易実装）
    const ab = await upstream.arrayBuffer();
    return res.send(Buffer.from(ab));
  } catch (e) {
    console.error(e);
    return res.status(502).send('取得に失敗しました');
  }
});

app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="ja"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Web Proxy Mini (Codespaces)</title>
<style>
 body { font-family: system-ui, sans-serif; max-width: 900px; margin: 24px auto; padding: 0 12px; }
 input[type=url]{ width:100%; padding:10px; font-size:16px; }
 button{ padding:10px 14px; font-size:16px; margin-top:8px; }
 .tips{ color:#555; font-size:14px; }
 .box{ border:1px solid #ddd; padding:12px; margin-top:12px; background:#fafafa; }
</style></head>
<body>
<h1>Web Proxy Mini（無課金・学習用）</h1>
<p class="tips">https://www.wikipedia.org 等でまず確認してね（初期は安全ドメインのみ許可）。</p>
<div class="box">
  <form id="f">
    <input id="u" type="url" placeholder="https://www.wikipedia.org" required />
    <button>開く</button>
  </form>
</div>
<script>
  const f = document.getElementById('f');
  const u = document.getElementById('u');
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = u.value.trim();
    try {
      const x = new URL(v);
      if (!/^https?:$/.test(x.protocol)) throw new Error();
      location.href = '/proxy?url=' + encodeURIComponent(v);
    } catch {
      alert('URLが不正です。https:// から始まるURLを入れてください。');
    }
  });
</script>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`Web Proxy Mini listening on http://localhost:${PORT}`);
});
