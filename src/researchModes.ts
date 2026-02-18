import { ThinkingMode } from './topic.js';
import { UiLanguage, pickLanguageText } from './i18n.js';

const modeLabel: Record<ThinkingMode, string> = {
  cot: 'CoT（链式分步推理）',
  tot: 'ToT（思维树分支比较）',
  got: 'GoT（思维图关系建模）'
};

const organizeFramework: Record<ThinkingMode, string> = {
  cot: [
    '先列出证据，再逐步归纳结论。',
    '每个结论后给出证据出处短句（来自摘要/检索段落）。'
  ].join('\n'),
  tot: [
    '并行给出至少两条可能解释路径（A/B）。',
    '比较路径优劣后，给出最终推荐结论。'
  ].join('\n'),
  got: [
    '用“节点-关系”组织信息（问题、方法、数据、结果、局限）。',
    '明确节点间因果/依赖关系后再给总结。'
  ].join('\n')
};

const brainstormFramework: Record<ThinkingMode, string> = {
  cot: [
    '按“问题拆解→观点→证据→行动建议”顺序推进。',
    '每个角色至少给出1条可执行建议。'
  ].join('\n'),
  tot: [
    '每个角色给出至少两条备选路线并比较。',
    '保留分歧并说明后续验证实验。'
  ].join('\n'),
  got: [
    '构建“研究目标-方法-风险-验证”思维图文字版。',
    '指出关键冲突边并给化解方案。'
  ].join('\n')
};

export function buildPaperOrganizeInstruction(mode: ThinkingMode, language: UiLanguage): string {
  return pickLanguageText(
    language,
    [
      `任务类型：论文信息整理（模式：${modeLabel[mode]}）`,
      '必须严格按以下固定章节输出：',
      '1) 论文基本信息（标题、作者、年份、任务定义）',
      '2) 官方资源（GitHub仓库地址、数据集地址；无则写“未在证据中发现”）',
      '3) 主要创新点（3-5条）',
      '4) 实验平台配置（硬件、训练设置、关键超参；缺失要标注）',
      '5) 结果与结论（核心指标/主要发现）',
      '6) 风险与局限（至少2条）',
      '7) 复现建议（最小可行步骤）',
      '',
      '要求：只依据上下文证据，不确定项必须显式标注。',
      '思维策略：',
      organizeFramework[mode]
    ].join('\n'),
    [
      `Task: Paper information structuring (mode: ${mode.toUpperCase()})`,
      'Output must follow these fixed sections exactly:',
      '1) Basic paper info (title, authors, year, task definition)',
      '2) Official resources (GitHub repo, dataset links; if missing, say "not found in evidence")',
      '3) Main contributions (3-5 items)',
      '4) Experimental setup (hardware, training setup, key hyperparameters; mark missing fields)',
      '5) Results and conclusions (core metrics / major findings)',
      '6) Risks and limitations (at least 2)',
      '7) Reproduction suggestions (minimum viable steps)',
      '',
      'Requirement: use only context evidence; explicitly mark uncertainty.',
      'Reasoning strategy:',
      mode === 'cot'
        ? 'List evidence first, then infer conclusions step by step. Attach a short evidence anchor to each conclusion.'
        : mode === 'tot'
          ? 'Provide at least two parallel reasoning paths and compare them before final recommendation.'
          : 'Organize output as nodes and relations (problem, method, data, result, limitation), then summarize causal dependencies.'
    ].join('\n')
  );
}

export function buildPaperBrainstormInstruction(mode: ThinkingMode, question: string, language: UiLanguage): string {
  return pickLanguageText(
    language,
    [
      `任务类型：论文头脑风暴（模式：${modeLabel[mode]}）`,
      `讨论问题：${question}`,
      '请模拟5位讨论者与用户协作：领域专家、专业教授、专业工程师、博士学长、博士同门。',
      '硬性约束：每次讨论至少1位讨论者给出负面意见（反对/风险/失败可能），不能一味迎合用户。',
      '输出结构：',
      '1) 角色观点（每位角色各1段，含立场与依据）',
      '2) 正反清单（正面观点>=3，负面观点>=1）',
      '3) 分歧点与共识点',
      '4) 下一步实验或研究行动（3条）',
      '',
      '要求：观点要具体、可执行、可验证。',
      '思维策略：',
      brainstormFramework[mode]
    ].join('\n'),
    [
      `Task: Paper brainstorming (mode: ${mode.toUpperCase()})`,
      `Question: ${question}`,
      'Simulate five collaborators: domain expert, professor, engineer, senior PhD, and peer PhD.',
      'Hard constraint: at least one role must provide a negative/critical view (risk, objection, possible failure).',
      'Output structure:',
      '1) Role viewpoints (one paragraph per role, with stance and rationale)',
      '2) Pros and cons list (pros >= 3, cons >= 1)',
      '3) Disagreements and consensus',
      '4) Next experiments/research actions (3 items)',
      '',
      'Requirement: suggestions must be concrete, executable, and testable.',
      'Reasoning strategy:',
      mode === 'cot'
        ? 'Follow the flow: decomposition -> viewpoint -> evidence -> action.'
        : mode === 'tot'
          ? 'Provide at least two alternatives per role and compare trade-offs with validation plans.'
          : 'Build a graph-style text plan linking goal, method, risk, and validation; resolve key conflicts.'
    ].join('\n')
  );
}
