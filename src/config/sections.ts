export type MainCategory = '后端' | 'Agent' | '项目';

export interface Subcategory {
	name: string;
	slug: string;
	description: string;
	plannedTopics?: string[];
}

export const agentSubcategories: Subcategory[] = [
	{
		name: 'LLM 原理与训练',
		slug: 'llm-fundamentals',
		description: '从零理解 Token、Transformer、训练、后训练与推理。',
		plannedTopics: [
			'《Attention Is All You Need》精读：Transformer 解决了什么',
			'现代 LLM 的 Transformer：从 Token 输入到下一个 Token',
			'Tokenization：模型看到的文字为什么和人不一样',
			'KV Cache：大模型生成为什么越来越占显存',
			'LLM 预训练：数据、目标函数与 Scaling Law',
			'大模型微调：Full Fine-tuning、LoRA 与 QLoRA',
			'LLM 后训练：从 SFT、RLHF、DPO 到 GRPO',
			'推理优化：Continuous Batching、PagedAttention、量化与投机解码',
		],
	},
	{
		name: 'Agent 开发',
		slug: 'agent-development',
		description: '从 Prompt、Context 和工具调用出发，构建可运行、可恢复、可评估的 Agent 系统。',
		plannedTopics: [
			'Context Engineering：Agent 每一步究竟看到了什么',
			'Agent Loop：ReAct 主循环中的规划、行动与反思',
			'Agent 工具系统：Function Calling、CLI、浏览器、代码执行与 MCP',
			'Skills 与 Memory：能力如何按需加载并跨会话保留',
			'长任务运行：状态、调度、恢复与收口',
			'Subagent 与多 Agent：任务拆分、通信与结果汇总',
			'Agent 生产化：安全、可观测性、成本、并发与故障恢复',
		],
	},
	{
		name: 'RAG 与知识工程',
		slug: 'rag-knowledge',
		description: '让知识可检索、可理解、可维护，并成为模型能够使用的上下文。',
	},
	{
		name: 'Agent 产品拆解',
		slug: 'agent-products',
		description: '拆解 Codex、Claude Code、Hermes、OpenClaw 等真实系统的架构与实现。',
		plannedTopics: [
			'横向拆解：不同 Agent 怎样实现 Context、权限、记忆与任务恢复',
		],
	},
	{
		name: 'AI Coding 实践',
		slug: 'ai-coding',
		description: '在需求、编码、Review、测试与交付中更好地使用现成 AI 工具。',
		plannedTopics: [
			'如何给 Coding Agent 准备高质量上下文',
			'从需求到提交：AI 辅助开发的完整工作流',
			'如何让 AI 生成的代码可测试、可审查、可验收',
			'大型任务怎样拆给 AI：计划、检查点与人工接管',
		],
	},
];

export const backendSubcategories: Subcategory[] = [
	{ name: 'Java', slug: 'java', description: '语言、JVM、并发与常用框架。' },
	{ name: 'Redis', slug: 'redis', description: '缓存、数据结构、集群与稳定性。' },
	{ name: 'MySQL', slug: 'mysql', description: '索引、事务、执行计划与数据库工程。' },
	{ name: '消息队列', slug: 'message-queue', description: '异步通信、削峰、顺序与消息可靠性。' },
	{ name: '分布式', slug: 'distributed-systems', description: '一致性、容错、协调与系统设计。' },
];

export const categoryPath = (category: MainCategory) => (
	category === '后端' ? '/backend/' : category === 'Agent' ? '/agent/' : '/projects/'
);

export const subcategoryPath = (category: MainCategory, subcategory?: string) => {
	if (!subcategory || category === '项目') return categoryPath(category);
	const sections = category === 'Agent' ? agentSubcategories : backendSubcategories;
	const section = sections.find((item) => item.name === subcategory);
	return section ? `${categoryPath(category)}${section.slug}/` : categoryPath(category);
};
