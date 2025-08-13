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

// Start Talking -> record mic and transcribe via Gemini (proxy /stt)
(() => {
  const btn = document.getElementById('talk');
  const out = document.getElementById('resp');
  let rec = null;
  let stream = null;
  let chunks = [];
  let stopTimer = null;
  let chosen = '';

  async function speechRecognitionFallback() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      out.textContent = 'Browser STT not supported.';
      return;
    }
    try {
      // Request permission to ensure recognizer can access mic
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach(t => t.stop());
    } catch (err) {
      out.textContent = 'Mic permission denied for fallback.';
      return;
    }
    out.textContent = 'Listening (fallback)…';
    const sr = new SR();
    sr.lang = 'en-US'; sr.interimResults = false; sr.maxAlternatives = 1;
    sr.onresult = (ev) => {
      const transcript = ev.results[0][0].transcript;
      document.getElementById('msg').value = transcript;
      document.getElementById('send').click();
      out.textContent = '';
    };
    sr.onerror = (e) => {
      console.error('Fallback SR error', e);
      out.textContent = 'Fallback STT error.';
    };
    try { sr.start(); } catch (e) { console.error('SR start failed', e); }
  }

  btn.onclick = async () => {
    // Toggle behavior
    if (rec && rec.state !== 'inactive') {
      try { rec.stop(); } catch (_) {}
      return;
    }

    btn.disabled = true;
    out.textContent = 'Recording…';
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      // Pick a supported audio mime for MediaRecorder
      const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/ogg'
      ];
      chosen = candidates.find(t => window.MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
      rec = chosen ? new MediaRecorder(stream, { mimeType: chosen }) : new MediaRecorder(stream);
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        try { stream && stream.getTracks().forEach(t=>t.stop()); } catch (_) {}
        stream = null;
        btn.textContent = 'Start Talking';
        btn.disabled = false;
        if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
        const blobType = chosen || (chunks[0] && chunks[0].type) || 'audio/webm';
        const blob = new Blob(chunks, { type: blobType });
        out.textContent = 'Transcribing…';
        try {
          const res = await fetch('http://127.0.0.1:5403/stt', {
            method: 'POST',
            headers: { 'Content-Type': blob.type || 'application/octet-stream' },
            body: blob,
          });
          let j = {};
          try { j = await res.json(); } catch (_) { j = { error: 'non_json_response' }; }
          if (!res.ok) {
            console.error('STT HTTP error', res.status, j);
            out.textContent = `STT error ${res.status}: ${(j && (j.error || j.status || j.message)) || 'unknown'}`;
            // Fallback to browser STT when local proxy can't reach network
            if ((j && j.error) === 'stt_failed') {
              await speechRecognitionFallback();
            }
            return;
          }
          const transcript = j && j.transcript;
          if (transcript) {
            document.getElementById('msg').value = transcript;
            document.getElementById('send').click();
            out.textContent = '';
          } else {
            out.textContent = 'No transcript returned.';
          }
        } catch (e) {
          console.error('STT fetch failed', e);
          out.textContent = 'STT network error.';
          await speechRecognitionFallback();
        }
      };
      rec.start();
      btn.textContent = 'Stop';
      btn.disabled = false;
      // Max duration safety (20s)
      stopTimer = setTimeout(() => {
        if (rec && rec.state !== 'inactive') {
          try { rec.stop(); } catch (_) {}
        }
      }, 20000);
    } catch (e) {
      console.error('Mic error', e);
      out.textContent = 'Mic error.';
      btn.disabled = false;
    }
  };
})();
