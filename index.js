/**
 * dsh-web-search-tavily — Tavily-backed web search for the DeepSeek Harness
 * (DSH) web capability seam (`ctx.web`).
 *
 * Registers one search provider, id `tavily`. Select it with `web.searchProvider`
 * (profile patch row `web`), and the built-in `web_search` tool runs on Tavily's
 * Search API instead of the shipped DeepSeek route.
 *
 * - **Keyed API**: every search POSTs `{baseURL}/search` with
 *   `Authorization: Bearer <key>`. The key is resolved per search, so rotating it
 *   in the credential store takes effect on the next request — no restart.
 * - **Key sources**, first hit wins: `config.apiKey` (literal, discouraged),
 *   the credential store ref `config.apiKeyEnv` (default `TAVILY_API_KEY`, which
 *   itself falls back to the launch environment / `.env` files), then that same
 *   variable from `process.env`.
 * - **Zero dependencies**: Node builtins only; `fetch` and `AbortSignal` come
 *   from the runtime.
 *
 * Cordis function plugin: `inject: ['web']`. Config (all optional):
 * { apiKey, apiKeyEnv, baseURL, allowCustomBaseURL, searchDepth, maxResults,
 *   includeAnswer, chunksPerSource, timeoutMs }.
 *
 * @module dsh-web-search-tavily
 */

export const inject = ['web'];

/** Registry id under `ctx.web`; select it with `web.searchProvider`. */
export const PROVIDER_ID = 'tavily';

/** Credential ref read when `config.apiKey` is absent. */
export const DEFAULT_API_KEY_ENV = 'TAVILY_API_KEY';

/** Official Tavily endpoint; anything else needs `allowCustomBaseURL`. */
export const DEFAULT_BASE_URL = 'https://api.tavily.com';

/** Display name shown by the provider picker. */
export const PROVIDER_TITLE = 'Tavily';

/**
 * What the provider picker shows under this provider: what it is suited for and
 * what it costs. Localized; English is required by the seam.
 */
export const PROVIDER_DESCRIPTION = {
	en: 'Tavily Search API: ranked web pages with excerpts for one API key (TAVILY_API_KEY). Basic search costs 1 credit, advanced 2.',
	zh: 'Tavily 搜索 API：用一个 API Key（TAVILY_API_KEY）换取带摘要的排序网页结果。基础搜索每次 1 个信用点，高级搜索 2 个。',
};

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_CAP = 20;
const DEFAULT_SEARCH_DEPTH = 'basic';
const SEARCH_DEPTHS = ['basic', 'advanced', 'fast', 'ultra-fast'];
const DEFAULT_CHUNKS_PER_SOURCE = 3;
/** Attempts per search; only transport failures and 502/503/504 are retried. */
const DEFAULT_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 400;
const RETRYABLE_HTTP_STATUSES = new Set([502, 503, 504]);
/** Undici/OS codes of a connection-level failure worth one more try. */
const RETRYABLE_CAUSES = new Set([
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_SOCKET',
	'UND_ERR_CLOSED',
	'ECONNRESET',
	'ECONNREFUSED',
	'ETIMEDOUT',
	'EAI_AGAIN',
	'ENOTFOUND',
]);

//#region configuration

/**
 * Validate and normalize the row config. Unknown or malformed values fall back
 * to the documented defaults instead of failing plugin mount: a typo in the
 * profile patch must not take the whole web seam down.
 *
 * @param config - the row config object (may be omitted).
 */
export function normalizeConfig(config = {}) {
	const searchDepth = SEARCH_DEPTHS.includes(config.searchDepth)
		? config.searchDepth
		: DEFAULT_SEARCH_DEPTH;
	const maxResults = clampInt(config.maxResults, 1, MAX_RESULTS_CAP, DEFAULT_MAX_RESULTS);
	const chunksPerSource = clampInt(config.chunksPerSource, 1, 3, DEFAULT_CHUNKS_PER_SOURCE);
	const timeoutMs = clampInt(config.timeoutMs, 1_000, 120_000, DEFAULT_TIMEOUT_MS);
	const attempts = clampInt(config.attempts, 1, 4, DEFAULT_ATTEMPTS);
	const apiKeyEnv =
		typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.length > 0
			? config.apiKeyEnv
			: DEFAULT_API_KEY_ENV;
	return {
		apiKey: typeof config.apiKey === 'string' && config.apiKey.length > 0 ? config.apiKey : undefined,
		apiKeyEnv,
		baseURL: resolveBaseURL(config.baseURL, config.allowCustomBaseURL === true),
		searchDepth,
		maxResults,
		includeAnswer: config.includeAnswer === true,
		chunksPerSource,
		timeoutMs,
		attempts,
	};
}

/** Clamp an integer-ish config value into `[min, max]`, else the default. */
function clampInt(value, min, max, fallback) {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	const integer = Math.round(value);
	if (integer < min) return min;
	if (integer > max) return max;
	return integer;
}

