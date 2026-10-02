export type MainCategory = '后端' | 'Agent' | '项目';

export interface Subcategory {
	name: string;
	slug: string;
	description: string;
	plannedTopics?: string[];
}

export const agentSubcategories: Subcategory[] = [
	{
		name: 'Agent 开发',
		slug: 'agent-development',
		description: '学习 Harness、Prompt、Context、工具、记忆与可靠执行。',
		plannedTopics: [
			'Prompt 工程与 Context 工程有什么区别',
			'Context Engineering：Agent 每一步究竟看到了什么',
			'Skills、Context Compact 与 Memory：长任务怎样管理上下文',
			'Todo、Task Graph 与长任务状态管理',
			'Subagent、后台任务与多 Agent 协作的工程实现',
			'Workflow、Resume 与 Goal Loop：任务如何恢复并真正收口',
			'Agent 生产化：可观测性、安全、成本与故障恢复',
		],
	},
	{
		name: 'Agent 产品与架构',
		slug: 'agent-products',
		description: '拆解 Codex、Claude Code、Hermes、OpenClaw 等具体系统。',
		plannedTopics: [
			'主流 Coding Agent 的工具版图与工作流对比',
			'从产品交互反推 Agent Harness 的设计取舍',
			'自研 Agent 还是接入现成产品：工程决策框架',
		],
	},
	{
		name: 'AI Coding',
		slug: 'ai-coding',
		description: '在需求、编码、Review、测试与交付中更好地使用 AI。',
		plannedTopics: [
			'如何给 Coding Agent 准备高质量上下文',
			'从需求到提交：AI 辅助开发的完整工作流',
			'如何让 AI 生成的代码可测试、可审查、可验收',
			'大型任务怎样拆给 AI：计划、检查点与人工接管',
		],
	},
	{
		name: 'RAG 与知识工程',
		slug: 'rag-knowledge',
		description: '让知识可检索、可理解、可维护，并成为模型能够使用的上下文。',
		plannedTopics: [
			'Chunking 与 Embedding：知识如何进入检索系统',
			'混合检索与重排：召回结果怎样变得更可靠',
			'RAG 评测：检索正确不等于回答正确',
			'GraphRAG：什么时候需要图结构知识',
			'Agentic RAG：让 Agent 自己规划检索过程',
		],
	},
	{
		name: 'Agent 方法与评测',
		slug: 'agent-methods',
		description: '研究规划、反思、自进化与多 Agent 策略，并可靠评估它们是否有效。',
		plannedTopics: [
			'ReAct：推理与行动如何形成反馈循环',
			'Planning：从一次生成到可执行任务计划',
			'Reflection：模型自我反思什么时候真的有效',
			'多 Agent 协作：角色分工、通信与共识机制',
			'Agent Benchmark：任务集、轨迹评测与错误归因',
			'幻觉的来源、检测与工程缓解',
		],
	},
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
