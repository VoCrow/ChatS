// Helper: original non-streaming send with TTS fallback
async function nonStreamingSend(msg, out) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ msg }, async (r) => {
      const text = (r && r.resp) || 'error';
      out.textContent = text;
      try {
        const res = await fetch('http://127.0.0.1:5403/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (res.ok) {
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audio.play().catch(() => {});
        }
      } catch (_) {}
      resolve();
    });
  });
}

// Streaming send: request partial chunks and speak as they arrive
document.getElementById('send').onclick = async () => {
  const msg = document.getElementById('msg').value;
  const out = document.getElementById('resp');
  out.textContent = '';
  const synth = window.speechSynthesis;
  const queue = [];
  let speaking = false;
  let gotAny = false;
  let ttsBuffer = '';
  let lastFlushAt = Date.now();
  let firstChunkAt = 0;
  let firstSpoken = false;
  let firstSpeechTimer = null;

  // Ensure voices are loaded and warm up TTS to avoid first-utterance lag
  await new Promise((resolve) => {
    const v = synth.getVoices();
    if (v && v.length) return resolve();
    const h = () => {
      synth.onvoiceschanged = null;
      resolve();
    };
    synth.onvoiceschanged = h;
    // Fallback timeout in case event doesn't fire
    setTimeout(resolve, 500);
  });
  try {
    const warm = new SpeechSynthesisUtterance(' ');
    warm.volume = 0; // silent warm-up
    synth.speak(warm);
  } catch (_) {}

  function speakNext() {
    if (speaking || queue.length === 0) return;
    const text = queue.shift();
    if (!text) return speakNext();
    const u = new SpeechSynthesisUtterance(text);
    u.onstart = () => {
      firstSpoken = true;
    };
    u.onend = () => {
      speaking = false;
      speakNext();
    };
    u.onerror = () => {
      speaking = false;
      speakNext();
    };
    speaking = true;
    synth.speak(u);
  }

  // Buffer for partial lines that may split NDJSON boundaries
  let buffer = '';
  function flushChunks(force = false) {
    const now = Date.now();
    // Early flush rule: if any text is waiting and >0.5s since last flush, push it immediately
    if (
      ttsBuffer &&
      ttsBuffer.trim().length > 0 &&
      (force || now - lastFlushAt >= 500)
    ) {
      const chunk = ttsBuffer.trim();
      ttsBuffer = '';
      if (chunk) {
        queue.push(chunk);
        speakNext();
        lastFlushAt = now;
      }
      // Do not proceed to punctuation splitting for this cycle when early flushed
      if (!force) return;
    }
    // Prefer sentence boundaries first
    while (true) {
      let idx = Math.max(
        ttsBuffer.lastIndexOf('.'),
        ttsBuffer.lastIndexOf('!'),
        ttsBuffer.lastIndexOf('?')
      );
      if (idx >= 0 && idx + 1 <= ttsBuffer.length) {
        const chunk = ttsBuffer.slice(0, idx + 1);
        ttsBuffer = ttsBuffer.slice(idx + 1).trimStart();
        if (chunk.trim()) {
          queue.push(chunk);
          speakNext();
          lastFlushAt = now;
        }
        continue;
      }
      // If no punctuation and text is long, break at a safe length
      if (ttsBuffer.length > 140) {
        // Find a space near 120 chars
        const sliceAt = (() => {
          const target = 120;
          const s = ttsBuffer.lastIndexOf(' ', target);
          return s > 80 ? s : target;
        })();
        const chunk = ttsBuffer.slice(0, sliceAt);
        ttsBuffer = ttsBuffer.slice(sliceAt).trimStart();
        if (chunk.trim()) {
          queue.push(chunk);
          speakNext();
          lastFlushAt = now;
        }
        continue;
      }
      // If forcing at the end, flush remaining
      if (force && ttsBuffer.trim()) {
        const chunk = ttsBuffer.trim();
        ttsBuffer = '';
        queue.push(chunk);
        speakNext();
        lastFlushAt = now;
      }
      break;
    }
  }
  const onMsg = (payload) => {
    if (
      !payload ||
      payload.type !== 'streamChunk' ||
      typeof payload.data !== 'string'
    )
      return;
    buffer += payload.data;
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep last partial
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j.text) {
          gotAny = true;
          out.textContent += j.text;
          ttsBuffer += j.text;
          if (!firstChunkAt) {
            firstChunkAt = Date.now();
            // Immediately try to flush a first short chunk
            flushChunks(true);
            if (!firstSpeechTimer) {
              firstSpeechTimer = setTimeout(() => {
                // Backup ensure within ~700ms of first chunk
                if (!firstSpoken) flushChunks(true);
              }, 700);
            }
          }
          flushChunks(false);
        } else if (j.error) {
          out.textContent = `Error: ${j.error}`;
        }
      } catch (_) {
        /* ignore parse errors */
      }
    }
  };

  chrome.runtime.onMessage.addListener(onMsg);
  chrome.runtime.sendMessage({ msg, stream: true }, async (r) => {
    // Streaming completed (or failed)
    chrome.runtime.onMessage.removeListener(onMsg);
    flushChunks(true);
    if (!gotAny || (r && r.error)) {
      // Fallback to non-streaming path
      out.textContent = '...';
      await nonStreamingSend(msg, out);
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
      tmp.getTracks().forEach((t) => t.stop());
    } catch (err) {
      out.textContent = 'Mic permission denied for fallback.';
      return;
    }
    out.textContent = 'Listening (fallback)…';
    const sr = new SR();
    sr.lang = 'en-US';
    sr.interimResults = false;
    sr.maxAlternatives = 1;
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
    try {
      sr.start();
    } catch (e) {
      console.error('SR start failed', e);
    }
  }

  btn.onclick = async () => {
    // Toggle behavior
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop();
      } catch (_) {}
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
        'audio/ogg',
      ];
      chosen =
        candidates.find(
          (t) =>
            window.MediaRecorder.isTypeSupported &&
            MediaRecorder.isTypeSupported(t)
        ) || '';
      rec = chosen
        ? new MediaRecorder(stream, { mimeType: chosen })
        : new MediaRecorder(stream);
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size) chunks.push(e.data);
      };
      rec.onstop = async () => {
        try {
          stream && stream.getTracks().forEach((t) => t.stop());
        } catch (_) {}
        stream = null;
        btn.textContent = 'Start Talking';
        btn.disabled = false;
        if (stopTimer) {
          clearTimeout(stopTimer);
          stopTimer = null;
        }
        const blobType =
          chosen || (chunks[0] && chunks[0].type) || 'audio/webm';
        const blob = new Blob(chunks, { type: blobType });
        out.textContent = 'Transcribing…';
        try {
          const res = await fetch('http://127.0.0.1:5403/stt', {
            method: 'POST',
            headers: {
              'Content-Type': blob.type || 'application/octet-stream',
            },
            body: blob,
          });
          let j = {};
          try {
            j = await res.json();
          } catch (_) {
            j = { error: 'non_json_response' };
          }
          if (!res.ok) {
            console.error('STT HTTP error', res.status, j);
            out.textContent = `STT error ${res.status}: ${
              (j && (j.error || j.status || j.message)) || 'unknown'
            }`;
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
          try {
            rec.stop();
          } catch (_) {}
        }
      }, 20000);
    } catch (e) {
      console.error('Mic error', e);
      out.textContent = 'Mic error.';
      btn.disabled = false;
    }
  };
})();