/**
 * Only the official endpoint is allowed unless the row explicitly opts into a
 * custom one, and a custom one must use https — the API key must never travel
 * to an arbitrary http host.
 *
 * @param baseURL - configured endpoint or undefined.
 * @param allowCustom - `allowCustomBaseURL: true` in the row config.
 */
export function resolveBaseURL(baseURL, allowCustom) {
	const canonical = (typeof baseURL === 'string' && baseURL.length > 0
		? baseURL
		: DEFAULT_BASE_URL).replace(/\/+$/u, '');
	if (canonical === DEFAULT_BASE_URL) return canonical;
	if (allowCustom !== true) {
		throw new Error(
			`tavily: custom baseURL ${JSON.stringify(canonical)} is not allowed; ` +
			`only ${DEFAULT_BASE_URL} is permitted unless allowCustomBaseURL: true`,
		);
	}
	if (!/^https:\/\//u.test(canonical)) {
		throw new Error(`tavily: custom baseURL must use https, got ${JSON.stringify(canonical)}`);
	}
	return canonical;
}

//#endregion

//#region credentials

/**
 * Resolve the API key for one search. Reads the credential store first (which
 * itself falls back to the launch environment and `.env` files), then
 * `process.env` directly. Per-call resolution is the hot-rotation mechanism —
 * nothing is cached across searches.
 *
 * @param ctx - plugin context; `credentials` is optional in a minimal composition.
 * @param options - normalized config (`apiKey`, `apiKeyEnv`).
 */
export async function resolveApiKey(ctx, options) {
	if (options.apiKey !== undefined) return options.apiKey;
	const ref = options.apiKeyEnv;
	const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined;
	if (credentials !== undefined && typeof credentials.resolve === 'function') {
		try {
			const hit = await credentials.resolve(ref);
			if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) {
				return hit.value;
			}
		} catch {
			// A credential-store failure must not hide the environment fallback.
		}
	}
	const ambient = typeof process !== 'undefined' ? process.env[ref] : undefined;
	return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined;
}

//#endregion

//#region response mapping

/**
 * Map a Tavily search payload onto the seam's `WebSearchResult`.
 *
 * Tavily results carry `{ title, url, content, score, raw_content? }`; `content`
 * is a relevance-ranked excerpt and becomes the source `snippet`. A
 * provider-generated `answer` (only when `include_answer` was requested)
 * becomes the result `content`. Duplicate and non-http URLs are dropped.
 *
 * @param payload - parsed JSON response body.
 */
