import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const posts = defineCollection({
	loader: glob({ base: './src/content/posts', pattern: '**/*.{md,mdx}' }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		category: z.enum(['后端', 'Agent', '项目']).default('项目'),
		subcategory: z.enum([
			'Agent 开发',
			'Agent 产品拆解',
			'AI 应用与思考',
			'RAG 与知识工程',
			'LLM 原理与训练',
			'Java',
			'Redis',
			'MySQL',
			'消息队列',
			'分布式',
		]).optional(),
		articleClass: z.enum(['flagship', 'focused', 'field-note']).optional(),
		seriesOrder: z.number().int().positive().optional(),
		featured: z.boolean().default(false),
		publishedAt: z.coerce.date(),
		updatedAt: z.coerce.date().optional(),
		tags: z.array(z.string()).default([]),
		tools: z.array(z.object({
			name: z.string(),
			href: z.string().optional(),
		})).default([]),
		draft: z.boolean().default(false),
	}),
});

export const collections = { posts };
