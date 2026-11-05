#!/usr/bin/env node
/**
 * 本地假模型服务：实现 OpenAI 兼容的 /v1/chat/completions，
 * 用来在没有真实 API Key 的情况下跑通「识别 → 批改 → 报表」全流程。
 *
 *   node scripts/mock-provider.mjs --port 8799
 *
 * 在应用「设置」里填：
 *   Base URL: http://127.0.0.1:8799/v1
 *   API Key:  mock
 *   模型名:   mock-vision / mock-text 均可
 */
import http from 'node:http';

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const PORT = Number(getArg('port', 8799));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jsonBody(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
  res.end(buf);
}

function contentText(messages) {
  return messages
    .map((m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join('\n')))
    .join('\n');
}

function answerFor(kind) {
  switch (kind) {
    case 'choice':
      return 'B';
    case 'equation':
      return 'MnO2 + 4HCl(浓) = MnCl2 + Cl2↑ + 2H2O';
    case 'calc':
      return 'pH = -lg(0.1) = 1';
    case 'fill':
      return 'BaCl2';
    default:
      return '先加稀盐酸酸化，再加 BaCl2 溶液，产生白色沉淀则说明含有 SO4²⁻。';
  }
}

function handleRecognize(prompt) {
  // 从题目清单里解析题号与题型
  const lines = prompt.split('\n').filter((l) => /^第.+题｜/.test(l));
  const answers = lines.map((line, idx) => {
    const no = line.match(/^第(.+?)题/)?.[1] ?? String(idx + 1);
    const kind = line.includes('选择题') ? 'choice' : line.includes('方程式') ? 'equation' : line.includes('计算') ? 'calc' : line.includes('填空') ? 'fill' : 'short';
    return { no, content: answerFor(kind), confidence: idx === lines.length - 1 ? 0.55 : 0.93 };
  });
  return {
    studentName: '陈思远',
    studentNo: '20260312',
    answers,
  };
}

function handleGrade(prompt) {
  // 新版提示词：题目/满分在 system，学生作答在 user
  const maxByNo = {};
  for (const m of prompt.matchAll(/第(.+?)题｜[^｜]*｜满分([\d.]+)分/g)) {
    maxByNo[m[1]] = Number(m[2]);
  }

  const items = [];
  for (const m of prompt.matchAll(/"no":\s*"([^"]+)",\s*"answer":\s*"((?:[^"\\]|\\.)*)"/g)) {
    let answer = '';
    try {
      answer = JSON.parse('"' + m[2] + '"');
    } catch {
      answer = m[2];
    }
    items.push({ no: m[1], student: answer });
  }

  const out = items.map((it, i) => {
    const max = maxByNo[it.no] ?? 5;
    const stu = String(it.student ?? '');
    const h = [...stu].reduce((a, c) => a + c.charCodeAt(0), 0);
    const factor = 0.35 + ((h % 61) / 100);
    let score;
    if (!stu) score = 0;
    else if (max <= 5 && /^[A-D]$/.test(stu.trim())) score = /B/.test(stu) ? max : 0;
    else score = Math.round(max * factor * 2) / 2;
    if (i === 1) score = Math.max(0, score - 0.5);
    return {
      no: String(it.no),
      score: Math.min(score, max),
      comment: score >= max ? '答案完整，给分点齐全' : score === 0 ? '未作答或答非所问' : '思路正确，个别步骤不严谨',
      confidence: i === items.length - 1 ? 0.42 : 0.88,
    };
  });

  return { items: out };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url?.includes('/models')) {
    return jsonBody(res, 200, {
      object: 'list',
      data: [
        { id: 'mock-text', object: 'model' },
        { id: 'mock-vision', object: 'model' },
      ],
    });
  }
  if (req.method === 'GET' && req.url?.startsWith('/health')) {
    return jsonBody(res, 200, { ok: true, service: 'mock-provider' });
  }
  if (!req.url?.includes('/chat/completions')) {
    return jsonBody(res, 404, { error: { message: 'not found' } });
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return jsonBody(res, 400, { error: { message: 'bad json' } });
  }

  const prompt = contentText(body.messages ?? []);
  await sleep(180 + Math.random() * 220);

  let payload;
  if (/题目清单提取成结构化数据/.test(prompt)) {
    payload = {
      title: '高二化学 期中试卷',
      notes: 'mock 模型返回的示例数据',
      questions: [
        { no: '1', kind: 'choice', maxScore: 3, answer: 'B' },
        { no: '2', kind: 'choice', maxScore: 3, answer: 'A' },
        { no: '3', kind: 'choice', maxScore: 3, answer: 'C' },
        { no: '4', kind: 'choice', maxScore: 3, answer: 'D' },
        { no: '5', kind: 'fill', maxScore: 4, answer: 'BaCl2' },
        { no: '6', kind: 'equation', maxScore: 6, answer: 'MnO2 + 4HCl(浓) = MnCl2 + Cl2↑ + 2H2O' },
        { no: '7', kind: 'short', maxScore: 8, answer: '先加稀盐酸酸化，再加 BaCl2 溶液，产生白色沉淀' },
        { no: '8', kind: 'calc', maxScore: 6, answer: 'pH = -lg(0.1) = 1' },
      ],
    };
  } else if (/逐行转写/.test(prompt)) {
    const answers = Array.from({ length: 15 }, (_, i) => i + 1).map((no) => ({
      no: String(no),
      content: 'MnO2 + 4HCl(浓) = MnCl2 + Cl2↑ + 2H2O',
      confidence: no === 8 ? 0.55 : 0.9,
    }));
    payload = { name: '陈思远', no: '20260312', answers };
  } else if (/请提取|答题卡|作答原文/.test(prompt) && /studentName/.test(prompt)) {
    payload = handleRecognize(prompt);
  } else if (/请批改|逐题评分/.test(prompt)) {
    payload = handleGrade(prompt);
  } else {
    payload = { echo: 'mock', message: 'hello' };
  }

  const text = JSON.stringify(payload);
  console.log(
    `[mock] model=${body.model} json=${body.response_format?.type ?? '-'} images=${JSON.stringify(body.messages).split('"image_url"').length - 1} -> ${text.slice(0, 110)}`,
  );

  jsonBody(res, 200, {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model ?? 'mock',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000 },
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock provider listening on http://127.0.0.1:${PORT}/v1`);
});
