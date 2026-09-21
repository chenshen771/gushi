export default {
  async scheduled(event, env, ctx) {
    // Cloudflare Cron：关网页也会跑。Dashboard → Triggers → Cron 例如 0 22 * * * (UTC≈北京时间06:00)
    ctx.waitUntil(runSectorDailyJob(env).catch(function (e) {
      console.log('sector daily job fail', String(e));
    }));
  },

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/health') {
      return json({
        ok: true,
        service: 'gushi',
        hasDb: !!env.DB,
        hasKey: !!env.FINNHUB_API_KEY,
        hasAppSecret: !!env.APP_SECRET,
        hasAI: !!env.AI,
        hasGemini: !!env.GEMINI_API_KEY,
        hasDeepseek: !!env.DEEPSEEK_API_KEY,
        hasOpenAI: !!env.OPENAI_API_KEY,
        hasBrowse: !!env.browse,
      });
    }

    if (path === '/webhook/finnhub' && request.method === 'POST') {
      try {
        if (!env.DB) return json({ ok: false, error: 'DB not bound' }, 500);
        const body = await request.text();
        await env.DB.prepare(
          'INSERT INTO webhook_events (source, payload, created_at) VALUES (?, ?, ?)'
        )
          .bind('finnhub', body, new Date().toISOString())
          .run();
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    if (path === '/api/quote' && request.method === 'GET') {
      const symbol = url.searchParams.get('symbol') || 'AAPL';
      const token = env.FINNHUB_API_KEY;
      if (!token) return json({ error: 'FINNHUB_API_KEY not set' }, 500);
      try {
        const api =
          'https://finnhub.io/api/v1/quote?symbol=' +
          encodeURIComponent(symbol) +
          '&token=' +
          token;
        const r = await fetch(api);
        const data = await r.text();
        return new Response(data, {
          status: r.status,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=5',
          },
        });
      } catch (e) {
        return json({ error: String(e) }, 502);
      }
    }

    const apiResp = await handleApi(request, env, url);
    if (apiResp) return apiResp;

    const target = url.searchParams.get('url');
    if (!target) {
      if (path === '/' || path === '') {
        return json({
          ok: true,
          service: 'gushi',
          usage: {
            health: '/health',
            proxy: '?url=https://...',
            quote: '/api/quote?symbol=AAPL',
            bars: 'GET/POST /api/bars',
            predictions: '/api/predictions',
            positions: '/api/positions',
            ai: 'POST /api/ai/run',
            browse: 'POST /api/browse',
            cache: 'GET/POST /api/cache · POST /api/cache/purge',
            webhook: 'POST /webhook/finnhub',
            cronSector: 'GET/POST /api/cron/sector-daily (需 X-App-Key)',
          },
        });
      }
      return json(
        {
          error: 'missing url param',
          example:
            '?url=https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?interval=1d&range=5d',
        },
        400
      );
    }

    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return json({ error: 'invalid url' }, 400);
    }

    const allow = [
      'query1.finance.yahoo.com',
      'query2.finance.yahoo.com',
      'push2delay.eastmoney.com',
      'push2.eastmoney.com',
      'push2his.eastmoney.com',
      '79.push2.eastmoney.com',
      '82.push2.eastmoney.com',
      '94.push2.eastmoney.com',
      'np-listapi.eastmoney.com',
      'datacenter-web.eastmoney.com',
      'datacenter.eastmoney.com',
      'finance.eastmoney.com',
      'finnhub.io',
      'www.federalreserve.gov',
      'federalreserve.gov',
    ];
    if (
      !allow.some(
        (d) => parsed.hostname === d || parsed.hostname.endsWith('.' + d)
      )
    ) {
      return json({ error: 'domain not allowed: ' + parsed.hostname }, 403);
    }

    try {
      const res = await fetch(target, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json,text/plain,*/*',
        },
      });
      const body = await res.text();
      return new Response(body, {
        status: res.status,
        headers: {
          'Content-Type':
            res.headers.get('Content-Type') ||
            'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=30',
        },
      });
    } catch (e) {
      return json({ error: String(e) }, 502);
    }
  },
};

function json(obj, status) {
  status = status || 200;
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function checkAuth(request, env) {
  const key = request.headers.get('X-App-Key');
  return !!(env.APP_SECRET && key && key === env.APP_SECRET);
}

async function handleApi(request, env, url) {
  if (url.pathname === '/api/bars/upsert' && request.method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'forbidden' }, 403);
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    try {
      const body = await request.json();
      if (!body.symbol || !Array.isArray(body.bars)) {
        return json({ error: 'need symbol and bars[]' }, 400);
      }
      const stmt = env.DB.prepare(
        'INSERT INTO daily_bars (symbol,date,open,high,low,close,volume) VALUES (?,?,?,?,?,?,?) ON CONFLICT(symbol,date) DO UPDATE SET open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume'
      );
      const batch = body.bars.map(function (b) {
        return stmt.bind(
          body.symbol,
          b.date,
          b.open,
          b.high,
          b.low,
          b.close,
          b.volume || 0
        );
      });
      await env.DB.batch(batch);
      return json({ ok: true, count: batch.length });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/bars' && request.method === 'GET') {
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    const symbol = url.searchParams.get('symbol');
    if (!symbol) return json({ error: 'missing symbol' }, 400);
    const from = url.searchParams.get('from') || '2000-01-01';
    const to = url.searchParams.get('to') || '2100-01-01';
    try {
      const res = await env.DB.prepare(
        'SELECT date,open,high,low,close,volume FROM daily_bars WHERE symbol=? AND date BETWEEN ? AND ? ORDER BY date ASC'
      )
        .bind(symbol, from, to)
        .all();
      return json({ symbol: symbol, bars: res.results || [] });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/predictions' && request.method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'forbidden' }, 403);
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    try {
      const b = await request.json();
      const id = b.id || crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO prediction_log (id,symbol,mode,predicted_at,price_at_predict,p_up,p_down,target_high,target_low,horizon_days) VALUES (?,?,?,?,?,?,?,?,?,?)'
      )
        .bind(
          id,
          b.symbol,
          b.mode || 'backtest',
          b.predicted_at || new Date().toISOString(),
          b.price_at_predict,
          b.p_up,
          b.p_down,
          b.target_high,
          b.target_low,
          b.horizon_days || 1
        )
        .run();
      return json({ ok: true, id: id });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/predictions/resolve' && request.method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'forbidden' }, 403);
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    try {
      const b = await request.json();
      const res = await env.DB.prepare(
        'SELECT price_at_predict FROM prediction_log WHERE id=?'
      )
        .bind(b.id)
        .all();
      if (!res.results || !res.results.length) {
        return json({ error: 'not found' }, 404);
      }
      const before = res.results[0].price_at_predict;
      var result = 'flat';
      if (b.actual_price > before) result = 'up';
      else if (b.actual_price < before) result = 'down';
      await env.DB.prepare(
        'UPDATE prediction_log SET actual_price=?, actual_result=?, resolved_at=? WHERE id=?'
      )
        .bind(b.actual_price, result, new Date().toISOString(), b.id)
        .run();
      return json({ ok: true, result: result });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/predictions/winrate' && request.method === 'GET') {
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    try {
      const days = Number(url.searchParams.get('days') || 30);
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const res = await env.DB.prepare(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN (p_up>=50 AND actual_result='up') OR (p_up<50 AND actual_result='down') THEN 1 ELSE 0 END) AS correct FROM prediction_log WHERE resolved_at IS NOT NULL AND predicted_at >= ?"
      )
        .bind(since)
        .all();
      const row = (res.results && res.results[0]) || { total: 0, correct: 0 };
      const winRate = row.total ? row.correct / row.total : null;
      return json({ total: row.total, correct: row.correct, winRate: winRate });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/positions' && request.method === 'GET') {
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    try {
      const status = url.searchParams.get('status');
      const symbol = url.searchParams.get('symbol');
      var sql = 'SELECT * FROM positions WHERE 1=1';
      var binds = [];
      if (status && status !== 'all') {
        sql += ' AND status=?';
        binds.push(status);
      }
      if (symbol) {
        sql += ' AND symbol=?';
        binds.push(symbol);
      }
      sql += ' ORDER BY buy_at DESC';
      var stmt = env.DB.prepare(sql);
      var res2;
      if (binds.length) res2 = await stmt.bind.apply(stmt, binds).all();
      else res2 = await stmt.all();
      return json({ positions: res2.results || [] });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/positions' && request.method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'forbidden' }, 403);
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    try {
      const b = await request.json();
      if (!b.symbol || b.qty == null || b.buy_price == null) {
        return json({ error: 'need symbol, qty, buy_price' }, 400);
      }
      const id = b.id || crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.prepare(
        'INSERT INTO positions (id,symbol,market,side,qty,buy_price,buy_at,status,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      )
        .bind(
          id,
          b.symbol,
          b.market || 'us',
          b.side || 'long',
          b.qty,
          b.buy_price,
          b.buy_at || now,
          'open',
          b.note || null,
          now,
          now
        )
        .run();
      return json({ ok: true, id: id });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/positions/close' && request.method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'forbidden' }, 403);
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    try {
      const b = await request.json();
      if (!b.id || b.sell_price == null) {
        return json({ error: 'need id, sell_price' }, 400);
      }
      const now = new Date().toISOString();
      await env.DB.prepare(
        "UPDATE positions SET sell_price=?, sell_at=?, status='closed', updated_at=? WHERE id=?"
      )
        .bind(b.sell_price, b.sell_at || now, now, b.id)
        .run();
      return json({ ok: true, id: b.id });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/positions/delete' && request.method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'forbidden' }, 403);
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    try {
      const b = await request.json();
      if (!b.id) return json({ error: 'need id' }, 400);
      await env.DB.prepare('DELETE FROM positions WHERE id=?').bind(b.id).run();
      return json({ ok: true });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/ai/run' && request.method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'forbidden' }, 403);
    try {
      const b = await request.json();
      const provider = String(b.provider || 'workers-ai').toLowerCase();
      const messages = b.messages || [
        { role: 'user', content: b.title || b.prompt || '' },
      ];

      if (provider === 'workers-ai') {
        if (!env.AI) return json({ error: 'AI not bound' }, 500);
        const model = b.model || '@cf/meta/llama-3.2-3b-instruct';
        const result = await env.AI.run(model, { messages: messages });
        return json({
          provider: provider,
          model: model,
          text: (result && (result.response || result.text)) || '',
          raw: result,
        });
      }

      if (provider === 'gemini') {
        if (!env.GEMINI_API_KEY) {
          return json({ error: 'GEMINI_API_KEY not set' }, 500);
        }
        const model = b.model || 'gemini-2.0-flash';
        const contents = messages.map(function (m) {
          return {
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          };
        });
        const api =
          'https://generativelanguage.googleapis.com/v1beta/models/' +
          encodeURIComponent(model) +
          ':generateContent?key=' +
          encodeURIComponent(env.GEMINI_API_KEY);
        const r = await fetch(api, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: contents }),
        });
        const data = await r.json();
        var out = '';
        try {
          const c0 = (data.candidates || [])[0] || {};
          const parts = (c0.content && c0.content.parts) || [];
          out = parts
            .map(function (p) {
              return p.text || '';
            })
            .join('');
        } catch (e2) {}
        return json({
          provider: provider,
          model: model,
          text: out,
          raw: data,
          status: r.status,
        });
      }

      if (provider === 'deepseek') {
        if (!env.DEEPSEEK_API_KEY) {
          return json({ error: 'DEEPSEEK_API_KEY not set' }, 500);
        }
        const model = b.model || 'deepseek-chat';
        const r = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + env.DEEPSEEK_API_KEY,
          },
          body: JSON.stringify({ model: model, messages: messages }),
        });
        const data = await r.json();
        var out2 = '';
        try {
          out2 =
            (((data.choices || [])[0] || {}).message || {}).content || '';
        } catch (e3) {}
        return json({
          provider: provider,
          model: model,
          text: out2,
          raw: data,
          status: r.status,
        });
      }

      if (provider === 'openai') {
        if (!env.OPENAI_API_KEY) {
          return json({ error: 'OPENAI_API_KEY not set' }, 500);
        }
        const model = b.model || 'gpt-4o-mini';
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + env.OPENAI_API_KEY,
          },
          body: JSON.stringify({ model: model, messages: messages }),
        });
        const data = await r.json();
        var out3 = '';
        try {
          out3 =
            (((data.choices || [])[0] || {}).message || {}).content || '';
        } catch (e4) {}
        return json({
          provider: provider,
          model: model,
          text: out3,
          raw: data,
          status: r.status,
        });
      }

      return json({ error: 'unknown provider: ' + provider }, 400);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/news/judge' && request.method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'forbidden' }, 403);
    if (!env.AI) return json({ error: 'AI not bound' }, 500);
    try {
      const b = await request.json();
      const result = await env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
        messages: [
          {
            role: 'system',
            content:
              '你是判断股票新闻标题对股价影响的助手。只用这个格式回答，不要多余文字：方向|程度\n方向只能是 利好/利空/中性 三选一，程度是1到10的整数。例如：利空|7',
          },
          { role: 'user', content: b.title || '' },
        ],
      });
      const raw = ((result && result.response) || '').trim();
      const parts = raw.split('|');
      return json({
        title: b.title,
        direction: (parts[0] || '中性').trim(),
        score: Number(parts[1]) || 0,
        raw: raw,
      });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }


  // ---- 通用云端缓存（打开网页时读写；关网页不跑）----
  if (url.pathname === '/api/cache' && request.method === 'GET') {
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    const key = url.searchParams.get('key');
    if (!key) return json({ error: 'missing key' }, 400);
    try {
      const res = await env.DB.prepare(
        'SELECT key, value, updated_at, expires_at FROM cache_kv WHERE key = ?'
      )
        .bind(key)
        .all();
      const row = res.results && res.results[0];
      if (!row) return json({ ok: true, found: false, key: key });
      if (row.expires_at) {
        const exp = Date.parse(row.expires_at);
        if (!isNaN(exp) && exp < Date.now()) {
          try {
            await env.DB.prepare('DELETE FROM cache_kv WHERE key = ?').bind(key).run();
          } catch (eDel) {}
          return json({ ok: true, found: false, key: key, expired: true });
        }
      }
      var data = null;
      try {
        data = JSON.parse(row.value);
      } catch (eParse) {
        data = row.value;
      }
      return json({
        ok: true,
        found: true,
        key: row.key,
        data: data,
        updated_at: row.updated_at,
        expires_at: row.expires_at,
      });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/cache' && request.method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'forbidden' }, 403);
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    try {
      const b = await request.json();
      if (!b || !b.key) return json({ error: 'need key' }, 400);
      const now = new Date().toISOString();
      var expires = null;
      const ttlDays = Number(b.ttlDays);
      if (ttlDays > 0) {
        expires = new Date(Date.now() + ttlDays * 86400000).toISOString();
      } else if (b.expires_at) {
        expires = String(b.expires_at);
      }
      const value =
        typeof b.data === 'string' ? b.data : JSON.stringify(b.data == null ? null : b.data);
      if (value.length > 900000) {
        return json({ error: 'payload too large' }, 413);
      }
      await env.DB.prepare(
        'INSERT INTO cache_kv (key, value, updated_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, expires_at=excluded.expires_at'
      )
        .bind(b.key, value, now, expires)
        .run();
      // 顺手清理同前缀过期项（可选 prefix）
      if (b.purgePrefix) {
        try {
          await env.DB.prepare(
            "DELETE FROM cache_kv WHERE key LIKE ? AND expires_at IS NOT NULL AND expires_at < ?"
          )
            .bind(String(b.purgePrefix) + '%', now)
            .run();
        } catch (eP) {}
      }
      return json({ ok: true, key: b.key, updated_at: now, expires_at: expires });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/cache/purge' && request.method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'forbidden' }, 403);
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    try {
      const b = (await request.json().catch(function () { return {}; })) || {};
      const now = new Date().toISOString();
      var deleted = 0;
      // 1) 删已过期
      const r1 = await env.DB.prepare(
        'DELETE FROM cache_kv WHERE expires_at IS NOT NULL AND expires_at < ?'
      )
        .bind(now)
        .run();
      deleted += (r1 && r1.meta && r1.meta.changes) || 0;
      // 2) 按前缀 + 最大保留天数（updated_at 过旧）
      const maxAgeDays = Number(b.maxAgeDays);
      if (b.prefix && maxAgeDays > 0) {
        const cut = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
        const r2 = await env.DB.prepare(
          'DELETE FROM cache_kv WHERE key LIKE ? AND updated_at < ?'
        )
          .bind(String(b.prefix) + '%', cut)
          .run();
        deleted += (r2 && r2.meta && r2.meta.changes) || 0;
      }
      return json({ ok: true, deleted: deleted });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/browse' && request.method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'forbidden' }, 403);
    try {
      const b = await request.json();
      if (!b.url) return json({ error: 'missing url' }, 400);
      var targetUrl;
      try {
        targetUrl = new URL(b.url);
      } catch (e5) {
        return json({ error: 'invalid url' }, 400);
      }
      if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
        return json({ error: 'only http/https' }, 400);
      }
      const r = await fetch(targetUrl.toString(), {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
      });
      var body = await r.text();
      const max = 200000;
      if (body.length > max) body = body.slice(0, max);
      if ((b.mode || 'text') === 'text') {
        body = body
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 50000);
      }
      return json({
        ok: true,
        status: r.status,
        url: targetUrl.toString(),
        mode: b.mode || 'text',
        content: body,
        note: '简易抓取；需 JS 渲染的页面以后可用 Puppeteer 增强',
      });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }


  // ---- 板块每日后台任务：关网页也能跑（Cron 或手动触发）----
  if (url.pathname === '/api/cron/sector-daily') {
    if (!checkAuth(request, env)) return json({ error: 'forbidden' }, 403);
    try {
      const result = await runSectorDailyJob(env);
      return json({ ok: true, ...result });
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }
  }

  return null;
}



/** 与网页 classifyOneEmSymbol 对齐：东财全表 → 一级/二级归类 */
const US_EM_SYMBOL_MAP = {
      /* 存储 / 内存 */
      SKHY: { l1: 'tech', l2: 'storage' }, SKH: { l1: 'tech', l2: 'storage' },
      MU: { l1: 'tech', l2: 'storage' }, WDC: { l1: 'tech', l2: 'storage' }, STX: { l1: 'tech', l2: 'storage' },
      SNDK: { l1: 'tech', l2: 'storage' }, NTAP: { l1: 'tech', l2: 'storage' }, PSTG: { l1: 'tech', l2: 'storage' },
      /* 半导体 */
      CBRS: { l1: 'tech', l2: 'semi' }, NVDA: { l1: 'tech', l2: 'semi' }, AMD: { l1: 'tech', l2: 'semi' },
      TSM: { l1: 'tech', l2: 'semi' }, AVGO: { l1: 'tech', l2: 'semi' }, ASML: { l1: 'tech', l2: 'semi' },
      INTC: { l1: 'tech', l2: 'semi' }, QCOM: { l1: 'tech', l2: 'semi' }, ARM: { l1: 'tech', l2: 'semi' },
      ALAB: { l1: 'tech', l2: 'semi' }, CRDO: { l1: 'tech', l2: 'semi' }, AAOI: { l1: 'tech', l2: 'optical' },
      /* 算力服务器 */
      SMCI: { l1: 'tech', l2: 'datacenter' },
      /* 电力 / 能源设备 */
      PSIX: { l1: 'energy', l2: 'energy_eq' }, NMAD: { l1: 'energy', l2: 'energy_eq' },
      /* 医疗 */
      BNR: { l1: 'health', l2: 'biotech' }, HSCS: { l1: 'health', l2: 'device' },
      TYRA: { l1: 'health', l2: 'biotech' }, AIRS: { l1: 'health', l2: 'device' },
      /* 物流航运 */
      FWRD: { l1: 'mfg', l2: 'logistics' }, EDRY: { l1: 'mfg', l2: 'logistics' }, CMDB: { l1: 'mfg', l2: 'logistics' },
      /* 消费 */
      RDI: { l1: 'consumer', l2: 'discretionary' },
      /* 航天 */
      ASTS: { l1: 'mfg', l2: 'defense' }, RKLB: { l1: 'mfg', l2: 'defense' }, LUNR: { l1: 'mfg', l2: 'defense' }
    };

const US_EM_L2_RULES = [
      { l1: 'tech', l2: 'semi', kw: /\b(nvda|tsm|amd|intc|qcom|arm|mrcy|on\b|swks|mpwr)\b/i },
      { l1: 'tech', l2: 'software', kw: /\b(microsoft|oracle|salesforce|adobe|servicenow|snowflake|intuit|datadog|mongodb|hubspot)\b/i },
      { l1: 'fin', l2: 'bank', kw: /\b(jpmorgan|bank of america|wells fargo|citigroup|goldman|morgan stanley)\b|摩根|高盛|花旗/i },
      { l1: 'health', l2: 'biotech', kw: /\b(pfizer|moderna|amgen|gilead|regeneron|vertex|biogen)\b|辉瑞|生物制药/i },
      { l1: 'energy', l2: 'oil', kw: /\b(exxon|chevron|conocophillips|schlumberger|halliburton)\b|埃克森|雪佛龙/i },
      { l1: 'consumer', l2: 'retail', kw: /\b(walmart|costco|target|home depot|nike|starbucks|mcdonald)\b|沃尔玛|耐克|星巴克/i },
      
      { l1: 'tech', l2: 'storage', kw: /\b(memory|dram|nand|ssd|hdd|storage|flash|hynix|micron|seagate)\b|western digital|存储|内存|闪存|硬盘|海力士/i },
      { l1: 'tech', l2: 'semi', kw: /\b(semiconductor|chipmaker|foundry|wafer|gpu|fpga|asic|lithography|cerebras)\b|\bsemi\b|芯片|半导体|晶圆/i },
      { l1: 'tech', l2: 'software', kw: /\b(software|saas|cloud computing|cloud software)\b|软件|云计算(?!安全)/i },
      { l1: 'tech', l2: 'cyber', kw: /\b(cybersecurity|cyber security|information security)\b|网络安全|信息安全/i },
      { l1: 'tech', l2: 'hardware', kw: /\b(server|laptop|pc hardware|computer hardware)\b|服务器|硬件设备/i },
      { l1: 'tech', l2: 'optical', kw: /\b(optical module|photonics|transceiver|光模块|光通信)\b/i },
      { l1: 'tech', l2: 'datacenter', kw: /\b(datacenter|data center|data-centre|数据中心)\b/i },
      { l1: 'tech', l2: 'eda', kw: /\b(eda|electronic design automation|semiconductor equipment|chip equipment)\b|eda|半导体设备|光刻/i },
      { l1: 'internet', l2: 'platform', kw: /\b(internet platform|social media|e-?commerce|search engine)\b|互联网平台|电商|社交网络/i },
      { l1: 'internet', l2: 'telecom', kw: /\b(telecom|telecommunications|5g|6g|wireless carrier)\b|电信|通信运营/i },
      { l1: 'internet', l2: 'media', kw: /\b(streaming|gaming company|digital media)\b|流媒体|游戏公司|数字传媒/i },
      { l1: 'mfg', l2: 'ev', kw: /\b(electric vehicle|\bev\b|ev maker)\b|电动车|新能源车/i },
      { l1: 'mfg', l2: 'battery', kw: /\b(battery|lithium-?ion)\b|锂电池|锂电/i },
      { l1: 'mfg', l2: 'robot', kw: /\b(robotics|industrial robot|automation equipment)\b|工业机器人|自动化设备/i },
      { l1: 'mfg', l2: 'defense', kw: /\b(aerospace|defense contractor|defence)\b|军工|航天国防/i },
      { l1: 'mfg', l2: 'logistics', kw: /\b(logistics|freight|shipping line|airline|rail freight|bulkers)\b|物流|航运|货运|航空运输/i },
      { l1: 'energy', l2: 'oil', kw: /\b(oil|petroleum|natural gas|upstream)\b|石油|油气|天然气(?!电力)/i },
      { l1: 'energy', l2: 'solar', kw: /\b(solar|photovoltaic)\b|光伏|太阳能/i },
      { l1: 'energy', l2: 'energy_eq', kw: /\b(power solutions|power equipment|grid equipment|utility)\b|电力方案|电力设备|电网/i },
      { l1: 'energy', l2: 'metals', kw: /\b(mining|copper mine|steel producer)\b|有色|矿业|钢铁/i },
      { l1: 'energy', l2: 'gold', kw: /\b(gold mine|gold mining)\b|金矿|黄金开采/i },
      { l1: 'fin', l2: 'bank', kw: /\b(bank|banking)\b|银行(?!科技)/i },
      { l1: 'fin', l2: 'asset', kw: /\b(asset management|broker-?dealer|investment bank)\b|资管|券商/i },
      { l1: 'fin', l2: 'fintech', kw: /\b(fintech|payment processor|digital payment)\b|金融科技|支付科技/i },
      { l1: 'health', l2: 'biotech', kw: /\b(biotech|bioscience|therapeutics|oncology)\b|生物科技|生物制药/i },
      { l1: 'health', l2: 'biopharma', kw: /\b(pharma|pharmaceutical)\b|制药|医药/i },
      { l1: 'health', l2: 'device', kw: /\b(medical device|medtech|diagnostic device)\b|医疗器械|诊断设备/i },
      { l1: 'health', l2: 'hcare_svc', kw: /\b(hospital|health services|managed care)\b|医院|医疗服务/i },
      { l1: 'consumer', l2: 'staples', kw: /\b(food products|beverage|consumer staples)\b|食品|饮料/i },
      { l1: 'consumer', l2: 'discretionary', kw: /\b(retail|restaurant|apparel|cinema)\b|零售|餐饮|服装/i },
      { l1: 'consumer', l2: 'reit', kw: /\b(reit|real estate investment)\b|房地产投资/i },
      { l1: 'consumer', l2: 'luxury', kw: /\b(luxury|hotel|travel services)\b|奢侈|酒店|旅游服务/i }
    ];

const US_EM_F100_MAP = {
  '信息技术': { l1: 'tech', l2: 'hardware' },
  '通讯服务': { l1: 'internet', l2: 'telecom' },
  '通信服务': { l1: 'internet', l2: 'telecom' },
  '工业': { l1: 'mfg', l2: 'robot' },
  '能源': { l1: 'energy', l2: 'oil' },
  '原材料': { l1: 'energy', l2: 'metals' },
  '公用事业': { l1: 'energy', l2: 'energy_eq' },
  '金融': { l1: 'fin', l2: 'fintech' },
  '房地产': { l1: 'consumer', l2: 'reit' },
  '医疗保健': { l1: 'health', l2: 'biotech' },
  '日常消费品': { l1: 'consumer', l2: 'staples' },
  '非日常生活消费品': { l1: 'consumer', l2: 'discretionary' },
  '可选消费': { l1: 'consumer', l2: 'discretionary' },
};

const US_L1_META = [
  { id: 'tech', name: '科技与电子', en: 'Technology', subCount: 8 },
  { id: 'internet', name: '互联网与通信', en: 'Internet & Telecom', subCount: 4 },
  { id: 'mfg', name: '先进制造与工业', en: 'Industrials', subCount: 5 },
  { id: 'energy', name: '资源与能源', en: 'Energy & Materials', subCount: 5 },
  { id: 'fin', name: '金融与商业服务', en: 'Financials', subCount: 3 },
  { id: 'health', name: '医疗与大健康', en: 'Healthcare', subCount: 4 },
  { id: 'consumer', name: '大消费与地产', en: 'Consumer & RE', subCount: 4 },
];

function classifyOneEmSymbolWorker(sym, name, industry) {
  sym = String(sym || '').toUpperCase().trim();
  var nm = String(name || '');
  var text = (sym + ' ' + nm).toLowerCase();
  if (US_EM_SYMBOL_MAP[sym]) return US_EM_SYMBOL_MAP[sym];
  for (var i = 0; i < US_EM_L2_RULES.length; i++) {
    var r = US_EM_L2_RULES[i];
    if (r.kw && r.kw.test(text)) return { l1: r.l1, l2: r.l2 };
  }
  var ind = String(industry || '').trim();
  if (ind && ind !== '-' && ind !== '—') {
    if (US_EM_F100_MAP[ind]) return US_EM_F100_MAP[ind];
    if (/信息|软件|电子|半导体/.test(ind)) return { l1: 'tech', l2: 'hardware' };
    if (/通信|传媒|互联网/.test(ind)) return { l1: 'internet', l2: 'platform' };
    if (/工业|制造/.test(ind)) return { l1: 'mfg', l2: 'robot' };
    if (/能源|石油|燃气/.test(ind)) return { l1: 'energy', l2: 'oil' };
    if (/材料|金属|矿业/.test(ind)) return { l1: 'energy', l2: 'metals' };
    if (/公用/.test(ind)) return { l1: 'energy', l2: 'energy_eq' };
    if (/金融|银行|保险/.test(ind)) return { l1: 'fin', l2: 'fintech' };
    if (/地产|房地产/.test(ind)) return { l1: 'consumer', l2: 'reit' };
    if (/医疗|保健|制药/.test(ind)) return { l1: 'health', l2: 'biotech' };
    if (/日常消费/.test(ind)) return { l1: 'consumer', l2: 'staples' };
    if (/消费/.test(ind)) return { l1: 'consumer', l2: 'discretionary' };
  }
  return null;
}

function isEmUSJunkSymbolWorker(code, q) {
  var s = String(code || '').toUpperCase();
  if (!s) return true;
  // ETF / 杠杆 / 常见指数工具
  if (/^(SPY|QQQ|IWM|DIA|VOO|VTI|ARKK|TQQQ|SQQQ|UVXY|VXX|SOXL|SOXS|TNA|TZA|UPRO|SPXU)$/.test(s)) return true;
  if (/^[A-Z]+[0-9]$/.test(s) && s.length <= 5) return true; // 认股权等
  var nm = String((q && q.name) || '');
  if (/ETF|ETN|杠杆|反向|信托基金/i.test(nm)) return true;
  return false;
}

function classifyUSMapToSectors(usMap) {
  var byL1 = {};
  var byL2 = {};
  var l1Stats = {};
  Object.keys(usMap).forEach(function (code) {
    var q = usMap[code];
    if (!q || !(q.c > 0)) return;
    if (isEmUSJunkSymbolWorker(code, q)) return;
    var hit = classifyOneEmSymbolWorker(code, q.name || '', q.industry || '');
    if (!hit || !hit.l1 || !hit.l2) return;
    byL1[hit.l1] = byL1[hit.l1] || [];
    byL1[hit.l1].push(code);
    byL2[hit.l2] = byL2[hit.l2] || [];
    byL2[hit.l2].push(code);
    l1Stats[hit.l1] = l1Stats[hit.l1] || { sum: 0, n: 0 };
    var dp = Number(q.dp);
    if (!isNaN(dp)) {
      l1Stats[hit.l1].sum += dp;
      l1Stats[hit.l1].n++;
    }
  });
  function dedupe(arr) {
    var s = {}, out = [];
    (arr || []).forEach(function (x) {
      if (!s[x]) {
        s[x] = true;
        out.push(x);
      }
    });
    return out;
  }
  Object.keys(byL1).forEach(function (id) {
    byL1[id] = dedupe(byL1[id]);
  });
  Object.keys(byL2).forEach(function (id) {
    byL2[id] = dedupe(byL2[id]);
  });
  var classN = 0;
  Object.keys(byL2).forEach(function (k) {
    classN += (byL2[k] && byL2[k].length) || 0;
  });
  var cards = US_L1_META.map(function (m) {
    var n = (byL1[m.id] && byL1[m.id].length) || 0;
    var st = l1Stats[m.id] || { sum: 0, n: 0 };
    var chg = st.n ? st.sum / st.n : 0;
    return {
      id: m.id,
      name: m.name,
      en: m.en,
      chg: Math.round(chg * 100) / 100,
      count: n,
      subCount: m.subCount,
      _pending: false,
    };
  });
  var sum = 0;
  cards.forEach(function (c) {
    sum += c.count;
  });
  return { byL1: byL1, byL2: byL2, classN: classN, cards: cards, sum: sum };
}


/** 东财美股全表 + A股行业榜 → 写入 D1，供网页打开时秒开板块 */
async function runSectorDailyJob(env) {
  if (!env.DB) throw new Error('DB not bound');
  const started = Date.now();
  const day = new Date().toISOString().slice(0, 10);
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'application/json,text/plain,*/*',
  };

  async function putCache(key, data, ttlDays) {
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + (ttlDays || 2) * 86400000).toISOString();
    const value = JSON.stringify(data);
    if (value.length > 900000) throw new Error('payload too large: ' + key + ' ' + value.length);
    await env.DB.prepare(
      'INSERT INTO cache_kv (key, value, updated_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, expires_at=excluded.expires_at'
    )
      .bind(key, value, now, expires)
      .run();
  }

  async function getCache(key) {
    try {
      const res = await env.DB.prepare(
        'SELECT value, expires_at FROM cache_kv WHERE key = ?'
      )
        .bind(key)
        .first();
      if (!res || !res.value) return null;
      if (res.expires_at) {
        const exp = Date.parse(res.expires_at);
        if (!isNaN(exp) && exp < Date.now()) return null;
      }
      return JSON.parse(res.value);
    } catch (e) {
      return null;
    }
  }

  /** 完整度评分：成分越多、有效涨跌越多越好；全 0 涨跌会很低 */
  function scoreCNPackage(meta, boards) {
    var stockN = 0;
    var chgN = 0;
    var keys = meta ? Object.keys(meta) : [];
    keys.forEach(function (k) {
      var m = meta[k] || {};
      stockN += Number(m.count) || 0;
      var c = Number(m.chg);
      if (!isNaN(c) && Math.abs(c) > 0.001) chgN++;
    });
    if (boards && boards.length) {
      boards.forEach(function (b) {
        var c = Number(b && b.chg);
        if (!isNaN(c) && Math.abs(c) > 0.001) chgN++;
      });
    }
    return { stockN: stockN, chgN: chgN, boardN: keys.length };
  }

  // ---- 美股：东财 clist 分页（精简字段，约全市场）----
  const usMap = {};
  let usTotal = 0;
  const pageSize = 100;
  const maxPages = 150; // 上限防超时，约 1.5 万只
  for (let pn = 1; pn <= maxPages; pn++) {
    const api =
      'https://push2delay.eastmoney.com/api/qt/clist/get?pn=' +
      pn +
      '&pz=' +
      pageSize +
      '&po=1&np=1&fltt=2&invt=2&fid=f12&fs=m:105,m:106,m:107&fields=f12,f14,f2,f3,f4,f15,f16,f17,f18,f100&_=' +
      Date.now();
    let data = null;
    try {
      const r = await fetch(api, { headers });
      if (r.ok) data = await r.json();
    } catch (e) {}
    if (!data || !data.data) break;
    if (pn === 1) usTotal = Number(data.data.total) || 0;
    const diff = data.data.diff;
    const rows = Array.isArray(diff)
      ? diff
      : diff
        ? Object.keys(diff).map(function (k) {
            return diff[k];
          })
        : [];
    if (!rows.length) break;
    for (let i = 0; i < rows.length; i++) {
      const it = rows[i] || {};
      const code = String(it.f12 || '')
        .trim()
        .toUpperCase();
      if (!code || !/^[A-Z0-9.\-]+$/.test(code)) continue;
      const c = Number(it.f2);
      if (!(c > 0)) continue;
      const dp = Number(it.f3);
      const d = Number(it.f4);
      const pc =
        !isNaN(dp) && dp !== -100 ? c / (1 + dp / 100) : Number(it.f18) > 0 ? Number(it.f18) : c;
      let ind = String(it.f100 || '').trim();
      if (ind === '-' || ind === '—' || ind === 'null') ind = '';
      usMap[code] = {
        c: c,
        dp: isNaN(dp) ? 0 : dp,
        d: isNaN(d) ? 0 : d,
        h: Number(it.f15) > 0 ? Number(it.f15) : c,
        l: Number(it.f16) > 0 ? Number(it.f16) : c,
        o: Number(it.f17) > 0 ? Number(it.f17) : c,
        pc: pc > 0 ? pc : c,
        name: String(it.f14 || ''),
        industry: ind,
      };
    }
    // 已收齐
    if (usTotal && Object.keys(usMap).length >= usTotal) break;
    if (rows.length < pageSize) break;
  }
  const usCount = Object.keys(usMap).length;
  // 分片写入（整包会超 D1/Worker 限制失败，网页打开就只剩树内小数）
  const allKeys = Object.keys(usMap);
  const CHUNK = 2500;
  const chunkN = Math.ceil(allKeys.length / CHUNK) || 1;
  const atNow = Date.now();
  // 质量门：本次拉得太少则不覆盖库里已有完整美股包
  var prevUsIdx = await getCache('sector:us:quotes');
  var prevUsN = 0;
  if (prevUsIdx) {
    prevUsN = Number(prevUsIdx.total) || 0;
    if (!prevUsN && prevUsIdx.chunks) {
      // 粗估：有分片就当作已有完整包
      prevUsN = Number(prevUsIdx.chunks) * 2000;
    }
  }
  var usSkipWrite = false;
  if (usCount < 2000 && prevUsN >= 5000) {
    usSkipWrite = true;
    console.log('us skip write: new', usCount, 'prev~', prevUsN);
  }

  // 先写全部分片，再写索引（避免索引齐全、分片实际缺失）
  if (!usSkipWrite) {
    var usChunkFail = 0;
    for (let ci = 0; ci < chunkN; ci++) {
      const part = {};
      const slice = allKeys.slice(ci * CHUNK, (ci + 1) * CHUNK);
      for (let si = 0; si < slice.length; si++) {
        part[slice[si]] = usMap[slice[si]];
      }
      const piece = {
        day: day, at: atNow, map: part, chunk: ci, chunks: chunkN,
        total: usTotal || usCount, source: 'cron', complete: true
      };
      try {
        await putCache('sector:us:quotes:' + ci, piece, 2);
        await putCache('sector:em_us_universe:' + ci, piece, 2);
      } catch (eCh) {
        usChunkFail++;
        console.log('us chunk fail', ci, String(eCh));
      }
    }
    if (usChunkFail > 0) {
      usSkipWrite = true;
      console.log('us skip index: chunk fails', usChunkFail);
    } else {
      await putCache(
        'sector:us:quotes',
        {
          day: day, at: atNow, total: usTotal || usCount,
          chunked: true, chunks: chunkN, map: {}, source: 'cron', complete: true
        },
        2
      );
      await putCache(
        'sector:em_us_universe',
        {
          day: day, at: atNow, total: usTotal || usCount,
          chunked: true, chunks: chunkN, map: {}, source: 'cron', complete: true
        },
        2
      );
    }
  }

  // ---- 美股归类：写入 em_class + 一级角标快照（打开网页可直接完整角标）----
  var classResult = { byL1: {}, byL2: {}, classN: 0, cards: [], sum: 0 };
  try {
    if (!usSkipWrite) {
      classResult = classifyUSMapToSectors(usMap);
      await putCache(
        'sector:us:em_class',
        {
          day: day,
          at: atNow,
          byL1: classResult.byL1,
          byL2: classResult.byL2,
          classN: classResult.classN,
          source: 'cron',
        },
        2
      );
      if (classResult.sum > 400 && classResult.cards && classResult.cards.length) {
        await putCache(
          'sector:us:l1_snap',
          {
            day: day,
            at: atNow,
            cards: classResult.cards,
            sum: classResult.sum,
            source: 'cron',
          },
          3
        );
      }
    }
  } catch (eCls) {
    console.log('classify cron fail', String(eCls));
  }

  // ---- A股：行业榜 + 树内 30 个 BK 成分股（与网页 CN_SECTOR_TREE 对齐）----
  const CN_BOARD_TREE = [
    { l1: 'cn_tech', l1Name: '科技与技术', l1En: 'Tech', id: 'elec', name: '电子', board: 'BK1201' },
    { l1: 'cn_tech', l1Name: '科技与技术', l1En: 'Tech', id: 'computer', name: '计算机', board: 'BK1207' },
    { l1: 'cn_tech', l1Name: '科技与技术', l1En: 'Tech', id: 'telecom', name: '通信', board: 'BK1215' },
    { l1: 'cn_tech', l1Name: '科技与技术', l1En: 'Tech', id: 'media', name: '传媒', board: 'BK0486' },
    { l1: 'cn_mfg', l1Name: '制造与重工', l1En: 'Manufacturing', id: 'power', name: '电力设备', board: 'BK1200' },
    { l1: 'cn_mfg', l1Name: '制造与重工', l1En: 'Manufacturing', id: 'machine', name: '机械设备', board: 'BK1205' },
    { l1: 'cn_mfg', l1Name: '制造与重工', l1En: 'Manufacturing', id: 'auto', name: '汽车', board: 'BK1211' },
    { l1: 'cn_mfg', l1Name: '制造与重工', l1En: 'Manufacturing', id: 'defense', name: '国防军工', board: 'BK1204' },
    { l1: 'cn_mfg', l1Name: '制造与重工', l1En: 'Manufacturing', id: 'build', name: '建筑装饰', board: 'BK1209' },
    { l1: 'cn_mfg', l1Name: '制造与重工', l1En: 'Manufacturing', id: 'bmat', name: '建筑材料', board: 'BK1208' },
    { l1: 'cn_mfg', l1Name: '制造与重工', l1En: 'Manufacturing', id: 'light', name: '轻工制造', board: 'BK1212' },
    { l1: 'cn_cons', l1Name: '消费与医疗', l1En: 'Consumer & Health', id: 'food', name: '食品饮料', board: 'BK0438' },
    { l1: 'cn_cons', l1Name: '消费与医疗', l1En: 'Consumer & Health', id: 'pharma', name: '医药生物', board: 'BK1216' },
    { l1: 'cn_cons', l1Name: '消费与医疗', l1En: 'Consumer & Health', id: 'appliance', name: '家用电器', board: 'BK0456' },
    { l1: 'cn_cons', l1Name: '消费与医疗', l1En: 'Consumer & Health', id: 'beauty', name: '美容护理', board: 'BK1035' },
    { l1: 'cn_cons', l1Name: '消费与医疗', l1En: 'Consumer & Health', id: 'retail', name: '商贸零售', board: 'BK1213' },
    { l1: 'cn_cons', l1Name: '消费与医疗', l1En: 'Consumer & Health', id: 'textile', name: '纺织服饰', board: 'BK0436' },
    { l1: 'cn_cons', l1Name: '消费与医疗', l1En: 'Consumer & Health', id: 'service', name: '社会服务', board: 'BK1214' },
    { l1: 'cn_res', l1Name: '基础资源', l1En: 'Resources', id: 'metal', name: '有色金属', board: 'BK0478' },
    { l1: 'cn_res', l1Name: '基础资源', l1En: 'Resources', id: 'coal', name: '煤炭', board: 'BK0437' },
    { l1: 'cn_res', l1Name: '基础资源', l1En: 'Resources', id: 'oil', name: '石油石化', board: 'BK0464' },
    { l1: 'cn_res', l1Name: '基础资源', l1En: 'Resources', id: 'chem', name: '基础化工', board: 'BK1206' },
    { l1: 'cn_res', l1Name: '基础资源', l1En: 'Resources', id: 'steel', name: '钢铁', board: 'BK0479' },
    { l1: 'cn_res', l1Name: '基础资源', l1En: 'Resources', id: 'env', name: '环保', board: 'BK0728' },
    { l1: 'cn_res', l1Name: '基础资源', l1En: 'Resources', id: 'agri', name: '农林牧渔', board: 'BK0433' },
    { l1: 'cn_fin', l1Name: '金融地产与服务', l1En: 'Financials', id: 'bank', name: '银行', board: 'BK1283' },
    { l1: 'cn_fin', l1Name: '金融地产与服务', l1En: 'Financials', id: 'nonbank', name: '非银金融', board: 'BK1203' },
    { l1: 'cn_fin', l1Name: '金融地产与服务', l1En: 'Financials', id: 'property', name: '房地产', board: 'BK1202' },
    { l1: 'cn_fin', l1Name: '金融地产与服务', l1En: 'Financials', id: 'transport', name: '交通运输', board: 'BK1210' },
    { l1: 'cn_fin', l1Name: '金融地产与服务', l1En: 'Financials', id: 'utility', name: '公用事业', board: 'BK0427' },
  ];

  async function fetchCnBoardList(up) {
    const url =
      'https://push2delay.eastmoney.com/api/qt/clist/get?pn=1&pz=120&po=' +
      (up ? 1 : 0) +
      '&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f12,f14,f2,f3,f104,f105&_=' +
      Date.now();
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) return [];
      const data = await r.json();
      const diff = data && data.data && data.data.diff;
      const rows = Array.isArray(diff) ? diff : [];
      return rows.map(function (it) {
        return {
          board: String(it.f12 || ''),
          name: String(it.f14 || ''),
          chg: it.f3 != null ? Number(it.f3) : 0,
          count: (Number(it.f104) || 0) + (Number(it.f105) || 0),
        };
      });
    } catch (e) {
      return [];
    }
  }

  /** 拉单个 BK 板块成分（最多 5 页 ≈ 500 只，覆盖绝大部分行业） */
  async function fetchCnBoardMembers(boardCode) {
    const out = [];
    const pageSize = 100;
    const maxPages = 20; // 最多约 2000 只，尽量接近全量刷新
    for (let pn = 1; pn <= maxPages; pn++) {
      const url =
        'https://push2delay.eastmoney.com/api/qt/clist/get?pn=' +
        pn +
        '&pz=' +
        pageSize +
        '&po=1&np=1&fltt=2&invt=2&fid=f3&fs=b:' +
        boardCode +
        '&fields=f12,f14,f2,f3&_=' +
        Date.now();
      let rows = [];
      try {
        const r = await fetch(url, { headers });
        if (!r.ok) break;
        const data = await r.json();
        const diff = data && data.data && data.data.diff;
        rows = Array.isArray(diff) ? diff : [];
      } catch (e) {
        break;
      }
      if (!rows.length) break;
      for (let i = 0; i < rows.length; i++) {
        const it = rows[i] || {};
        const code = String(it.f12 || '').trim();
        if (!code) continue;
        const price = Number(it.f2);
        const chg = it.f3 != null ? Number(it.f3) : 0;
        out.push({
          code: code,
          name: String(it.f14 || ''),
          chg: isNaN(chg) ? 0 : chg,
          price: price > 0 ? price : 0,
        });
      }
      if (rows.length < pageSize) break;
    }
    return out;
  }

  const upBoards = await fetchCnBoardList(true);
  const downBoards = await fetchCnBoardList(false);
  const boardMap = {};
  upBoards.concat(downBoards).forEach(function (b) {
    if (!b.board) return;
    if (!boardMap[b.board]) boardMap[b.board] = b;
  });
  // 保证树内 30 个 BK 一定有条目
  CN_BOARD_TREE.forEach(function (node) {
    if (!boardMap[node.board]) {
      boardMap[node.board] = {
        board: node.board,
        name: node.name,
        chg: 0,
        count: 0,
      };
    }
  });

  const cnMeta = {};
  const cnStocks = {};
  const cnByL2 = {};
  // 分批拉成分，避免同时打爆东财（每批 5 个）
  for (let bi = 0; bi < CN_BOARD_TREE.length; bi += 5) {
    const batch = CN_BOARD_TREE.slice(bi, bi + 5);
    const results = await Promise.all(
      batch.map(function (node) {
        return fetchCnBoardMembers(node.board).then(function (members) {
          return { node: node, members: members };
        });
      })
    );
    results.forEach(function (item) {
      const node = item.node;
      const members = item.members || [];
      cnStocks[node.board] = members.slice(0, 400);
      cnByL2[node.id] = members.map(function (m) {
        return m.code;
      });
      var sum = 0;
      var n = 0;
      members.forEach(function (m) {
        if (m.chg != null && !isNaN(m.chg)) {
          sum += m.chg;
          n++;
        }
      });
      const avg = n ? sum / n : boardMap[node.board] ? boardMap[node.board].chg : 0;
      cnMeta[node.board] = {
        count: members.length,
        name: node.name,
        chg: Math.round(avg * 100) / 100,
        l2: node.id,
        l1: node.l1,
      };
      // 用成分精确数覆盖行业榜粗数
      if (boardMap[node.board]) {
        boardMap[node.board].count = members.length;
        boardMap[node.board].name = node.name;
        if (n > 0) boardMap[node.board].chg = Math.round(avg * 100) / 100;
      }
    });
  }

  const boards = Object.keys(boardMap).map(function (k) {
    return boardMap[k];
  });

  // 一级角标：各 L1 下细分成分数合计 + 涨跌简单平均
  const l1Order = [
    { id: 'cn_tech', name: '科技与技术', en: 'Tech', subCount: 4 },
    { id: 'cn_mfg', name: '制造与重工', en: 'Manufacturing', subCount: 7 },
    { id: 'cn_cons', name: '消费与医疗', en: 'Consumer & Health', subCount: 7 },
    { id: 'cn_res', name: '基础资源', en: 'Resources', subCount: 7 },
    { id: 'cn_fin', name: '金融地产与服务', en: 'Financials', subCount: 5 },
  ];
  const cnL1Cards = l1Order.map(function (l1) {
    var count = 0;
    var sum = 0;
    var n = 0;
    CN_BOARD_TREE.forEach(function (node) {
      if (node.l1 !== l1.id) return;
      const m = cnMeta[node.board];
      if (!m) return;
      count += Number(m.count) || 0;
      if (m.chg != null && !isNaN(m.chg)) {
        sum += m.chg;
        n++;
      }
    });
    return {
      id: l1.id,
      name: l1.name,
      en: l1.en,
      chg: n ? Math.round((sum / n) * 100) / 100 : 0,
      count: count,
      subCount: l1.subCount,
      _pending: false,
    };
  });
  var cnL1Sum = 0;
  cnL1Cards.forEach(function (c) {
    cnL1Sum += c.count;
  });

  const atCn = Date.now();
  // 质量门：避免休市/失败时用「全 0% + 成分很少」覆盖用户全量刷新留下的完整包
  var cnScore = scoreCNPackage(cnMeta, boards);
  var prevCn = await getCache('sector:cn:boards');
  var prevScore = prevCn ? scoreCNPackage(prevCn.meta || {}, prevCn.boards || []) : { stockN: 0, chgN: 0, boardN: 0 };
  var cnSkipWrite = false;
  // 新包涨跌几乎全 0，但旧包有真实涨跌 → 保留旧包（常见于周末 Cron）
  if (cnScore.chgN <= 2 && prevScore.chgN >= 5) {
    cnSkipWrite = true;
    console.log('cn skip write: new chgN', cnScore.chgN, 'prev chgN', prevScore.chgN);
  }
  // 新包成分明显少很多（拉失败）也不覆盖
  if (!cnSkipWrite && prevScore.stockN > 2000 && cnScore.stockN < prevScore.stockN * 0.5) {
    cnSkipWrite = true;
    console.log('cn skip write: new stockN', cnScore.stockN, 'prev', prevScore.stockN);
  }
  // 若新包成分更全但涨跌全 0、旧包有涨跌：合并——用新成分数 + 旧涨跌
  if (!cnSkipWrite && cnScore.stockN >= prevScore.stockN && cnScore.chgN <= 2 && prevScore.chgN >= 5 && prevCn && prevCn.meta) {
    Object.keys(cnMeta).forEach(function (bk) {
      var oldM = prevCn.meta[bk];
      if (!oldM) return;
      var oc = Number(oldM.chg);
      if (!isNaN(oc) && Math.abs(oc) > 0.001) {
        if (!cnMeta[bk]) cnMeta[bk] = {};
        cnMeta[bk].chg = oc;
      }
    });
    boards.forEach(function (b) {
      if (!b || !b.board) return;
      var oldB = (prevCn.boards || []).find(function (x) { return x && x.board === b.board; });
      if (oldB && Math.abs(Number(oldB.chg) || 0) > 0.001 && Math.abs(Number(b.chg) || 0) <= 0.001) {
        b.chg = oldB.chg;
      }
    });
    // 重算一级卡片涨跌
    cnL1Cards.forEach(function (card) {
      var sum = 0, n = 0, count = 0;
      CN_BOARD_TREE.forEach(function (node) {
        if (node.l1 !== card.id) return;
        var m = cnMeta[node.board];
        if (!m) return;
        count += Number(m.count) || 0;
        if (m.chg != null && !isNaN(m.chg) && Math.abs(m.chg) > 0.001) {
          sum += m.chg;
          n++;
        }
      });
      card.count = count;
      card.chg = n ? Math.round((sum / n) * 100) / 100 : card.chg;
    });
    cnL1Sum = 0;
    cnL1Cards.forEach(function (c) { cnL1Sum += c.count; });
    console.log('cn merged prev chg into fuller member counts');
  }

  if (!cnSkipWrite) {
    await putCache(
      'sector:cn:boards',
      {
        day: day,
        at: atCn,
        boards: boards,
        meta: cnMeta,
        stocks: cnStocks,
        byL2: cnByL2,
        source: 'cron',
        quality: cnScore,
      },
      2
    );
    await putCache(
      'sector:cn:em_class',
      {
        day: day,
        at: atCn,
        byL2: cnByL2,
        meta: cnMeta,
        classN: cnL1Sum,
        source: 'cron',
      },
      2
    );
    if (cnL1Sum > 100) {
      await putCache(
        'sector:cn:l1_snap',
        {
          day: day,
          at: atCn,
          cards: cnL1Cards,
          sum: cnL1Sum,
          source: 'cron',
        },
        3
      );
    }
  } else {
    console.log('cn write skipped to protect complete cache');
  }

  // 状态标记：网页可用来判断「今天是否已后台刷过」
  await putCache(
    'sector:daily:meta',
    {
      day: day,
      at: Date.now(),
      usCount: usCount,
      usTotal: usTotal || usCount,
      usClassN: classResult.classN || 0,
      usL1Sum: classResult.sum || 0,
      cnBoards: boards.length,
      cnClassN: cnL1Sum,
      cnTreeBoards: CN_BOARD_TREE.length,
      ms: Date.now() - started,
      source: 'cron',
    },
    3
  );

  return {
    day: day,
    usCount: usCount,
    usTotal: usTotal || usCount,
    usClassN: classResult.classN || 0,
    usL1Sum: classResult.sum || 0,
    cnBoards: boards.length,
    cnClassN: cnL1Sum,
    cnTreeBoards: CN_BOARD_TREE.length,
    ms: Date.now() - started,
  };
}
