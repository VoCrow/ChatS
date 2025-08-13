document.getElementById('send').onclick = async () => {
  const msg = document.getElementById('msg').value;
  const out = document.getElementById('resp');
  out.textContent = '...';
  chrome.runtime.sendMessage({ msg }, async (r) => {
    const text = (r && r.resp) || 'error';
    out.textContent = text;
    try {
      const res = await fetch('http://127.0.0.1:5403/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error('TTS failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.play().catch(() => {});
    } catch (e) {
      console.error('TTS error', e);
    }
  });
};
