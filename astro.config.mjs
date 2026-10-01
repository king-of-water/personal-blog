// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	redirects: {
		'/agent/agent-engineering/': '/agent/agent-products/',
		'/agent/agent-frontier/': '/agent/agent-methods/',
		'/agent/agent-algorithms/': '/agent/llm-fundamentals/',
	},
});
