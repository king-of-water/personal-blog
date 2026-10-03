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
	{ name: 'Java', slug: 'java', description: '语言、JVM、并发与常用框架。' },
	{ name: 'Redis', slug: 'redis', description: '缓存、数据结构、集群与稳定性。' },
	{ name: 'MySQL', slug: 'mysql', description: '索引、事务、执行计划与数据库工程。' },
	{ name: '消息队列', slug: 'message-queue', description: '异步通信、削峰、顺序与消息可靠性。' },
	{
		name: '分布式',
		slug: 'distributed-systems',
		description: '一致性、容错、协调与系统设计。',
		plannedTopics: [
			'多台机器怎样生成不重复的 ID：UUID、Snowflake 与号段模式',
			'分布式事务：2PC、TCC、Saga、Outbox 与事务消息怎样选',
			'服务地址总在变化，调用方怎样找到它：服务发现、健康检查与故障摘除',
			'下游故障时怎样避免拖垮整个系统：限流、熔断、隔离与降级',
			'多台机器怎样确保定时任务只执行一次：任务调度、租约与幂等',
			'数据库增加副本后，为什么仍会读到旧数据：主从复制、读写分离与 Quorum',
			'节点变化时怎样少搬数据：一致性哈希、虚拟节点与热点',
			'用一个最小 Raft 实现理解选主、日志复制与成员变更',
			'一个机房整体故障后怎样恢复：多机房、RPO 与 RTO',
			'怎样证明系统在故障中仍然正确：故障注入与 Jepsen',
			'综合实战：一个短链接系统怎样应对发号、分片、缓存、热点与容灾',
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
