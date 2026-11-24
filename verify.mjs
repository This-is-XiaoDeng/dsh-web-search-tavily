/**
 * End-to-end check for dsh-web-search-tavily against the live Tavily API,
 * using a stub `ctx.web` exactly like the Host does when it mounts the row.
 *
 *   TAVILY_API_KEY=tvly-... node verify.mjs [query]
 *
 * Exits non-zero on registration or search failure.
 */
import { apply, PROVIDER_ID } from './index.js';

let registered;
const ctx = {
	web: {
		registerSearchProvider(provider) {
			registered = provider;
		},
	},
	// No credential service in this stub: the fallback path (process.env).
	get() {
		return undefined;
	},
};

apply(ctx, {
	apiKeyEnv: 'TAVILY_API_KEY',
	searchDepth: process.env.TAVILY_SEARCH_DEPTH ?? 'basic',
	includeAnswer: process.env.TAVILY_INCLUDE_ANSWER === '1',
});

console.log('provider id:', registered?.id, '| expected:', PROVIDER_ID);
console.log('title:', registered?.title, '| available():', registered?.available());
if (registered?.id !== PROVIDER_ID) {
	console.error('FAIL: provider id mismatch');
	process.exit(1);
}

const query = process.argv[2] ?? 'DeepSeek Harness dsh plugin';
const started = Date.now();
try {
	const result = await registered.search({ query, maxResults: 5 });
	console.log(`SEARCH OK in ${Date.now() - started}ms; sources: ${result.sources.length}`);
	for (const source of result.sources.slice(0, 5)) {
		console.log(` - ${source.title ?? '(no title)'} | ${source.url}`);
		const snippet = source.snippet ?? '';
		if (snippet.length > 0) console.log(`   ${snippet.slice(0, 120).replace(/\s+/g, ' ')}…`);
	}
	if (result.content !== undefined) console.log('answer:', result.content.slice(0, 200));
} catch (error) {
	console.error(`SEARCH FAILED after ${Date.now() - started}ms:`, error.message);
	process.exitCode = 1;
}
