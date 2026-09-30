import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const posts = defineCollection({
	loader: glob({ base: './src/content/posts', pattern: '**/*.{md,mdx}' }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		category: z.enum(['后端', 'Agent', '个人项目']).default('个人项目'),
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
