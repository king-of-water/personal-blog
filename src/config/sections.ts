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
			'数据库为什么要有副本：主从复制、读写分离与数据延迟',
			'Raft：从 Leader 选举到日志提交',
			'Paxos、Raft 与 ZAB 的问题边界和取舍',
			'分布式锁：Redis、ZooKeeper 与 Fencing Token',
			'分布式 ID：UUID、Snowflake 与号段模式',
			'2PC 为什么会阻塞，故障后怎样恢复',
			'TCC、Saga、Outbox 与事务消息怎样选择',
			'Seata 怎样处理锁、回滚与事务恢复',
			'分片、一致性哈希与扩容迁移',
			'服务发现、健康检查与故障摘除',
			'限流、熔断、隔离与降级分别保护什么',
			'分布式任务调度怎样避免重复执行',
			'多机房容灾：故障域、RPO 与 RTO',
			'怎样用故障注入与 Jepsen 验证分布式系统',
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
