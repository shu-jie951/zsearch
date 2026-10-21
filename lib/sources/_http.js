'use strict';

/**
 * 数据源共用的 HTTP 工具。
 *
 * 每个数据源都需要：超时控制、可中止、统一的伪装请求头、统一错误抛出。
 * 这里抽出来，避免三份重复实现。
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * 发起一次带超时的 fetch。
 * @param {string} url
 * @param {object} opts { method, headers, body, timeoutMs }
 * @returns {Promise<Response>} 仅在 HTTP 2xx 时 resolve，否则抛出带 status 的错误
 */
async function request(url, { method = 'GET', headers = {}, body = null, timeoutMs = 6000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'User-Agent': DEFAULT_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', ...headers },
      body,
      signal: ac.signal,
      redirect: 'follow',
    });
    if (!res.ok) {
      const err = new Error(`http ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const e = new Error('timeout');
      e.status = 0;
      e.timeout = true;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 带超时地读取 JSON */
async function requestJson(url, opts = {}) {
  const res = await request(url, opts);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('non-json response');
    err.status = res.status;
    throw err;
  }
}

/** 带超时地读取文本（HTML） */
async function requestText(url, opts = {}) {
  const res = await request(url, opts);
  return res.text();
}

/** 朴素 HTML 反转义（先处理 &amp; 再处理数字实体，避免二次转义） */
function unescapeHtml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => {
      const n = Number(d);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : _;
    });
}

/** 去掉 HTML 标签，取纯文本（j-so 用 <mark> 高亮关键词） */
function stripTags(s) {
  return unescapeHtml(String(s || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

module.exports = { request, requestJson, requestText, unescapeHtml, stripTags, DEFAULT_UA };
