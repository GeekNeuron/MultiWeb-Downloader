// =============================================================================
// MultiWeb Downloader — app.js
// A from-scratch, no-build client-side download manager inspired by
// download-directory.github.io. Everything runs in the browser; nothing is
// uploaded anywhere except requests to GitHub's API / raw content hosts,
// and — only if the user opts in — a self-hosted CORS proxy.
// =============================================================================

const GITHUB_API = 'https://api.github.com';
const SAFE_BROWSING_BLOCK = /malware|virus|trojan/i;

const FILE_EXTENSIONS = new Set([
	'zip', 'tar', 'gz', 'tgz', 'bz2', '7z', 'rar', 'iso', 'dmg', 'exe', 'apk', 'deb', 'rpm', 'msi',
	'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'csv', 'tsv', 'txt', 'md', 'rtf',
	'json', 'xml', 'yaml', 'yml', 'toml',
	'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'tiff',
	'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac',
	'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v',
	'woff', 'woff2', 'ttf', 'otf', 'eot',
	'wasm', 'bin', 'dat', 'db', 'sqlite',
	'epub', 'mobi',
]);

const KIND_LABELS = {
	'gh-folder': 'پوشه گیت‌هاب',
	'gh-repo': 'مخزن کامل',
	'gh-file': 'فایل گیت‌هاب',
	'direct-file': 'فایل مستقیم',
	webpage: 'صفحه وب',
	'html-snapshot': 'عکس صفحه',
	invalid: 'نامعتبر',
};

const KIND_ICON = {
	'gh-folder': 'icon-folder',
	'gh-repo': 'icon-archive',
	'gh-file': 'icon-file',
	'direct-file': 'icon-file',
	webpage: 'icon-globe',
	'html-snapshot': 'icon-image',
	invalid: 'icon-alert',
};

const STATUS_LABELS = {
	queued: 'در صف',
	listing: 'فهرست‌برداری',
	downloading: 'در حال دانلود',
	zipping: 'فشرده‌سازی',
	paused: 'متوقف‌شده',
	done: 'تمام‌شده',
	error: 'خطا',
	blocked: 'مسدود (CORS)',
	canceled: 'لغوشده',
	'awaiting-selection': 'نیاز به انتخاب',
};

// =============================================================================
// Small generic utilities
// =============================================================================

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(n, min, max) {
	return Math.min(max, Math.max(min, n));
}

function sanitizeFileName(name) {
	return name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'file';
}

