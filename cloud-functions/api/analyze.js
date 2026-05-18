const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';

const SYSTEM_PROMPT = `你是一位拥有10年经验的专业简历优化顾问和HR招聘专家。你的核心任务是对求职者的原始简历与目标职位描述进行匹配分析，并输出一份优化后的、可直接投递的简历。

## 分析要求
1. **匹配度评分解构**: 综合评分(0-100)，以及4个维度分别评分(技能匹配、经验匹配、学历匹配、综合素质)，每个0-100
2. **关键词分析**: 从JD中提取核心关键词，标注简历中已覆盖和缺失的
3. **差距分析**: 找出3-5个简历与JD之间的关键差距，按严重程度(high/medium/low)分级，每条附带具体可操作的提升建议
4. **逐段优化改写**: 对简历的每个主要部分(个人总结/自我评价、工作经历、项目经验、技能专长、教育背景)进行针对性改写。改写原则：
   - 严格贴合JD要求的关键词和技能点
   - 强化STAR法则(情境-任务-行动-结果)的表达
   - 用数据和成果量化工作产出
   - 保留真实经历，绝不编造
5. **完整优化简历**: 基于分析生成一份完整的、格式专业的优化后简历全文

## 输出格式
你必须严格按照以下JSON结构输出，确保JSON完整有效，不要添加markdown代码块标记：
{
  "overall_score": 78,
  "dimension_scores": {
    "skills_match": 75,
    "experience_match": 82,
    "education_match": 90,
    "comprehensive_quality": 70
  },
  "matched_keywords": ["关键词1", "关键词2"],
  "missing_keywords": ["缺失关键词1", "缺失关键词2"],
  "gap_analysis": [
    {
      "gap": "差距描述",
      "severity": "high",
      "suggestion": "具体提升建议"
    }
  ],
  "rewritten_sections": [
    {
      "section_name": "个人总结",
      "original": "原始文本",
      "rewritten": "针对该岗位优化后的文本",
      "change_reason": "修改理由"
    }
  ],
  "optimized_resume": "完整的优化后简历全文，使用换行符分隔各部分"
}

## 重要提醒
- 请勿将JD误解为京东，仅作职位描述的缩写
- 每个字段都不可省略
- 改写内容必须基于原始简历的真实信息，不编造经历
- 使用专业流畅的中文
- 输出纯JSON，不要包含任何解释文字`;

function buildUserPrompt(resumeText, jdText, jobTitle) {
  const title = jobTitle || '目标岗位';
  return `## 目标职位：${title}

## 职位描述
${jdText}

## 原始简历
${resumeText}

请按照系统提示要求，对以上简历和职位描述进行详细分析，并以纯JSON格式输出完整结果。不要添加markdown代码块标记。`;
}

async function callDeepSeek(apiKey, messages) {
  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      response_format: { type: 'json_object' },
      messages,
      temperature: 0.3,
      max_tokens: 8192,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DeepSeek API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

function repairJson(text) {
  // Tier 1: Direct parse
  try {
    return JSON.parse(text);
  } catch (_) { /* continue */ }

  // Tier 2: Extract from markdown code block
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try {
      return JSON.parse(codeBlock[1].trim());
    } catch (_) { /* continue */ }
  }

  // Tier 3: Find outermost { }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch (_) { /* continue */ }
  }

  // Tier 4: Repair common JSON issues
  let repaired = text;
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    repaired = text.slice(firstBrace, lastBrace + 1);
  }
  // Remove trailing commas before } or ]
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');
  // Fix unescaped newlines in strings (naive but often works)
  try {
    return JSON.parse(repaired);
  } catch (_) { /* continue */ }

  throw new Error('Unable to parse AI response as JSON');
}

function validateAnalysis(analysis) {
  const required = ['overall_score', 'dimension_scores', 'matched_keywords',
    'missing_keywords', 'gap_analysis', 'rewritten_sections', 'optimized_resume'];
  for (const key of required) {
    if (!(key in analysis)) {
      throw new Error(`Missing required field: ${key}`);
    }
  }
  if (typeof analysis.overall_score !== 'number' || analysis.overall_score < 0 || analysis.overall_score > 100) {
    analysis.overall_score = Math.max(0, Math.min(100, Number(analysis.overall_score) || 50));
  }
  if (!Array.isArray(analysis.rewritten_sections) || analysis.rewritten_sections.length === 0) {
    throw new Error('rewritten_sections must be a non-empty array');
  }
  return analysis;
}

export default async function onRequest(context) {
  const { request, env } = context;

  // CORS headers
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers,
    });
  }

  try {
    const body = await request.json();
    const { resume_text, jd_text, job_title } = body;

    if (!resume_text || !jd_text) {
      return new Response(JSON.stringify({ error: '请提供简历内容和职位描述' }), {
        status: 400, headers,
      });
    }

    if (resume_text.length > 15000 || jd_text.length > 10000) {
      return new Response(JSON.stringify({ error: '简历或职位描述内容过长' }), {
        status: 400, headers,
      });
    }

    const apiKey = env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: '服务配置错误' }), {
        status: 500, headers,
      });
    }

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(resume_text, jd_text, job_title) },
    ];

    const rawOutput = await callDeepSeek(apiKey, messages);
    const analysis = repairJson(rawOutput);
    validateAnalysis(analysis);

    return new Response(JSON.stringify({ success: true, data: analysis }), {
      status: 200, headers,
    });

  } catch (err) {
    const message = err.message || '分析失败，请稍后重试';
    const status = message.includes('API error') ? 502 : 500;
    return new Response(JSON.stringify({ success: false, error: message }), {
      status, headers,
    });
  }
}
