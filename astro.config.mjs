// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	redirects: {
		'/agent/agent-development/': '/agent/agent-engineering/',
		'/agent/agent-frontier/': '/agent/agent-methods/',
		'/agent/agent-algorithms/': '/agent/llm-fundamentals/',
	},
});