function formatBytes(n) {
	if (!n) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = n;
	let i = 0;
	while (value >= 1024 && i < units.length - 1) {
		value /= 1024;
		i++;
	}

	return `${value.toFixed(value < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatDuration(seconds) {
	if (!Number.isFinite(seconds) || seconds < 0) return '';
	const s = Math.round(seconds);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const remS = s % 60;
	if (m < 60) return `${m}:${String(remS).padStart(2, '0')}`;
	const h = Math.floor(m / 60);
	const remM = m % 60;
	return `${h}:${String(remM).padStart(2, '0')}:${String(remS).padStart(2, '0')}`;
}

function guessExtension(pathname) {
	const last = pathname.split('/').filter(Boolean).pop() || '';
	const match = /\.([a-z0-9]{1,8})$/i.exec(last);
	return match ? match[1].toLowerCase() : '';
}

/** Concurrency-limited async map. Rejects as soon as any worker rejects. */
async function pAll(items, worker, {concurrency = 4} = {}) {
	const list = items.slice();
	if (list.length === 0) return [];
	return new Promise((resolve, reject) => {
		let index = 0;
		let active = 0;
		let completed = 0;
		let settled = false;

		function runNext() {
			if (settled) return;
			while (active < concurrency && index < list.length) {
				const current = list[index++];
				active++;
				Promise.resolve(worker(current, index - 1))
					.then(() => {
						active--;
						completed++;
						if (completed === list.length) {
							settled = true;
							resolve();
						} else {
							runNext();
						}
					})
					.catch(error => {
						if (!settled) {
							settled = true;
							reject(error);
						}
					});
			}
		}

		runNext();
	});
}

async function retry(fn, {retries = 2, signal} = {}) {
	let lastError;
	for (let attempt = 0; attempt <= retries; attempt++) {
		if (signal?.aborted) {
			const error = new Error('Aborted');
			error.name = 'AbortError';
			throw error;
		}

		try {
			// eslint-disable-next-line no-await-in-loop
			return await fn();
		} catch (error) {
			lastError = error;
			if (error.name === 'AbortError') throw error;
			if (attempt < retries) {
				// eslint-disable-next-line no-await-in-loop
				await sleep(400 * (attempt + 1));
			}
		}
	}

	throw lastError;
}

function saveBlob(blob, filename) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function openInNewTab(url) {
	const a = document.createElement('a');
	a.href = url;
	a.target = '_blank';
	a.rel = 'noopener';
	document.body.append(a);
	a.click();
	a.remove();
}

let toastHost;
function showToast(message, type = 'info', duration = 3500) {
	toastHost ||= document.getElementById('toastHost');
	if (!toastHost) return;
	const el = document.createElement('div');
	el.className = 'toast';
	el.dataset.type = type;
	el.textContent = message;
	toastHost.append(el);
	requestAnimationFrame(() => el.classList.add('is-visible'));
	setTimeout(() => {
		el.classList.remove('is-visible');
		setTimeout(() => el.remove(), 250);
	}, duration);
}

let jszipPromise;
function loadJSZip() {
	jszipPromise ||= import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm').then(m => m.default ?? m);
	return jszipPromise;
}

/** A resumable "gate": download loops call `await gate.wait()` between units
 * of work (a file, a stream chunk). While paused, that await just hangs
 * until `resume()` is called — no request is aborted, no progress is lost. */
function createPauseGate() {
	let paused = false;
	let resolveFn = null;
	return {
		get paused() {
			return paused;
		},
		pause() {
			paused = true;
		},
		resume() {
			paused = false;
			if (resolveFn) {
				const r = resolveFn;
				resolveFn = null;
				r();
			}
		},
		async wait() {
			if (!paused) return;
			await new Promise(resolve => {
				resolveFn = resolve;
			});
		},
	};
}

// =============================================================================
// URL classification
// =============================================================================

function classifyUrl(rawInput) {
	const raw = rawInput.trim();
	let url;
	try {
		url = new URL(raw);
	} catch {
		return {kind: 'invalid', raw, label: raw, error: 'این یک لینک معتبر نیست.'};
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return {kind: 'invalid', raw, label: raw, error: 'فقط لینک‌های http یا https پشتیبانی می‌شوند.'};
	}

	const host = url.hostname.replace(/^www\./, '');

	if (host === 'github.com') {
		return classifyGithubUrl(url, raw);
	}

	if (['raw.githubusercontent.com', 'gist.githubusercontent.com', 'objects.githubusercontent.com', 'media.githubusercontent.com', 'codeload.github.com'].includes(host)) {
		return {
			kind: 'direct-file',
			raw,
			url: url.href,
			label: url.pathname.split('/').filter(Boolean).pop() || host,
		};
	}

	const ext = guessExtension(url.pathname);
	if (ext && FILE_EXTENSIONS.has(ext)) {
		return {
			kind: 'direct-file',
			raw,
			url: url.href,
			label: url.pathname.split('/').filter(Boolean).pop() || host,
		};
	}

	return {
		kind: 'webpage',
		raw,
		url: url.href,
		label: host + (url.pathname === '/' ? '' : url.pathname),
	};
}

function classifyGithubUrl(url, raw) {
	const segments = url.pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s));
	const [user, repo, type, ...rest] = segments;

	if (!user || !repo) {
		return {kind: 'invalid', raw, label: raw, error: 'این لینک به یک ریپازیتوری گیت‌هاب اشاره نمی‌کند.'};
	}

	if (!type) {
		return {kind: 'gh-repo', raw, user, repo, label: `${user}/${repo}`};
	}

	if (type === 'tree') {
		if (rest.length === 0) {
			return {kind: 'invalid', raw, label: raw, error: 'شاخه یا مسیر پوشه در این لینک مشخص نیست.'};
		}

		return {kind: 'gh-folder', raw, user, repo, parts: rest, label: `${user}/${repo}`};
	}

	if (type === 'blob') {
		if (rest.length === 0) {
			return {kind: 'invalid', raw, label: raw, error: 'مسیر فایل در این لینک مشخص نیست.'};
		}

		return {kind: 'gh-file', raw, user, repo, parts: rest, label: `${user}/${repo}`};
	}

	return {
		kind: 'invalid',
		raw,
		label: raw,
		error: `لینک‌های «${type}/…» گیت‌هاب پشتیبانی نمی‌شوند — لینک یک پوشه (tree)، فایل (blob) یا ریشه‌ی ریپو را بچسبانید.`,
	};
}

function extractUrls(text) {
	const matches = text.match(/https?:\/\/\S+/g) || [];
	return matches.map(u => u.replace(/[),.;'"]+$/, ''));
}

// =============================================================================
// Settings (persisted in localStorage, mirrored from the settings dialog)
// =============================================================================

const els = {};

function cacheDom() {
	const ids = [
		'themeToggle', 'themeIconSun', 'themeIconMoon',
		'addBtn', 'addDialog', 'intakeForm', 'intakeInput', 'cancelAddBtn', 'emptyAddBtn',
		'pasteClipboardBtn', 'pasteIntoIntakeBtn',
		'startAllBtn', 'pauseAllBtn', 'pauseAllLabel',
		'settingsBtn', 'settingsDialog', 'closeSettingsBtn',
		'tokenInput', 'itemConcurrency', 'fileConcurrency', 'proxyInput',
		'exportQueueBtn', 'importQueueInput',
		'combineToggle', 'clearFinishedBtn',
		'queueList', 'emptyState', 'combineBar', 'finalizeCombineBtn', 'combineFileCount',
		'statusSummary',
		'count-all', 'count-active', 'count-queued', 'count-done', 'count-error',
	];
	for (const id of ids) els[id] = document.getElementById(id);
}

function getToken() {
	return els.tokenInput.value.trim();
}

function getProxy() {
	return els.proxyInput.value.trim();
}

function getItemConcurrency() {
	return clamp(Number.parseInt(els.itemConcurrency.value, 10) || 2, 1, 6);
}

function getFileConcurrency() {
	return clamp(Number.parseInt(els.fileConcurrency.value, 10) || 12, 1, 30);
}

function loadSettings() {
	els.tokenInput.value = localStorage.getItem('mwd-token') || '';
	els.itemConcurrency.value = localStorage.getItem('mwd-item-concurrency') || '2';
	els.fileConcurrency.value = localStorage.getItem('mwd-file-concurrency') || '12';
	els.proxyInput.value = localStorage.getItem('mwd-proxy') || '';

	els.tokenInput.addEventListener('input', () => localStorage.setItem('mwd-token', els.tokenInput.value));
	els.itemConcurrency.addEventListener('change', () => localStorage.setItem('mwd-item-concurrency', els.itemConcurrency.value));
	els.fileConcurrency.addEventListener('change', () => localStorage.setItem('mwd-file-concurrency', els.fileConcurrency.value));
	els.proxyInput.addEventListener('input', () => localStorage.setItem('mwd-proxy', els.proxyInput.value));
}

function applyTheme(theme) {
	document.documentElement.dataset.theme = theme;
	els.themeToggle.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
	els.themeIconSun.hidden = theme === 'dark';
	els.themeIconMoon.hidden = theme !== 'dark';
}

// =============================================================================
// GitHub API layer
// =============================================================================

function ghAuthHeaders() {
	const token = getToken();
	return token ? {Authorization: `Bearer ${token}`} : {};
}

async function ghFetch(url, {method, signal} = {}) {
	const res = await fetch(url, {method, signal, headers: ghAuthHeaders()});
	if (res.status === 401) {
		throw new Error('توکن گیت‌هاب نامعتبر است یا لغو شده.');
	}

	if ((res.status === 403 || res.status === 429) && res.headers.get('X-RateLimit-Remaining') === '0') {
		throw new Error('سقف درخواست گیت‌هاب پر شده — کمی صبر کنید یا در تنظیمات یک توکن معتبر وارد کنید.');
	}

	return res;
}

async function ghFetchBlobWithProgress(url, signal, onProgress, gate) {
	const res = await ghFetch(url, {signal});
	if (!res.ok) throw new Error(`دانلود ناموفق بود (HTTP ${res.status})`);
	return readBlobWithProgress(res, onProgress, gate);
}

async function readBlobWithProgress(res, onProgress, gate) {
	const total = Number(res.headers.get('content-length')) || 0;
	if (!res.body || !onProgress) return res.blob();
	const reader = res.body.getReader();
	const chunks = [];
	let received = 0;
	for (;;) {
		if (gate) {
			// eslint-disable-next-line no-await-in-loop
			await gate.wait();
		}

		// eslint-disable-next-line no-await-in-loop
		const {done, value} = await reader.read();
		if (done) break;
		chunks.push(value);
		received += value.length;
		onProgress(received, total);
	}

	return new Blob(chunks);
}

async function getRepoInfo(user, repo, signal) {
	const res = await ghFetch(`${GITHUB_API}/repos/${user}/${repo}`, {signal});
	if (res.status === 404) {
		throw new Error('ریپازیتوری پیدا نشد. اگر خصوصی است، در تنظیمات توکنی با دسترسی وارد کنید.');
	}

	if (!res.ok) throw new Error(`خطای گیت‌هاب (HTTP ${res.status})`);
	const data = await res.json();
	return {isPrivate: Boolean(data.private)};
}

/** Mirrors the original tool's branch/ref resolution: try longer and longer
 * path prefixes as the git ref until one of them resolves to a real commit. */
async function resolveRef(user, repo, parts, signal) {
	for (let i = 0; i < parts.length; i++) {
		const ref = parts.slice(0, i + 1).join('/');
		// eslint-disable-next-line no-await-in-loop
		const res = await ghFetch(`${GITHUB_API}/repos/${user}/${repo}/commits/${ref}?per_page=1`, {method: 'HEAD', signal});
		if (res.ok) {
			return {ref, rest: parts.slice(i + 1)};
		}
	}

	return null;
}

function escapeFilepath(path) {
	return path.replaceAll('%', '%25').replaceAll('#', '%23');
}

async function isLfsPointer(res) {
	const length = Number(res.headers.get('content-length'));
	if (length > 120 && length < 200) {
		const text = await res.clone().text();
		return text.startsWith('version https://git-lfs.github.com/spec/v1');
	}

	return false;
}

async function downloadGithubFileBlob({user, repo, ref, file, isPrivate, signal}) {
	if (!isPrivate) {
		const rawUrl = `https://raw.githubusercontent.com/${user}/${repo}/${ref}/${escapeFilepath(file.path)}`;
		let res = await fetch(rawUrl, {signal});
		if (!res.ok) throw new Error(`HTTP ${res.status} برای ${file.path}`);
		if (await isLfsPointer(res)) {
			const lfsUrl = `https://media.githubusercontent.com/media/${user}/${repo}/${ref}/${escapeFilepath(file.path)}`;
			res = await fetch(lfsUrl, {signal});
			if (!res.ok) throw new Error(`HTTP ${res.status} برای ${file.path}`);
		}

		return res.blob();
	}

	const res = await ghFetch(file.url, {signal});
	if (!res.ok) throw new Error(`HTTP ${res.status} برای ${file.path}`);
	const data = await res.json();
	return base64ToBlob(data.content, data.encoding || 'base64');
}

