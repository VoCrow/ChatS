chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  fetch('http://127.0.0.1:5403/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: req.msg }),
  })
    .then((r) => r.json())
    .then((j) => sendResponse({ resp: j.reply || j.error || 'error' }))
    .catch(() => sendResponse({ resp: 'error' }));
  return true;
});
