export type MainCategory = '后端' | 'Agent' | '项目';

export interface Subcategory {
	name: string;
	slug: string;
	description: string;
	plannedTopics?: string[];
}

export const agentSubcategories: Subcategory[] = [
	{ name: 'Agent 开发', slug: 'agent-development', description: '学习 Harness、Prompt、Context、ReAct、工具、记忆与可靠执行。' },
	{ name: 'Agent 产品与架构', slug: 'agent-products', description: '拆解 Codex、Claude Code、Hermes、OpenClaw 等具体系统。' },
	{ name: 'AI Coding', slug: 'ai-coding', description: '在需求、编码、Review、测试与交付中更好地使用 AI。' },
	{ name: 'RAG 与知识工程', slug: 'rag-knowledge', description: '让知识可检索、可理解、可维护，并成为模型能够使用的上下文。' },
	{ name: 'Agent 方法与评测', slug: 'agent-methods', description: '规划、反思、自进化、多 Agent 协作，以及效果如何被可靠评估。' },
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