function base64ToBlob(base64, encoding) {
	const clean = encoding === 'base64' ? base64.replaceAll('\n', '') : base64;
	const binary = atob(clean);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new Blob([bytes]);
}

async function listGithubFolder({user, repo, ref, directory, signal, onProgress}) {
	const treeRes = await ghFetch(`${GITHUB_API}/repos/${user}/${repo}/git/trees/${ref}?recursive=1`, {signal});
	if (!treeRes.ok) throw new Error(`دریافت فهرست فایل‌ها ناموفق بود (HTTP ${treeRes.status})`);
	const treeData = await treeRes.json();
	const prefix = directory ? `${directory}/` : '';
	let files = (treeData.tree || [])
		.filter(entry => entry.type === 'blob')
		.filter(entry => !directory || entry.path === directory || entry.path.startsWith(prefix))
		.map(entry => ({path: entry.path, url: entry.url}));

	if (treeData.truncated) {
		onProgress?.('این مخزن بزرگ است؛ فهرست فایل‌ها به روشی جایگزین خوانده می‌شود…');
		files = await listGithubFolderViaContents({user, repo, ref, directory, signal});
	}

	return files;
}

/** Fallback for repos too large for the (single-request) Trees API. Walks
 * the Contents API recursively, with limited concurrency across sibling
 * directories at each level — sequential-per-branch, parallel-across-branches. */
async function listGithubFolderViaContents({user, repo, ref, directory, signal}) {
	const results = [];
	async function walk(path) {
		const url = `${GITHUB_API}/repos/${user}/${repo}/contents/${path ? encodeURI(path) : ''}?ref=${encodeURIComponent(ref)}`;
		const res = await ghFetch(url, {signal});
		if (!res.ok) throw new Error(`خواندن مسیر «${path || '/'}» ناموفق بود.`);
		const data = await res.json();
		const entries = Array.isArray(data) ? data : [data];
		for (const entry of entries) {
			if (entry.type === 'file') results.push({path: entry.path, url: entry.url});
		}

		const dirs = entries.filter(entry => entry.type === 'dir');
		if (dirs.length > 0) {
			await pAll(dirs, async d => walk(d.path), {concurrency: 4});
		}
	}

	await walk(directory);
	return results;
}

// =============================================================================
// Generic (non-GitHub) fetching, with an optional user-supplied CORS proxy
// =============================================================================

async function plainFetchMaybeProxied(url, signal) {
	try {
		return await fetch(url, {signal});
	} catch (error) {
		if (error.name === 'AbortError') throw error;
		const proxy = getProxy();
		if (!proxy) return null; // Signals "blocked, no proxy configured"
		try {
			return await fetch(proxy + encodeURIComponent(url), {signal});
		} catch (error2) {
			if (error2.name === 'AbortError') throw error2;
			return null;
		}
	}
}

function filenameFromResponse(res, url) {
	const cd = res.headers.get('content-disposition');
	if (cd) {
		const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
		if (match) {
			try {
				return decodeURIComponent(match[1]);
			} catch {
				return match[1];
			}
		}
	}

	try {
		const last = new URL(url).pathname.split('/').filter(Boolean).pop();
		return last ? decodeURIComponent(last) : 'file';
	} catch {
		return 'file';
	}
}

// =============================================================================
// Queue item model
// =============================================================================

const queue = [];
let idCounter = 0;
let combineMode = false;
let sharedZip = null;
let sharedZipFileCount = 0;
let currentFilter = 'all';

function createItem(classified) {
	return {
		id: ++idCounter,
		raw: classified.raw,
		kind: classified.kind,
		data: classified,
		label: classified.label || classified.raw,
		subtitle: classified.raw,
		status: classified.kind === 'invalid' ? 'error' : 'queued',
		message: classified.error || '',
		progress: null,
		rate: null,
		controller: null,
		gate: createPauseGate(),
		discovered: null,
		showOpenTab: false,
		forcedFilename: null,
		el: null,
		pickerBuilt: false,
		_lastRender: 0,
		_rateT: null,
		_rateV: null,
	};
}

function setStatus(item, status) {
	item.status = status;
}

