// GEOCheck audit 엔진의 JS 포팅판 — 점검 항목/가중치/등급 체계를 geocheck.audit와 동일하게 유지
// Python re의 유니코드 \b를 룩어라운드로 재현 (geocheck.audit._STAT_RE/_YEAR_RE와 동일 판정)
const STAT_RE = /(?<![A-Za-z0-9_가-힣])\d+(?:[.,]\d+)?\s?(?:%(?=[A-Za-z0-9_가-힣])|(?:퍼센트|percent|billion|million|천|만|억)(?![A-Za-z0-9_가-힣]))/i;
const YEAR_RE = /(?<![A-Za-z0-9_가-힣])(?:19|20)\d{2}(?![A-Za-z0-9_가-힣])/;
const CITE_RE = /according to|source:|출처|참고|study|research|보고서|report/i;
const WORD_RE = /[A-Za-z가-힣0-9]+/g;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 GEOForge/1.0";
const HEADERS = { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8" };

function grade(score) {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

async function get(url, timeout = 8000) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeout);
    const r = await fetch(url, { headers: HEADERS, redirect: "follow", signal: c.signal });
    clearTimeout(t);
    const body = await r.text();
    return { ok: r.ok, status: r.status, body, error: r.ok ? "" : "HTTP " + r.status };
  } catch (e) {
    return { ok: false, status: 0, body: "", error: String(e && e.message || e) };
  }
}

// htmlutil.parse_html 대응 — script/style 제외 텍스트, 헤딩, 리스트, 이미지, 링크, 메타, JSON-LD 수집
function parseHtml(html) {
  const d = { title: "", meta: {}, headings: [], jsonld: [], images: 0, imagesWithAlt: 0, linksExternal: 0, listItems: 0 };
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t) d.title = t[1].replace(/\s+/g, " ").trim();
  const metaRe = /<meta\b[^>]*>/gi; let m;
  while ((m = metaRe.exec(html))) {
    const tag = m[0];
    const name = (tag.match(/(?:name|property)=["']([^"']+)["']/i) || [])[1];
    const content = (tag.match(/content=["']([^"']*)["']/i) || [])[1];
    if (name) d.meta[name.toLowerCase()] = content || "";
  }
  const hRe = /<h([1-6])[^>]*>/gi;
  while ((m = hRe.exec(html))) d.headings.push("h" + m[1]);
  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = ldRe.exec(html))) d.jsonld.push(m[1]);
  const imgRe = /<img\b[^>]*>/gi;
  while ((m = imgRe.exec(html))) {
    d.images++;
    const alt = (m[0].match(/alt=["']([^"']*)["']/i) || [])[1];
    if (alt && alt.trim()) d.imagesWithAlt++;
  }
  const aRe = /<a\b[^>]*href=["']([^"']+)["']/gi;
  while ((m = aRe.exec(html))) if (/^http/i.test(m[1])) d.linksExternal++;
  d.listItems = (html.match(/<li[\s>]/gi) || []).length;
  return d;
}

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ");
}

