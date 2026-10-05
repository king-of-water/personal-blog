export type MainCategory = '后端' | 'Agent' | '项目';

export interface PlannedTopic {
	title: string;
	seriesOrder: number;
}

export interface Subcategory {
	name: string;
	slug: string;
	description: string;
	plannedTopics?: Array<string | PlannedTopic>;
}

export const agentSubcategories: Subcategory[] = [
	{
		name: 'LLM 原理与训练',
		slug: 'llm-fundamentals',
		description: '从零理解 Token、Transformer、训练、后训练与推理。',
	},
	{
		name: 'Agent 开发',
		slug: 'agent-development',
		description: '从 Prompt、Context 和工具调用出发，构建可运行、可恢复、可评估的 Agent 系统。',
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
		name: 'AI 应用与思考',
		slug: 'ai-coding',
		description: '从 AI 工具使用、AI Coding 到业务流程与组织协同，讨论 AI 怎样进入真实工作。',
		plannedTopics: [
			'如何给 Coding Agent 准备高质量上下文',
			'从需求到提交：AI 辅助开发的完整工作流',
			'如何让 AI 生成的代码可测试、可审查、可验收',
			'大型任务怎样拆给 AI：计划、检查点与人工接管',
		],
	},
];

export const backendSubcategories: Subcategory[] = [
	{
		name: '分布式',
		slug: 'distributed-systems',
		description: '理解多节点系统中的一致性、复制、协调、故障恢复与数据正确性。',
	},
	{
		name: '系统设计与高并发',
		slug: 'system-design',
		description: '从容量、性能、并发与可用性出发，把数据库、缓存、消息队列和分布式机制组合成完整系统。',
		plannedTopics: [
			{ title: 'Feed 流系统设计：推拉模型、分页与热点用户', seriesOrder: 130 },
			{ title: '消息推送系统设计：连接、路由、离线消息与重试', seriesOrder: 140 },
			{ title: '文件服务设计：分片上传、断点续传、存储与分发', seriesOrder: 150 },
		],
	},
	{
		name: 'MySQL',
		slug: 'mysql',
		description: '索引、事务、执行计划与数据库工程。',
	},
	{
		name: 'Redis',
		slug: 'redis',
		description: '缓存、数据结构、集群与稳定性。',
	},
	{
		name: 'Java',
		slug: 'java',
		description: '语言、JVM、并发与常用框架。',
		plannedTopics: [
			{ title: '三色标记：CMS 与 G1 的并发标记', seriesOrder: 90 },
		],
	},
	{
		name: '消息队列',
		slug: 'message-queue',
		description: '异步通信、削峰、顺序与消息可靠性。',
		plannedTopics: [
			{ title: '顺序消息：为什么全局有序几乎不可取', seriesOrder: 40 },
			{ title: '延迟与定时消息：三种实现与适用边界', seriesOrder: 50 },
			{ title: '消费位点与 Rebalance：消息为什么会重复', seriesOrder: 60 },
			{ title: 'RocketMQ 存储架构：CommitLog 与 ConsumeQueue', seriesOrder: 70 },
		],
	},
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
