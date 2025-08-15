chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (req && req.stream) {
    // Streaming: pipe NDJSON lines to the popup via ports
    (async () => {
      try {
        const res = await fetch('http://127.0.0.1:5403/chat_stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: req.msg }),
        });
        if (!res.ok || !res.body) {
          sendResponse({ error: 'stream_http_error' });
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let done = false;
        while (!done) {
          const { value, done: d } = await reader.read();
          done = d;
          if (value) {
            const chunk = decoder.decode(value, { stream: true });
            chrome.runtime.sendMessage({ type: 'streamChunk', data: chunk });
          }
        }
        sendResponse({ done: true });
      } catch (e) {
        sendResponse({ error: 'stream_failed' });
      }
    })();
    return true;
  }
  // Non-streaming default behavior
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
