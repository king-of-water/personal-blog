import type { CollectionEntry } from 'astro:content';

type Post = CollectionEntry<'posts'>;

export const comparePostsBySeriesOrder = (a: Post, b: Post) => {
	const aOrder = a.data.seriesOrder ?? Number.MAX_SAFE_INTEGER;
	const bOrder = b.data.seriesOrder ?? Number.MAX_SAFE_INTEGER;
	if (aOrder !== bOrder) return aOrder - bOrder;
	return b.data.publishedAt.valueOf() - a.data.publishedAt.valueOf();
};

export const formatSeriesNumber = (index: number) => String(index + 1).padStart(2, '0');