export function mapTavilyPayload(payload) {
	const results = Array.isArray(payload?.results) ? payload.results : [];
	const seen = new Set();
	const sources = [];
	for (const item of results) {
		if (item === null || typeof item !== 'object') continue;
		const url = typeof item.url === 'string' ? item.url.trim() : '';
		if (!/^https?:\/\//iu.test(url) || seen.has(url)) continue;
		seen.add(url);
		const source = { url };
		if (typeof item.title === 'string' && item.title.trim().length > 0) {
			source.title = item.title.trim();
		}
		if (typeof item.content === 'string' && item.content.trim().length > 0) {
			source.snippet = item.content.trim();
		}
		if (typeof item.published_date === 'string' && item.published_date.trim().length > 0) {
			source.publishedAt = item.published_date.trim();
		}
		sources.push(source);
	}
	const result = { sources, truncated: false };
	if (typeof payload?.answer === 'string' && payload.answer.trim().length > 0) {
		result.content = payload.answer.trim();
	}
	return result;
}

//#endregion

//#region transport

/** Compose the caller's signal with a hard per-request timeout. */
function withTimeout(signal, timeoutMs) {
	const timeout = AbortSignal.timeout(timeoutMs);
	if (signal === undefined) return timeout;
	return AbortSignal.any([signal, timeout]);
}

/** A readable, actionable message from a Tavily error response. */
async function apiErrorMessage(response) {
	let detail = '';
	try {
		const parsed = await response.json();
		if (typeof parsed?.error === 'string') detail = parsed.error;
		else if (typeof parsed?.detail?.error === 'string') detail = parsed.detail.error;
		else if (typeof parsed?.detail === 'string') detail = parsed.detail;
		else if (typeof parsed?.message === 'string') detail = parsed.message;
	} catch {
		// Non-JSON error body: keep the status line only.
	}
	const hint = response.status === 401 || response.status === 403
		? ` (invalid or missing Tavily API key — check ${DEFAULT_API_KEY_ENV} in the credential store)`
		: response.status === 429
			? ' (rate limited or plan credits exhausted)'
			: '';
	return `tavily: search failed with HTTP ${response.status}${detail.length > 0 ? `: ${detail}` : ''}${hint}`;
}

/**
 * One Tavily search.
 *
 * @param request - seam search request (`query`, optional `maxResults`).
 * @param options - normalized config.
 * @param apiKey - resolved credential (undefined when none is configured).
 * @param signal - caller cancellation.
 */
async function searchTavily(request, options, apiKey, signal) {
	if (apiKey === undefined) {
		throw new Error(
			'tavily: no API key configured — store one under the credential ref ' +
			`${JSON.stringify(options.apiKeyEnv)} or export it in the environment that starts DSH`,
		);
	}
	if (signal?.aborted === true) throw abortError(signal);

	const maxResults = clampInt(request?.maxResults, 1, MAX_RESULTS_CAP, options.maxResults);
	const body = {
		query: request.query,
		search_depth: options.searchDepth,
		max_results: maxResults,
		include_answer: options.includeAnswer,
		include_raw_content: false,
		include_images: false,
	};
	// chunks_per_source only applies to advanced search; sending it with basic
	// is meaningless and Tavily rejects unknown combinations.
	if (options.searchDepth === 'advanced') {
		body.chunks_per_source = options.chunksPerSource;
	}

	let response;
	for (let attempt = 1; attempt <= options.attempts; attempt++) {
		if (signal?.aborted === true) throw abortError(signal);
		let lastError;
		try {
			response = await fetch(`${options.baseURL}/search`, {
				method: 'POST',
				redirect: 'error',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json',
					authorization: `Bearer ${apiKey}`,
					'user-agent': 'deepseek-harness/web-search-tavily',
				},
				body: JSON.stringify(body),
				signal: withTimeout(signal, options.timeoutMs),
			});
			lastError = undefined;
		} catch (error) {
			if (signal?.aborted === true) throw abortError(signal);
			if (error instanceof DOMException && error.name === 'TimeoutError') {
				throw new Error(`tavily: search timed out after ${options.timeoutMs}ms`);
			}
			lastError = error;
		}
		const retryable = lastError !== undefined
			? isRetryableTransportError(lastError)
			: RETRYABLE_HTTP_STATUSES.has(response.status);
		if (!retryable || attempt === options.attempts) {
			if (lastError !== undefined) throw transportError(lastError);
			break;
		}
		// Transient connect failure (this network drops external connections in
		// bursts) — back off briefly and try again before reporting.
		if (!(await delay(RETRY_BASE_DELAY_MS * attempt, signal))) throw abortError(signal);
	}

	if (!response.ok) throw new Error(await apiErrorMessage(response));

	let payload;
	try {
		payload = await response.json();
	} catch (error) {
		if (signal?.aborted === true) throw abortError(signal);
		throw new Error(`tavily: response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	return mapTavilyPayload(payload);
}

/** Caller cancellation, preserved as an AbortError so the seam can classify it. */
function abortError(signal) {
	if (signal?.reason instanceof Error) return signal.reason;
	const error = new Error('tavily: search aborted');
	error.name = 'AbortError';
	return error;
}

/**
 * Whether a thrown fetch error is a connection-level failure worth retrying.
 * A DNS/connect reset is transient on this kind of network; a TLS or protocol
 * error is not.
 *
 * @param error - the value thrown by `fetch`.
 */
function isRetryableTransportError(error) {
	const cause = error?.cause;
	const code = typeof cause?.code === 'string' ? cause.code : undefined;
	if (code !== undefined && RETRYABLE_CAUSES.has(code)) return true;
	// Node's fetch reports connection problems as TypeError('fetch failed').
	return error instanceof TypeError && error.message === 'fetch failed';
}

/** Report a transport failure with the underlying cause code when there is one. */
function transportError(error) {
	const cause = error?.cause;
	const code = typeof cause?.code === 'string' ? ` (${cause.code})` : '';
	const message = error instanceof Error ? error.message : String(error);
	return new Error(`tavily: search request failed: ${message}${code}`);
}

/**
 * Sleep for `ms`, resolving false if the caller aborts first.
 *
 * @param ms - delay in milliseconds.
 * @param signal - caller cancellation.
 */
function delay(ms, signal) {
	return new Promise((resolve) => {
		if (signal?.aborted === true) {
			resolve(false);
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener?.('abort', onAbort);
			resolve(true);
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve(false);
		};
		signal?.addEventListener?.('abort', onAbort, { once: true });
	});
}

//#endregion

/**
 * Plugin entry: register the `tavily` search provider on `ctx.web`.
 *
 * @param ctx - plugin context carrying `web` (and usually `credentials`).
 * @param config - row config; see {@link normalizeConfig}.
 */
export function apply(ctx, config = {}) {
	const options = normalizeConfig(config);

	ctx.web.registerSearchProvider({
		id: PROVIDER_ID,
		title: PROVIDER_TITLE,
		description: PROVIDER_DESCRIPTION,
		/**
		 * Cheap local check only — no network, per the seam's contract. The API
		 * key is asynchronous to read, so a missing key surfaces as an explicit
		 * error on the first search instead of hiding the provider here.
		 */
		available() {
			return true;
		},
		async search(request, signal) {
			const apiKey = await resolveApiKey(ctx, options);
			return await searchTavily(request, options, apiKey, signal);
		},
	});
}
