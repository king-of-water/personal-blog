// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	redirects: {
		'/agent/agent-engineering/': '/agent/agent-development/',
		'/agent/agent-mechanisms/': '/agent/agent-development/',
		'/agent/agent-methods/': '/agent/agent-development/',
		'/agent/agent-frontier/': '/agent/agent-development/',
		'/agent/agent-algorithms/': '/agent/llm-fundamentals/',
	},
});
