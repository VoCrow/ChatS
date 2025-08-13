const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const btn = document.getElementById('start');
if (!SR) { btn.disabled = true; btn.textContent = 'Not supported'; }
const rec = SR ? new SR() : null;
if (rec) {
  rec.lang = 'en-US'; rec.interimResults = false; rec.maxAlternatives = 1;
  rec.onresult = (ev) => {
    const text = ev.results[0][0].transcript;
    chrome.runtime.sendMessage({ type: 'voiceResult', text });
  };
  rec.onerror = (e) => { console.error('Voice error', e); };
  btn.onclick = async () => {
    try {
      btn.disabled = true;
      // Request mic permission first
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Immediately stop tracks; we only need the permission grant
      stream.getTracks().forEach(t => t.stop());
      rec.start();
    } catch (err) {
      console.error('Mic access denied:', err);
      btn.disabled = false;
    }
  };
}