function updateRate(item, currentValue) {
	const now = performance.now();
	if (item._rateT === null) {
		item._rateT = now;
		item._rateV = currentValue;
		item.rate = 0;
		return;
	}

	const dt = (now - item._rateT) / 1000;
	if (dt <= 0) return;
	const inst = (currentValue - item._rateV) / dt;
	item.rate = item.rate === null ? inst : (item.rate * 0.6) + (inst * 0.4);
	item._rateT = now;
	item._rateV = currentValue;
}

function resetRate(item) {
	item._rateT = null;
	item._rateV = null;
	item.rate = null;
}

/** Throttled progress reporter shared by every download path: updates the
 * numeric progress, the smoothed rate, and repaints the row — at most a
 * few times a second, never once per network chunk. */
function reportProgress(item, current, total, bytes) {
	item.progress = {current, total, bytes};
	const now = performance.now();
	const isFinal = total > 0 && current >= total;
	if (now - item._lastRender > 150 || isFinal) {
		item._lastRender = now;
		updateRate(item, current);
		render(item);
		updateStatusBar();
	}
}

async function ensureSharedZip() {
	if (!sharedZip) {
		const JSZip = await loadJSZip();
		sharedZip = new JSZip();
	}

	return sharedZip;
}

function registerCombineContribution(item, count) {
	sharedZipFileCount += count;
	updateCombineBar();
}

function finalFilename(item, fallbackBase) {
	const base = item.forcedFilename || fallbackBase;
	const withExt = base.toLowerCase().endsWith('.zip') ? base : `${base}.zip`;
	return sanitizeFileName(withExt);
}

// ---- per-kind runners -------------------------------------------------------