export async function auditUrl(input) {
  let url = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = "https://" + url;
  let u;
  try { u = new URL(url); } catch { return { url, ok: false, score: 0, grade: "F", error: "올바른 URL이 아닙니다", checks: [] }; }
  if (!/^https?:$/.test(u.protocol)) return { url, ok: false, score: 0, grade: "F", error: "http/https만 지원합니다", checks: [] };
  const host = u.hostname;
  const allowLocal = process.env.ALLOW_LOCAL === "1";
  if (!allowLocal && (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === "::1" || !host.includes("."))) {
    return { url, ok: false, score: 0, grade: "F", error: "허용되지 않는 주소입니다", checks: [] };
  }

  const res = await get(u.href);
  if (!res.ok) return { url: u.href, ok: false, score: 0, grade: "F", error: res.error || "접근 실패", checks: [] };

  const html = res.body;
  const dom = parseHtml(html);
  const text = visibleText(html);
  const words = (text.match(WORD_RE) || []).length;
  const checks = [];
  const add = (category, name, passed, weight, detail, fix = "") =>
    checks.push({ category, name, passed, weight, detail, fix: passed ? "" : fix });

  // --- 1. AI 크롤러 접근성 ---
  const base = u.protocol + "//" + u.host;
  const [llmsRes, robotsRes] = await Promise.all([get(base + "/llms.txt"), get(base + "/robots.txt")]);
  const hasLlms = llmsRes.ok;
  add("AI 접근성", "llms.txt 존재", hasLlms, 10,
    hasLlms ? "llms.txt 발견" : "/llms.txt 없음",
    "llms.txt를 생성해 사이트 루트에 배포하세요.");
  let aiBotOk = true;
  if (robotsRes.ok) {
    const blocked = /User-agent:\s*(GPTBot|PerplexityBot|ClaudeBot|Google-Extended)/i.test(robotsRes.body) && /Disallow:\s*\//.test(robotsRes.body);
    aiBotOk = !blocked;
  }
  add("AI 접근성", "AI 크롤러 차단 안 함", aiBotOk, 6,
    aiBotOk ? "AI 봇 허용" : "robots.txt가 AI 크롤러를 차단",
    "robots.txt에서 GPTBot/PerplexityBot/ClaudeBot/Google-Extended 차단을 해제하세요.");

  // --- 2. 구조화 데이터 ---
  const schemaTypes = [];
  for (const block of dom.jsonld) {
    try {
      const data = JSON.parse(block);
      const items = Array.isArray(data) ? data : [data];
      for (const it of items) {
        if (it && typeof it === "object" && it["@type"]) {
          const t = it["@type"];
          schemaTypes.push(typeof t === "string" ? t : t.join(","));
        }
      }
    } catch {}
  }
  add("구조화 데이터", "JSON-LD 스키마", schemaTypes.length > 0, 14,
    schemaTypes.length ? "스키마 타입: " + schemaTypes.join(", ") : "JSON-LD 스키마 없음",
    "Article/FAQ/Organization 스키마를 추가하세요.");
  const hasFaq = schemaTypes.some((t) => t.toLowerCase().includes("faq") || t.toLowerCase().includes("qapage"));
  add("구조화 데이터", "FAQ/QA 스키마", hasFaq, 6,
    hasFaq ? "FAQ 스키마 있음" : "FAQ/QAPage 스키마 없음",
    "질문-답변 콘텐츠에 FAQPage 스키마를 부여하면 인용 확률이 오릅니다.");

  // --- 3. 메타데이터 ---
  const title = dom.title;
  add("메타데이터", "title 태그", !!title, 6,
    title ? "title: " + title.slice(0, 60) : "title 없음",
    "명확하고 질의 지향적인 <title>을 작성하세요.");
  const desc = (dom.meta["description"] || "").trim();
  add("메타데이터", "meta description", desc.length >= 50 && desc.length <= 160, 5,
    desc ? "길이 " + desc.length + "자" : "description 없음",
    "50-160자 길이의 요약형 meta description을 작성하세요.");

  // --- 4. 콘텐츠 구조 ---
  const h1s = dom.headings.filter((h) => h === "h1").length;
  add("콘텐츠 구조", "H1 정확히 1개", h1s === 1, 5, "H1 " + h1s + "개",
    "페이지당 H1은 정확히 1개가 이상적입니다.");
  add("콘텐츠 구조", "충분한 소제목", dom.headings.length >= 3, 5, "헤딩 " + dom.headings.length + "개",
    "H2/H3로 내용을 스캔 가능하게 쪼개세요. AI는 구조화된 문서를 선호합니다.");
  add("콘텐츠 구조", "리스트 사용", dom.listItems >= 3, 4, "리스트 항목 " + dom.listItems + "개",
    "핵심 정보를 불릿/번호 리스트로 정리하면 AI 추출률이 높아집니다.");

  // --- 5. 콘텐츠 깊이 ---
  add("콘텐츠 깊이", "충분한 분량(300+ 단어)", words >= 300, 6, "본문 " + words + " 단어",
    "얇은 콘텐츠는 인용되지 않습니다. 300단어 이상으로 보강하세요.");

  // --- 6. GEO 신호 (KDD'24 근거) ---
  const hasStats = STAT_RE.test(text);
  add("GEO 신호", "통계/수치 포함", hasStats, 8,
    hasStats ? "수치 데이터 있음" : "통계·수치 없음",
    "구체적 통계(%, 수치)를 넣으면 GEO 가시성이 최대 40%까지 상승합니다(KDD'24).");
  const hasCite = CITE_RE.test(text);
  add("GEO 신호", "출처/인용 표현", hasCite, 6,
    hasCite ? "인용 표현 있음" : "출처·인용 표현 없음",
    "'출처:', 'according to', 연구 인용 등을 추가해 신뢰 신호를 주세요.");
  const hasYear = YEAR_RE.test(text);
  add("GEO 신호", "연도/최신성 신호", hasYear, 4,
    hasYear ? "연도 표기 있음" : "연도·날짜 표기 없음",
    "최신 연도/업데이트 날짜를 명시하면 최신성 평가에 유리합니다.");

  // --- 7. 이미지 접근성 ---
  const altRatio = dom.images ? dom.imagesWithAlt / dom.images : 1.0;
  add("접근성", "이미지 alt 텍스트", altRatio >= 0.8, 4,
    "alt 보유 " + dom.imagesWithAlt + "/" + dom.images,
    "모든 이미지에 서술형 alt 텍스트를 넣으세요.");

  // --- 8. 권위 신호 ---
  add("권위", "외부 참조 링크", dom.linksExternal >= 1, 4, "외부 링크 " + dom.linksExternal + "개",
    "신뢰할 수 있는 출처로의 외부 링크는 E-E-A-T 신호가 됩니다.");

  const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
  const earned = checks.reduce((s, c) => s + (c.passed ? c.weight : 0), 0);
  const score = totalWeight ? Math.round((earned / totalWeight) * 100) : 0;
  return { url: u.href, ok: true, score, grade: grade(score), error: "", checks };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const url = (req.query.url || "").trim();
  if (!url) return res.status(400).json({ error: "url 파라미터가 필요합니다" });
  const result = await auditUrl(url);
  res.status(200).json(result);
}
