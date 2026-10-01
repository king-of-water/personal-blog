export type MainCategory = '后端' | 'Agent' | '项目';

export interface Subcategory {
	name: string;
	slug: string;
	description: string;
}

export const agentSubcategories: Subcategory[] = [
	{ name: 'Agent 开发', slug: 'agent-development', description: 'Context、工具、状态、权限与可靠执行。' },
	{ name: 'RAG 与知识库', slug: 'rag-knowledge', description: '让知识可检索、可理解、可维护，并成为 Agent 能够使用的上下文。' },
	{ name: 'AI Coding', slug: 'ai-coding', description: 'Code Agent、Skills、仓库知识与研发工作流。' },
	{ name: 'Agent 前沿', slug: 'agent-frontier', description: '新模型、新框架与新型 Agent 产品观察。' },
	{ name: 'Agent 算法', slug: 'agent-algorithms', description: '规划、记忆、反思、搜索与多 Agent 协作。' },
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
