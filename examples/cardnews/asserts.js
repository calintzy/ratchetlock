// validate.mjs 규칙을 파일럿용으로 옮긴 이진 검증 (BRIEFING_SPEC §카드용 대중 재작성 기준)
const CATEGORY_ENUM = [
  '보안 · 취약점', '개발 도구 · 업데이트', '데이터베이스 · 신기능',
  'AI 모델 · 신규 공개', '에이전트 · MCP', '콘텐츠 · 크리에이터',
  '오픈소스 · 트렌딩', '기타',
];

module.exports = (output, context) => {
  const fails = [];
  let raw = String(output).trim();
  // 코드펜스 방어 (금지 규칙이지만 파싱은 시도하고 위반으로 기록)
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) { fails.push('코드펜스 출력(금지)'); raw = fenced[1]; }

  let j;
  try { j = JSON.parse(raw); }
  catch { return { pass: false, score: 0, reason: 'JSON 파싱 실패' }; }

  for (const k of ['title', 'subtitle', 'body', 'impact']) {
    if (!j[k] || typeof j[k] !== 'string' || !j[k].trim()) fails.push(`필수 필드 누락/빈값: ${k}`);
  }

  if (j.title && [...j.title].length > 35) fails.push(`title 과장(${[...j.title].length}자 > 35)`);

  // 존댓말: body·impact가 '~습니다/입니다'류 종결을 포함하고 반말 종결이 없어야
  for (const k of ['body', 'impact']) {
    const t = (j[k] || '').replace(/==/g, '');
    if (t && !/니다[.!?]?/.test(t)) fails.push(`${k} 존댓말 종결 없음`);
    if (/[가-힣]다\.(?!\s*$)/.test(t.replace(/니다\./g, '')) || /(?<!니)다\.\s*$/.test(t)) fails.push(`${k} 반말 종결 의심`);
  }

  // duckNote: '덬' 어미 (있을 때만 검사)
  if (j.duckNote) {
    if (!/덬[\s.!?~🦆♪]*$/u.test(j.duckNote)) fails.push(`duckNote '덬' 종결 위반: "${j.duckNote.slice(-8)}"`);
  }

  // 형광펜: == 짝 + 첫 글자 시작 금지
  if (j.body) {
    const marks = (j.body.match(/==/g) || []).length;
    if (marks % 2 !== 0) fails.push('형광펜 == 홀수(짝 안 맞음)');
    if (j.body.startsWith('==')) fails.push('형광펜이 본문 첫 글자에서 시작');
  }

  // category enum
  if (j.category && !CATEGORY_ENUM.includes(j.category)) fails.push(`category enum 위반: "${j.category}"`);

  // 프레이밍: 원문의 '저자 주장' 한정어가 소실되면 안 됨 (휴리스틱)
  const signal = (context.vars && context.vars.signal) || '';
  if (signal.includes('저자 주장')) {
    const all = JSON.stringify(j);
    if (!/(주장|발표 기준|자체 집계|밝혔|측정|따르면|다고 (합니다|했습니다|말합니다))/.test(all)) fails.push("'저자 주장' 한정어 소실(프레이밍 왜곡)");
  }

  return fails.length
    ? { pass: false, score: Math.max(0, 1 - fails.length * 0.25), reason: fails.join(' / ') }
    : { pass: true, score: 1, reason: 'ok' };
};
