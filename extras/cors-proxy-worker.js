// MultiWeb Downloader — optional CORS proxy (Cloudflare Workers)
//
// Deploy this yourself (see ../README.md for the two-command version), then
// paste the resulting URL into MultiWeb Downloader → Settings → "پراکسی CORS
// سفارشی" as:
//
//     https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/?url=
//
// (Note the trailing "?url=" — the app appends the target link right after it.)
//
// What it does: relays a GET request to whatever URL is passed in ?url=,
// and adds permissive CORS headers to the response so the browser will let
// MultiWeb Downloader read it. Nothing is logged, stored, or forwarded
// anywhere else by this code.
//
// What it means for privacy: whoever controls this Worker can see every
// URL — and every response body — that passes through it. Only point the
// app at a Worker you deployed yourself, under your own Cloudflare account.
// Never point it at a proxy you don't control.

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export default {
	async fetch(request) {
		if (request.method === 'OPTIONS') {
			return new Response(null, {headers: corsHeaders()});
		}

		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return textResponse('Only GET/HEAD are supported', 405);
		}

		const inbound = new URL(request.url);
		const target = inbound.searchParams.get('url');
		if (!target) {
			return textResponse('Missing ?url= parameter', 400);
		}

		let targetUrl;
		try {
			targetUrl = new URL(target);
		} catch {
			return textResponse('Invalid target URL', 400);
		}

		if (!ALLOWED_PROTOCOLS.has(targetUrl.protocol)) {
			return textResponse('Only http/https targets are allowed', 400);
		}

		let upstream;
		try {
			upstream = await fetch(targetUrl.toString(), {
				method: request.method,
				redirect: 'follow',
				headers: {'User-Agent': 'MultiWebDownloader-CORS-Proxy/1.0'},
			});
		} catch (error) {
			return textResponse(`Upstream fetch failed: ${error.message}`, 502);
		}

		const headers = new Headers(upstream.headers);
		headers.set('Access-Control-Allow-Origin', '*');
		headers.set('Access-Control-Expose-Headers', '*');
		// Strip headers that would otherwise stop the proxied page/asset from
		// being read cross-origin or embedded by the fetching app.
		headers.delete('content-security-policy');
		headers.delete('content-security-policy-report-only');
		headers.delete('x-frame-options');

		return new Response(upstream.body, {status: upstream.status, headers});
	},
};

function corsHeaders() {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
		'Access-Control-Allow-Headers': '*',
	};
}

function textResponse(message, status) {
	return new Response(message, {status, headers: {'content-type': 'text/plain', ...corsHeaders()}});
}
