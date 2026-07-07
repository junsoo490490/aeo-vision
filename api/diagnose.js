export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  let input = (req.query.url || "").trim();
  if (!input) return res.status(400).json({ error: "url 파라미터가 필요합니다" });
  if (!/^https?:\/\//i.test(input)) input = "https://" + input;
  let u;
  try { u = new URL(input); } catch { return res.status(400).json({ error: "올바른 URL이 아닙니다" }); }
  const host = u.hostname;
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === "::1" || !host.includes(".")) {
    return res.status(400).json({ error: "허용되지 않는 주소입니다" });
  }
  const UA = "Mozilla/5.0 (compatible; AEOVisionBot/1.0)";
  async function get(url) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 9000);
      const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "text/html,*/*" }, redirect: "follow", signal: c.signal });
      clearTimeout(t);
      const text = await r.text();
      return { ok: r.ok, status: r.status, text: text.slice(0, 800000) };
    } catch { return { ok: false, status: 0, text: "" }; }
  }
  const page = await get(u.href);
  if (!page.ok) return res.status(200).json({ error: "사이트에 접근할 수 없습니다 (status " + page.status + "). 주소를 확인해 주세요." });
  const html = page.text;
  const origin = u.origin;
  const [llms, robots] = await Promise.all([get(origin + "/llms.txt"), get(origin + "/robots.txt")]);

  const pick = (re) => { const m = html.match(re); return m ? m[1].trim() : ""; };
  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const desc = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || pick(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const ogTitle = /<meta[^>]+property=["']og:title["']/i.test(html);
  const ogDesc = /<meta[^>]+property=["']og:description["']/i.test(html);
  const canonical = /<link[^>]+rel=["']canonical["']/i.test(html);
  const lang = pick(/<html[^>]+lang=["']([^"']+)["']/i);
  const noindex = /<meta[^>]+name=["']robots["'][^>]+noindex/i.test(html);
  const h1s = (html.match(/<h1[\s>]/gi) || []).length;
  const h2s = (html.match(/<h2[\s>]/gi) || []).length;
  const ldBlocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  const ldTypes = [];
  for (const b of ldBlocks) {
    const inner = b.replace(/<script[^>]*>/i, "").replace(/<\/script>/i, "");
    try { const j = JSON.parse(inner); const arr = Array.isArray(j) ? j : [j];
      for (const o of arr) { const t = o["@type"]; if (t) ldTypes.push(...(Array.isArray(t) ? t : [t])); if (o["@graph"]) for (const g of o["@graph"]) if (g["@type"]) ldTypes.push(...(Array.isArray(g["@type"]) ? g["@type"] : [g["@type"]])); }
    } catch {}
  }
  const hasFAQ = ldTypes.includes("FAQPage");
  const textOnly = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const words = textOnly.split(" ").filter(Boolean).length;
  const aiBots = ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "CCBot"];
  let blockedBots = [];
  if (robots.ok) {
    const rt = robots.text;
    for (const b of aiBots) {
      const re = new RegExp("User-agent:\\s*" + b + "[\\s\\S]{0,200}?Disallow:\\s*/\\s*$", "im");
      if (re.test(rt)) blockedBots.push(b);
    }
  }

  const items = [];
  const add = (id, label, status, detail, advice, weight) => items.push({ id, label, status, detail, advice, weight });
  add("title", "페이지 제목 (title)", title ? (title.length >= 15 && title.length <= 70 ? "pass" : "warn") : "fail",
    title ? `"${title.slice(0, 80)}" (${title.length}자)` : "title 태그가 없습니다",
    "15~70자 사이로 핵심 질문/주제를 담은 제목을 작성하세요", 10);
  add("desc", "메타 설명 (description)", desc ? (desc.length >= 50 && desc.length <= 170 ? "pass" : "warn") : "fail",
    desc ? `${desc.length}자` : "meta description이 없습니다",
    "50~170자로 페이지가 어떤 질문에 답하는지 요약하세요", 10);
  add("schema", "구조화 데이터 (JSON-LD)", ldBlocks.length ? "pass" : "fail",
    ldBlocks.length ? `${ldBlocks.length}개 발견: ${[...new Set(ldTypes)].join(", ") || "타입 미확인"}` : "JSON-LD 스키마가 없습니다",
    "Schema.org JSON-LD(Organization, FAQPage 등)를 추가하세요. AI 엔진이 콘텐츠를 이해하는 핵심 신호입니다", 15);
  add("faq", "FAQ 스키마", hasFAQ ? "pass" : "warn",
    hasFAQ ? "FAQPage 스키마 적용됨" : "FAQPage 스키마가 없습니다",
    "질문-답변 콘텐츠를 FAQPage 스키마로 마크업하면 AI 답변 인용 확률이 크게 올라갑니다", 10);
  add("h1", "제목 구조 (H1/H2)", h1s === 1 ? "pass" : h1s === 0 ? "fail" : "warn",
    `H1 ${h1s}개, H2 ${h2s}개`,
    "H1은 페이지당 1개, H2로 질문 형태의 소제목을 구성하세요", 8);
  add("llms", "llms.txt", llms.ok && !/^\s*</.test(llms.text) ? "pass" : "warn",
    llms.ok && !/^\s*</.test(llms.text) ? "llms.txt 제공 중" : "llms.txt가 없습니다",
    "사이트 핵심 정보를 정리한 /llms.txt를 제공하면 AI 크롤러가 콘텐츠를 더 잘 파악합니다", 7);
  add("robots", "AI 크롤러 접근", !robots.ok ? "warn" : blockedBots.length ? "fail" : "pass",
    !robots.ok ? "robots.txt가 없습니다" : blockedBots.length ? `차단된 AI 봇: ${blockedBots.join(", ")}` : "주요 AI 크롤러 허용됨",
    "GPTBot, ClaudeBot, PerplexityBot 등 AI 크롤러를 차단하면 AI 답변에 인용될 수 없습니다", 15);
  add("og", "소셜 메타 (Open Graph)", ogTitle && ogDesc ? "pass" : ogTitle || ogDesc ? "warn" : "fail",
    `og:title ${ogTitle ? "✓" : "✗"} · og:description ${ogDesc ? "✓" : "✗"}`,
    "og:title, og:description을 추가하세요", 5);
  add("canonical", "표준 URL (canonical)", canonical ? "pass" : "warn",
    canonical ? "canonical 설정됨" : "canonical 링크가 없습니다",
    "중복 콘텐츠 방지를 위해 canonical URL을 지정하세요", 5);
  add("lang", "언어 선언 (lang)", lang ? "pass" : "warn", lang ? `lang="${lang}"` : "html lang 속성이 없습니다",
    "html 태그에 lang 속성을 지정하세요", 5);
  add("content", "콘텐츠 분량", words >= 300 ? "pass" : words >= 100 ? "warn" : "fail",
    `본문 약 ${words}단어`,
    "AI가 인용할 만한 충분한 깊이의 콘텐츠(300단어 이상)를 제공하세요. JS 렌더링 사이트라면 서버사이드 렌더링을 검토하세요", 5);
  add("noindex", "색인 허용", noindex ? "fail" : "pass",
    noindex ? "noindex가 설정되어 검색/AI 엔진에서 제외됩니다" : "색인 허용됨",
    "noindex 메타 태그를 제거하세요", 5);

  const totalW = items.reduce((s, i) => s + i.weight, 0);
  const earned = items.reduce((s, i) => s + (i.status === "pass" ? i.weight : i.status === "warn" ? i.weight * 0.4 : 0), 0);
  const score = Math.round((earned / totalW) * 100);
  const grade = score >= 80 ? "우수" : score >= 60 ? "양호" : score >= 40 ? "개선 필요" : "취약";
  res.status(200).json({ url: u.href, score, grade, items: items.map(({ weight, ...r }) => r) });
}