async function runWholeRepoZip(item, {user, repo, ref}, signal) {
	setStatus(item, 'downloading');
	resetRate(item);
	item.progress = {current: 0, total: 0, bytes: true};
	render(item);

	const url = ref
		? `${GITHUB_API}/repos/${user}/${repo}/zipball/${ref}`
		: `${GITHUB_API}/repos/${user}/${repo}/zipball`;

	const blob = await ghFetchBlobWithProgress(url, signal, (received, total) => {
		reportProgress(item, received, total, true);
	}, item.gate);

	if (!combineMode) {
		saveBlob(blob, finalFilename(item, `${user}-${repo}${ref ? '-' + ref : ''}`));
		setStatus(item, 'done');
		item.message = 'کل مخزن دانلود شد.';
		return;
	}

	setStatus(item, 'zipping');
	render(item);
	const JSZip = await loadJSZip();
	const sourceZip = await JSZip.loadAsync(blob);
	const shared = await ensureSharedZip();
	const folder = shared.folder(sanitizeFileName(`${user}-${repo}${ref ? '-' + ref : ''}`));
	let count = 0;
	for (const relPath of Object.keys(sourceZip.files)) {
		const entry = sourceZip.files[relPath];
		if (entry.dir) continue;
		// eslint-disable-next-line no-await-in-loop
		const content = await entry.async('blob');
		folder.file(relPath.replace(/^[^/]+\//, ''), content);
		count++;
	}

	registerCombineContribution(item, count);
	setStatus(item, 'done');
	item.message = `${count} فایل به بسته‌ی مشترک اضافه شد.`;
}

async function runGhRepo(item, signal) {
	const {user, repo} = item.data;
	item.subtitle = `${user}/${repo}`;
	render(item);
	await runWholeRepoZip(item, {user, repo, ref: null}, signal);
}

async function runGhFolder(item, signal) {
	const {user, repo, parts} = item.data;
	item.subtitle = `${user}/${repo}`;
	setStatus(item, 'listing');
	render(item);

	const repoInfo = await getRepoInfo(user, repo, signal);
	const resolved = await resolveRef(user, repo, parts, signal);
	if (!resolved) throw new Error('شاخه یا مسیرِ این پوشه در ریپازیتوری پیدا نشد.');
	const {ref, rest} = resolved;
	const directory = rest.join('/');
	item.subtitle = `${user}/${repo} · ${ref}${directory ? ' · ' + directory : ''}`;
	render(item);

	if (!directory) {
		return runWholeRepoZip(item, {user, repo, ref}, signal);
	}

	let files = await listGithubFolder({
		user, repo, ref, directory, signal,
		onProgress(message) {
			item.message = message;
			render(item);
		},
	});

	let blockedCount = 0;
	files = files.filter(f => {
		if (SAFE_BROWSING_BLOCK.test(f.path)) {
			blockedCount++;
			return false;
		}

		return true;
	});

	if (files.length === 0) {
		throw new Error(blockedCount > 0
			? 'همه‌ی فایل‌های این پوشه به دلایل ایمنی مسدود شدند.'
			: 'فایلی در این پوشه پیدا نشد.');
	}

	setStatus(item, 'downloading');
	resetRate(item);
	item.progress = {current: 0, total: files.length, bytes: false};
	item.message = '';
	render(item);

	let zip;
	if (combineMode) {
		zip = await ensureSharedZip();
	} else {
		const JSZip = await loadJSZip();
		zip = new JSZip();
	}

	const folderName = sanitizeFileName(`${user}-${repo}-${directory.split('/').pop()}`);
	const zipRoot = combineMode ? zip.folder(folderName) : zip;

	let completed = 0;
	await pAll(files, async file => {
		await item.gate.wait();
		const blob = await retry(
			async () => downloadGithubFileBlob({user, repo, ref, file, isPrivate: repoInfo.isPrivate, signal}),
			{retries: 2, signal},
		);
		const relPath = file.path.slice(directory.length + 1);
		zipRoot.file(relPath, blob, {binary: true});
		completed++;
		reportProgress(item, completed, files.length, false);
	}, {concurrency: getFileConcurrency()});

	if (combineMode) {
		registerCombineContribution(item, files.length);
		setStatus(item, 'done');
		item.message = blockedCount > 0
			? `${files.length} فایل اضافه شد؛ ${blockedCount} فایل به دلایل ایمنی حذف شد.`
			: `${files.length} فایل به بسته‌ی مشترک اضافه شد.`;
		return;
	}

	setStatus(item, 'zipping');
	render(item);
	const blob = await zip.generateAsync({type: 'blob'});
	saveBlob(blob, finalFilename(item, `${user}-${repo}-${ref}-${directory.split('/').pop()}`));
	setStatus(item, 'done');
	item.message = blockedCount > 0
		? `${files.length} فایل دانلود شد؛ ${blockedCount} فایل به دلایل ایمنی حذف شد.`
		: `${files.length} فایل دانلود شد.`;
}

async function runGhFile(item, signal) {
	const {user, repo, parts} = item.data;
	item.subtitle = `${user}/${repo}`;
	setStatus(item, 'listing');
	render(item);

	const repoInfo = await getRepoInfo(user, repo, signal);
	const resolved = await resolveRef(user, repo, parts, signal);
	if (!resolved || resolved.rest.length === 0) throw new Error('مسیر این فایل در ریپازیتوری پیدا نشد.');
	const {ref, rest} = resolved;
	const path = rest.join('/');
	item.subtitle = `${user}/${repo} · ${ref} · ${path}`;
	setStatus(item, 'downloading');
	render(item);

	const file = {
		path,
		url: `${GITHUB_API}/repos/${user}/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`,
	};
	const blob = await retry(
		async () => downloadGithubFileBlob({user, repo, ref, file, isPrivate: repoInfo.isPrivate, signal}),
		{retries: 2, signal},
	);
	const filename = sanitizeFileName(path.split('/').pop());

	if (combineMode) {
		const shared = await ensureSharedZip();
		shared.file(filename, blob);
		registerCombineContribution(item, 1);
		setStatus(item, 'done');
		item.message = 'به بسته‌ی مشترک اضافه شد.';
	} else {
		saveBlob(blob, filename);
		setStatus(item, 'done');
		item.message = 'فایل دانلود شد.';
	}
}

async function runDirectFile(item, signal) {
	const url = item.data.url;
	item.subtitle = url;
	setStatus(item, 'downloading');
	resetRate(item);
	item.progress = {current: 0, total: 0, bytes: true};
	render(item);

	const res = await plainFetchMaybeProxied(url, signal);
	if (!res) {
		setStatus(item, 'blocked');
		item.message = 'مرورگر به‌خاطر محدودیت CORS نتوانست این فایل را مستقیم بخواند. یک تلاش برای باز کردنِ مستقیم انجام شد — اگر دانلود نشد، «باز کردن در تب جدید» را بزنید یا در تنظیمات یک پراکسی معرفی کنید.';
		item.showOpenTab = true;
		openInNewTab(url);
		return;
	}

	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const filename = sanitizeFileName(filenameFromResponse(res, url));
	const blob = await readBlobWithProgress(res, (received, total) => {
		reportProgress(item, received, total, true);
	}, item.gate);

	if (combineMode) {
		const shared = await ensureSharedZip();
		shared.file(filename, blob);
		registerCombineContribution(item, 1);
		setStatus(item, 'done');
		item.message = 'به بسته‌ی مشترک اضافه شد.';
	} else {
		saveBlob(blob, filename);
		setStatus(item, 'done');
		item.message = 'فایل دانلود شد.';
	}
}

async function runWebpage(item, signal) {
	const url = item.data.url;
	item.subtitle = url;
	setStatus(item, 'listing');
	render(item);

	const res = await plainFetchMaybeProxied(url, signal);
	if (!res) {
		setStatus(item, 'blocked');
		item.message = 'مرورگر به‌خاطر محدودیت CORS نتوانست محتوای این صفحه را بخواند — این محدودیت امنیتیِ خودِ مرورگر است، نه ایراد این ابزار. می‌توانید صفحه را در تب جدید باز کنید یا در تنظیمات یک پراکسی CORS معرفی کنید.';
		item.showOpenTab = true;
		render(item);
		return;
	}

	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const contentType = res.headers.get('content-type') || '';
	const text = await res.text();
	const looksHtml = contentType.includes('html') || /<html[\s>]/i.test(text.slice(0, 1000));

	if (!looksHtml) {
		const blob = new Blob([text]);
		const filename = sanitizeFileName(filenameFromResponse(res, url));
		if (combineMode) {
			const shared = await ensureSharedZip();
			shared.file(filename, blob);
			registerCombineContribution(item, 1);
		} else {
			saveBlob(blob, filename);
		}

		setStatus(item, 'done');
		item.message = 'فایل دانلود شد.';
		return;
	}

	const doc = new DOMParser().parseFromString(text, 'text/html');
	const anchors = [...doc.querySelectorAll('a[href]')];
	const seen = new Set();
	const links = [{href: url, label: 'خودِ این صفحه (HTML)', isPage: true, isFile: false, selected: false}];
	for (const a of anchors) {
		let href;
		try {
			href = new URL(a.getAttribute('href'), url).href;
		} catch {
			continue;
		}

		if (!href.startsWith('http') || seen.has(href)) continue;
		seen.add(href);
		const ext = guessExtension(new URL(href).pathname);
		const isFile = FILE_EXTENSIONS.has(ext);
		links.push({href, isFile, selected: isFile});
	}

	links.sort((a, b) => (a.isPage ? -1 : b.isPage ? 1 : Number(b.isFile) - Number(a.isFile)));

	item.discovered = {pageHtml: text, pageUrl: url, links};
	setStatus(item, 'awaiting-selection');
	item.message = links.length > 1
		? `${links.length - 1} لینک در این صفحه پیدا شد.`
		: 'لینکی در این صفحه پیدا نشد؛ می‌توانید خودِ صفحه را دانلود کنید.';
	render(item);
}

async function runHtmlSnapshot(item) {
	setStatus(item, 'zipping');
	render(item);
	const blob = new Blob([item.data.html], {type: 'text/html'});
	const filename = item.label.toLowerCase().endsWith('.html') ? item.label : `${item.label}.html`;
	if (combineMode) {
		const shared = await ensureSharedZip();
		shared.file(sanitizeFileName(filename), blob);
		registerCombineContribution(item, 1);
		setStatus(item, 'done');
		item.message = 'به بسته‌ی مشترک اضافه شد.';
	} else {
		saveBlob(blob, sanitizeFileName(filename));
		setStatus(item, 'done');
		item.message = 'صفحه به‌صورت HTML ذخیره شد.';
	}
}

async function runItem(item) {
	if (['listing', 'downloading', 'zipping'].includes(item.status)) return;
	item.controller = new AbortController();
	const signal = item.controller.signal;
	item.gate.resume();
	item.showOpenTab = false;
	item.message = '';
	setStatus(item, 'listing');
	render(item);
	updateGlobalUi();

	try {
		switch (item.kind) {
			case 'gh-folder': {
				await runGhFolder(item, signal);
				break;
			}

			case 'gh-repo': {
				await runGhRepo(item, signal);
				break;
			}

			case 'gh-file': {
				await runGhFile(item, signal);
				break;
			}

			case 'direct-file': {
				await runDirectFile(item, signal);
				break;
			}

			case 'webpage': {
				await runWebpage(item, signal);
				break;
			}

			case 'html-snapshot': {
				await runHtmlSnapshot(item);
				break;
			}

			default: {
				throw new Error(item.data.error || 'نوع این لینک پشتیبانی نمی‌شود.');
			}
		}
	} catch (error) {
		if (error.name === 'AbortError') {
			setStatus(item, 'canceled');
			item.message = 'لغو شد.';
		} else {
			setStatus(item, 'error');
			item.message = error.message || 'خطای ناشناخته رخ داد.';
		}
	} finally {
		item.controller = null;
		render(item);
		updateGlobalUi();
	}
}

function filenameForPage(url) {
	try {
		const u = new URL(url);
		const base = u.pathname.replace(/\/$/, '').split('/').filter(Boolean).pop();
		return sanitizeFileName(base || u.hostname);
	} catch {
		return 'page';
	}
}

function addDiscoveredSelections(item) {
	const picked = item.discovered.links.filter(l => l.selected);
	if (picked.length === 0) return;
	for (const link of picked) {
		let classified;
		if (link.isPage) {
			classified = {
				kind: 'html-snapshot',
				raw: link.href,
				label: filenameForPage(link.href),
				url: link.href,
				html: item.discovered.pageHtml,
			};
		} else {
			classified = classifyUrl(link.href);
		}

		const newItem = createItem(classified);
		queue.push(newItem);
		addItemToDom(newItem);
	}

	updateGlobalUi();
}

// =============================================================================
// Rendering
// =============================================================================

function addItemToDom(item) {
	const tpl = document.getElementById('rowTemplate');
	const li = tpl.content.firstElementChild.cloneNode(true);
	item.el = li;
	const iconBox = li.querySelector('.row-icon');
	iconBox.dataset.kind = item.kind;
	iconBox.innerHTML = `<svg width="18" height="18"><use href="#${KIND_ICON[item.kind] || 'icon-file'}"></use></svg>`;
	wireItemButtons(item, li);
	els.queueList.append(li);
	render(item);
	applyFilterToItem(item);
}

function wireItemButtons(item, li) {
	li.querySelector('.act-start').addEventListener('click', () => runItem(item));
	li.querySelector('.act-retry').addEventListener('click', () => runItem(item));
	li.querySelector('.act-pause').addEventListener('click', () => {
		item.gate.pause();
		setStatus(item, 'paused');
		render(item);
		updateGlobalUi();
	});
	li.querySelector('.act-resume').addEventListener('click', () => {
		item.gate.resume();
		setStatus(item, 'downloading');
		render(item);
		updateGlobalUi();
	});
	li.querySelector('.act-cancel').addEventListener('click', () => {
		item.controller?.abort();
	});
	li.querySelector('.act-openTab').addEventListener('click', () => openInNewTab(item.data.url || item.raw));
	li.querySelector('.act-remove').addEventListener('click', () => removeItem(item));
}

function removeItem(item) {
	item.controller?.abort();
	const index = queue.indexOf(item);
	if (index >= 0) queue.splice(index, 1);
	item.el?.remove();
	updateGlobalUi();
}

function render(item) {
	const el = item.el;
	if (!el) return;

	el.dataset.status = item.status;
	el.querySelector('.row-name').textContent = item.label;
	el.querySelector('.row-sub').textContent = item.subtitle || item.raw;

	const chip = el.querySelector('.status-chip');
	chip.dataset.status = item.status;
	chip.textContent = STATUS_LABELS[item.status] || item.status;

	el.querySelector('.row-message').textContent = item.message || '';

	const track = el.querySelector('.row-progress-track');
	const fill = el.querySelector('.row-progress-fill');
	if (item.progress && (item.progress.total > 0 || ['downloading', 'paused'].includes(item.status))) {
		track.hidden = false;
		if (item.progress.total > 0) {
			const pct = clamp(Math.round((item.progress.current / item.progress.total) * 100), 0, 100);
			fill.style.width = `${pct}%`;
		} else {
			fill.style.width = '15%';
		}
	} else {
		track.hidden = true;
	}

	const sizeCol = el.querySelector('.row-col-size');
	if (item.progress) {
		sizeCol.textContent = item.progress.bytes
			? (item.progress.total
				? `${formatBytes(item.progress.current)}/${formatBytes(item.progress.total)}`
				: formatBytes(item.progress.current))
			: `${item.progress.current}/${item.progress.total}`;
	} else {
		sizeCol.textContent = '—';
	}

	const speedCol = el.querySelector('.row-col-speed');
	if (item.status === 'downloading' && item.rate) {
		const speedText = item.progress?.bytes
			? `${formatBytes(item.rate)}/s`
			: `${item.rate.toFixed(1)}/s`;
		let eta = '';
		if (item.progress?.total > item.progress?.current && item.rate > 0) {
			eta = ` · ${formatDuration((item.progress.total - item.progress.current) / item.rate)}`;
		}

		speedCol.textContent = speedText + eta;
	} else if (item.status === 'paused') {
		speedCol.textContent = 'متوقف';
	} else {
		speedCol.textContent = '—';
	}

	const running = ['listing', 'downloading', 'zipping'].includes(item.status);
	const startBtn = el.querySelector('.act-start');
	const pauseBtn = el.querySelector('.act-pause');
	const resumeBtn = el.querySelector('.act-resume');
	const retryBtn = el.querySelector('.act-retry');
	const cancelBtn = el.querySelector('.act-cancel');
	const openTabBtn = el.querySelector('.act-openTab');

	startBtn.hidden = running || item.status === 'paused' || item.status === 'done' || item.status === 'awaiting-selection';
	startBtn.disabled = item.kind === 'invalid';
	pauseBtn.hidden = item.status !== 'downloading';
	resumeBtn.hidden = item.status !== 'paused';
	retryBtn.hidden = !['error', 'blocked', 'canceled'].includes(item.status);
	retryBtn.disabled = item.kind === 'invalid';
	cancelBtn.hidden = !running && item.status !== 'paused';
	openTabBtn.hidden = !item.showOpenTab;

	const picker = el.querySelector('.link-picker');
	if (item.discovered) {
		picker.hidden = false;
		renderLinkPicker(item, picker);
	} else {
		picker.hidden = true;
	}

	applyFilterToItem(item);
}

function renderLinkPicker(item, picker) {
	if (!item.pickerBuilt) {
		item.pickerBuilt = true;
		const list = picker.querySelector('.link-picker-list');
		list.innerHTML = '';
		const rowTpl = document.getElementById('linkPickerRowTemplate');
		for (const link of item.discovered.links) {
			const row = rowTpl.content.firstElementChild.cloneNode(true);
			const check = row.querySelector('.link-picker-check');
			check.checked = Boolean(link.selected);
			check.addEventListener('change', () => {
				link.selected = check.checked;
				updatePickerCount(item, picker);
			});
			row.querySelector('.link-picker-href').textContent = link.isPage ? link.label : link.href;
			row.querySelector('.link-picker-badge').textContent = link.isPage
				? 'HTML'
				: (guessExtension(new URL(link.href).pathname) || 'صفحه');
			list.append(row);
		}

		picker.querySelector('.link-picker-selectall').addEventListener('click', () => {
			const checks = list.querySelectorAll('.link-picker-check');
			item.discovered.links.forEach((l, i) => {
				if (l.isFile) {
					l.selected = true;
					checks[i].checked = true;
				}
			});
			updatePickerCount(item, picker);
		});
		picker.querySelector('.link-picker-add').addEventListener('click', () => addDiscoveredSelections(item));
	}

	updatePickerCount(item, picker);
}

function updatePickerCount(item, picker) {
	const n = item.discovered.links.filter(l => l.selected).length;
	picker.querySelector('.link-picker-count').textContent = `${n} انتخاب‌شده از ${item.discovered.links.length}`;
}

// ---- filtering / counts / status bar ---------------------------------------

function categoryOf(status) {
	if (['listing', 'downloading', 'zipping', 'paused', 'awaiting-selection'].includes(status)) return 'active';
	if (status === 'queued') return 'queued';
	if (status === 'done') return 'done';
	if (['error', 'blocked', 'canceled'].includes(status)) return 'error';
	return 'all';
}

function applyFilterToItem(item) {
	if (!item.el) return;
	item.el.hidden = currentFilter !== 'all' && categoryOf(item.status) !== currentFilter;
}

function applyFilter() {
	for (const item of queue) applyFilterToItem(item);
}

function updateSidebarCounts() {
	const counts = {all: queue.length, active: 0, queued: 0, done: 0, error: 0};
	for (const item of queue) {
		const cat = categoryOf(item.status);
		if (cat in counts) counts[cat]++;
	}

	for (const key of Object.keys(counts)) {
		const el = document.getElementById(`count-${key}`);
		if (el) el.textContent = String(counts[key]);
	}
}

function updateStatusBar() {
	if (queue.length === 0) {
		els.statusSummary.textContent = 'صف خالی است.';
		return;
	}

	const activeItems = queue.filter(it => ['listing', 'downloading', 'zipping', 'paused'].includes(it.status));
	const queuedCount = queue.filter(it => it.status === 'queued').length;
	const doneCount = queue.filter(it => it.status === 'done').length;
	const totalRate = activeItems.reduce((sum, it) => sum + ((it.progress?.bytes && it.rate) ? it.rate : 0), 0);

	const parts = [`${activeItems.length} مورد فعال`, `${queuedCount} در صف`, `${doneCount} تمام‌شده`];
	if (totalRate > 0) parts.push(`${formatBytes(totalRate)}/s`);
	els.statusSummary.textContent = parts.join(' · ');
}

function updateGlobalUi() {
	updateSidebarCounts();
	updateStatusBar();
	applyFilter();

	const hasStartable = queue.some(it => ['queued', 'error', 'canceled', 'blocked'].includes(it.status));
	els.startAllBtn.disabled = !hasStartable;

	const runningCount = queue.filter(it => it.status === 'downloading').length;
	const pausedCount = queue.filter(it => it.status === 'paused').length;
	if (runningCount > 0) {
		els.pauseAllLabel.textContent = 'توقف همه';
		els.pauseAllBtn.disabled = false;
		els.pauseAllBtn.dataset.mode = 'pause';
	} else if (pausedCount > 0) {
		els.pauseAllLabel.textContent = 'ادامه‌ی همه';
		els.pauseAllBtn.disabled = false;
		els.pauseAllBtn.dataset.mode = 'resume';
	} else {
		els.pauseAllLabel.textContent = 'توقف همه';
		els.pauseAllBtn.disabled = true;
		els.pauseAllBtn.dataset.mode = 'pause';
	}

	els.emptyState.hidden = queue.length > 0;
	els.queueList.hidden = queue.length === 0;
	updateCombineBar();
}

function updateCombineBar() {
	els.combineBar.hidden = !combineMode;
	els.combineFileCount.textContent = `(${sharedZipFileCount} فایل)`;
	els.finalizeCombineBtn.disabled = sharedZipFileCount === 0;
}

// =============================================================================
// Global event wiring
// =============================================================================

function handleIntakeSubmit(event) {
	event.preventDefault();
	const raw = els.intakeInput.value.trim();
	const urls = extractUrls(raw);
	if (urls.length > 0) {
		for (const u of urls) {
			const item = createItem(classifyUrl(u));
			queue.push(item);
			addItemToDom(item);
		}

		updateGlobalUi();
	}

	els.intakeInput.value = '';
	els.addDialog.close();
}

/** Reads text from the OS clipboard via the async Clipboard API. Requires a
 * secure context (https/localhost) and — in most browsers — a direct user
 * gesture, which is why this is only ever called from a click handler.
 * Throws on missing API support, denied permission, or an insecure context;
 * callers are expected to catch and fall back to manual Ctrl+V. */
async function readClipboardText() {
	if (!navigator.clipboard?.readText) {
		throw new Error('این مرورگر از خواندن برنامه‌ای کلیپبورد پشتیبانی نمی‌کند.');
	}

	return navigator.clipboard.readText();
}

/** One-click flow: read the clipboard, pull out every URL in it, and add
 * them straight to the queue (not started) — no dialog needed. */
async function addFromClipboard() {
	let text;
	try {
		text = await readClipboardText();
	} catch {
		showToast('اجازه‌ی خواندن کلیپبورد داده نشد. لینک را با Ctrl+V در کادر «افزودن لینک» بچسبانید.', 'error');
		return;
	}

	const urls = extractUrls(text);
	if (urls.length === 0) {
		showToast('لینکی در کلیپبورد پیدا نشد.', 'warn');
		return;
	}

	for (const u of urls) {
		const item = createItem(classifyUrl(u));
		queue.push(item);
		addItemToDom(item);
	}

	updateGlobalUi();
	showToast(`${urls.length} لینک از کلیپبورد به صف اضافه شد.`, 'success');
}

/** Same idea but fills the add-link textarea instead of committing straight
 * to the queue, for when the user wants to review/edit before adding. */
async function pasteClipboardIntoIntake() {
	let text;
	try {
		text = await readClipboardText();
	} catch {
		showToast('اجازه‌ی خواندن کلیپبورد داده نشد — با Ctrl+V بچسبانید.', 'error');
		return;
	}

	els.intakeInput.value = els.intakeInput.value.trim()
		? `${els.intakeInput.value.trim()}\n${text}`
		: text;
	els.intakeInput.focus();
}

async function startAllQueued() {
	const startable = queue.filter(it => ['queued', 'error', 'canceled', 'blocked'].includes(it.status));
	if (startable.length === 0) return;
	await pAll(startable, async it => runItem(it), {concurrency: getItemConcurrency()});
	updateGlobalUi();
}

function pauseAllRunning() {
	for (const it of queue) {
		if (it.status === 'downloading') {
			it.gate.pause();
			setStatus(it, 'paused');
			render(it);
		}
	}

	updateGlobalUi();
}

function resumeAllPaused() {
	for (const it of queue) {
		if (it.status === 'paused') {
			it.gate.resume();
			setStatus(it, 'downloading');
			render(it);
		}
	}

	updateGlobalUi();
}

function clearFinished() {
	for (let i = queue.length - 1; i >= 0; i--) {
		if (queue[i].status === 'done') {
			queue[i].el?.remove();
			queue.splice(i, 1);
		}
	}

	updateGlobalUi();
}

async function finalizeCombine() {
	if (!sharedZip || sharedZipFileCount === 0) return;
	els.finalizeCombineBtn.disabled = true;
	const originalText = els.finalizeCombineBtn.textContent;
	els.finalizeCombineBtn.textContent = 'در حال بسته‌بندی…';
	try {
		const blob = await sharedZip.generateAsync({type: 'blob'});
		saveBlob(blob, 'multiweb-downloader-bundle.zip');
		sharedZip = null;
		sharedZipFileCount = 0;
		showToast('بسته‌ی نهایی ذخیره شد.', 'success');
	} finally {
		els.finalizeCombineBtn.textContent = originalText;
		updateCombineBar();
	}
}

function exportQueue() {
	const data = {
		version: 1,
		app: 'MultiWeb Downloader',
		combineMode,
		urls: queue.map(it => it.raw),
	};
	const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
	saveBlob(blob, 'multiweb-downloader-queue.json');
	showToast('فایل صف دانلود شد.', 'success');
}

async function importQueueFromFile(file) {
	const text = await file.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		window.alert('فایل JSON معتبر نیست.');
		return;
	}

	const urls = Array.isArray(data.urls) ? data.urls : [];
	if (urls.length === 0) {
		showToast('این فایل هیچ لینکی نداشت.', 'warn');
		return;
	}

	for (const u of urls) {
		const item = createItem(classifyUrl(u));
		queue.push(item);
		addItemToDom(item);
	}

	if (typeof data.combineMode === 'boolean') {
		combineMode = data.combineMode;
		els.combineToggle.checked = combineMode;
	}

	updateGlobalUi();
	showToast(`${urls.length} لینک از فایل اضافه شد.`, 'success');
}

function wireGlobalEvents() {
	// ---- add-link dialog ----
	els.addBtn.addEventListener('click', () => {
		els.addDialog.showModal();
		els.intakeInput.focus();
	});
	els.emptyAddBtn.addEventListener('click', () => {
		els.addDialog.showModal();
		els.intakeInput.focus();
	});
	els.cancelAddBtn.addEventListener('click', () => {
		els.intakeInput.value = '';
		els.addDialog.close();
	});
	els.intakeForm.addEventListener('submit', handleIntakeSubmit);
	els.intakeInput.addEventListener('keydown', event => {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			els.intakeForm.requestSubmit();
		}
	});

	els.pasteClipboardBtn.addEventListener('click', addFromClipboard);
	els.pasteIntoIntakeBtn.addEventListener('click', pasteClipboardIntoIntake);

	// ---- settings dialog ----
	els.settingsBtn.addEventListener('click', () => els.settingsDialog.showModal());
	els.closeSettingsBtn.addEventListener('click', () => els.settingsDialog.close());

	for (const dlg of [els.addDialog, els.settingsDialog]) {
		dlg.addEventListener('click', event => {
			if (event.target === dlg) dlg.close();
		});
	}

	// ---- toolbar ----
	els.startAllBtn.addEventListener('click', startAllQueued);
	els.pauseAllBtn.addEventListener('click', () => {
		if (els.pauseAllBtn.dataset.mode === 'resume') resumeAllPaused();
		else pauseAllRunning();
	});

	els.themeToggle.addEventListener('click', () => {
		const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
		applyTheme(next);
		localStorage.setItem('mwd-theme', next);
	});

	// ---- sidebar ----
	for (const btn of document.querySelectorAll('.sidebar-item[data-filter]')) {
		btn.addEventListener('click', () => {
			currentFilter = btn.dataset.filter;
			for (const b of document.querySelectorAll('.sidebar-item[data-filter]')) b.classList.toggle('is-active', b === btn);
			applyFilter();
		});
	}

	els.combineToggle.addEventListener('change', () => {
		combineMode = els.combineToggle.checked;
		updateCombineBar();
	});
	els.finalizeCombineBtn.addEventListener('click', finalizeCombine);
	els.clearFinishedBtn.addEventListener('click', clearFinished);

	// ---- import/export ----
	els.exportQueueBtn.addEventListener('click', exportQueue);
	els.importQueueInput.addEventListener('change', () => {
		const file = els.importQueueInput.files?.[0];
		if (file) importQueueFromFile(file);
		els.importQueueInput.value = '';
	});
}

// =============================================================================
// Boot: query-param compatibility with the original tool (?url=, ?filename=)
// plus the new ?urls= for sharing a whole batch as one link.
// =============================================================================

function bootFromQuery() {
	const params = new URLSearchParams(location.search);
	const fromUrl = params.getAll('url');
	const fromUrls = (params.get('urls') || '').split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
	const all = [...fromUrl, ...fromUrls];
	if (all.length === 0) return;

	const filenameParam = params.get('filename');
	const items = all.map(u => createItem(classifyUrl(u)));
	for (const it of items) {
		queue.push(it);
		addItemToDom(it);
	}

	if (filenameParam && items.length === 1) {
		items[0].forcedFilename = filenameParam;
	}

	updateGlobalUi();
	for (const it of items) runItem(it);
}

function boot() {
	cacheDom();
	applyTheme(localStorage.getItem('mwd-theme') || 'light');
	loadSettings();
	wireGlobalEvents();
	if (!navigator.clipboard?.readText) {
		els.pasteClipboardBtn.hidden = true;
		els.pasteIntoIntakeBtn.hidden = true;
	}

	updateGlobalUi();
	bootFromQuery();
}

boot();
