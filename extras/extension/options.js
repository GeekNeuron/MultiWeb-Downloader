const input = document.getElementById('baseUrl');
const saveBtn = document.getElementById('save');

chrome.storage.sync.get(['baseUrl'], ({baseUrl}) => {
	if (baseUrl) input.value = baseUrl;
});

saveBtn.addEventListener('click', () => {
	const value = input.value.trim();
	chrome.storage.sync.set({baseUrl: value}, () => {
		saveBtn.textContent = 'ذخیره شد ✓';
		setTimeout(() => {
			saveBtn.textContent = 'ذخیره';
		}, 1500);
	});
});
