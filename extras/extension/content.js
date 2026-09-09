// Injects a small "افزودن به MultiWeb Downloader" button on GitHub folder
// (tree) and file (blob) pages, pointed at whatever tool URL the user
// configured in the extension's options page (chrome.storage.sync.baseUrl).
// Does nothing until that's configured — no hardcoded/guessed domain.

(function () {
	function buildButton(baseUrl) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'mwd-inject-btn';
		btn.textContent = '⬇ افزودن به MultiWeb Downloader';
		btn.addEventListener('click', () => {
			const target = `${baseUrl.replace(/\/+$/, '')}/?url=${encodeURIComponent(location.href)}`;
			window.open(target, '_blank', 'noopener');
		});
		return btn;
	}

	function mount() {
		if (document.querySelector('.mwd-inject-host')) return;

		chrome.storage.sync.get(['baseUrl'], ({baseUrl}) => {
			if (!baseUrl) return; // Not configured yet in the extension's popup — inject nothing.

			const host = document.createElement('div');
			host.className = 'mwd-inject-host';
			host.append(buildButton(baseUrl));

			const anchor = document.querySelector('#repository-details-container, .Layout-sidebar, main') || document.body;
			anchor.prepend(host);
		});
	}

	mount();

	// GitHub's UI updates parts of the page without a full reload when you
	// navigate between folders; re-check occasionally so the button survives.
	const observer = new MutationObserver(() => {
		if (!document.querySelector('.mwd-inject-host')) mount();
	});
	observer.observe(document.body, {childList: true, subtree: false});
})();
