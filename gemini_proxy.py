from flask import Flask, request, jsonify, Response
import os, requests, base64, subprocess, tempfile, json
from io import BytesIO
try:
    from gtts import gTTS
except Exception:
    gTTS = None
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

app = Flask(__name__)
@app.route('/status', methods=['GET'])
def status():
    return jsonify({
        'ok': True,
        'endpoints': ['/chat', '/tts', '/stt'],
        'debug': True,
    })

@app.route('/netcheck', methods=['GET'])
def netcheck():
    try:
        r = requests.get('https://generativelanguage.googleapis.com', timeout=5)
        return jsonify({ 'reachable': True, 'status': r.status_code })
    except Exception as e:
        return jsonify({ 'reachable': False, 'error': str(e) }), 200

def _offline_vosk_transcribe(mime: str, raw: bytes):
    """Try offline STT using Vosk if installed and a model is available.
    Requires ffmpeg in PATH and VOSK_MODEL env var pointing to a model directory.
    Returns transcript string or None if unavailable/failure.
    """
    try:
        from vosk import Model, KaldiRecognizer
    except Exception:
        return None
    model_path = os.environ.get('VOSK_MODEL', '').strip()
    if not model_path or not os.path.isdir(model_path):
        return None
    # Convert input audio (webm/ogg/etc.) to 16k mono WAV with ffmpeg
    try:
        with tempfile.TemporaryDirectory() as td:
            inp = os.path.join(td, 'in.bin')
            out = os.path.join(td, 'out.wav')
            with open(inp, 'wb') as f:
                f.write(raw)
            cmd = ['ffmpeg', '-y', '-i', inp, '-ar', '16000', '-ac', '1', '-f', 'wav', out]
            subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            # Run Vosk
            model = Model(model_path)
            rec = KaldiRecognizer(model, 16000)
            rec.SetWords(True)
            with open(out, 'rb') as wf:
                while True:
                    data = wf.read(4000)
                    if len(data) == 0:
                        break
                    rec.AcceptWaveform(data)
            # Final result
            res = rec.FinalResult()
            try:
                j = json.loads(res)
                txt = (j.get('text') or '').strip()
                return txt or None
            except Exception:
                return None
    except Exception:
        return None

@app.after_request
def add_cors_headers(resp):
    resp.headers['Access-Control-Allow-Origin'] = '*'
    resp.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    resp.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    return resp

@app.route('/chat', methods=['POST', 'OPTIONS'])
def chat():
    if request.method == 'OPTIONS':
        return ('', 204)
    data = request.get_json(silent=True) or {}
    prompt = data.get('prompt', '')
    api_key = os.environ.get('GEMINI_API_KEY')
    if not api_key:
        return jsonify({ 'error': 'GEMINI_API_KEY not set' }), 500
    if not prompt:
        return jsonify({ 'error': 'prompt required' }), 400
    url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
    headers = {
        "Content-Type": "application/json",
        "X-goog-api-key": api_key,
    }
    payload = { "contents": [{ "parts": [{ "text": prompt }] }] }
    try:
        r = requests.post(url, headers=headers, json=payload, timeout=60)
        j = r.json()
        text = (
            j.get('candidates', [{}])[0]
             .get('content', {})
             .get('parts', [{}])[0]
             .get('text')
        )
        if not text:
            return jsonify({ 'error': 'no_text', 'raw': j }), 502
        return jsonify({ 'reply': text })
    except Exception as e:
        return jsonify({ 'error': 'request_failed', 'detail': str(e) }), 502

@app.route('/tts', methods=['POST', 'OPTIONS'])
def tts():
    if request.method == 'OPTIONS':
        return ('', 204)
    data = request.get_json(silent=True) or {}
    text = data.get('text', '')
    lang = data.get('lang', 'en')
    slow = bool(data.get('slow', False))
    if not text:
        return jsonify({ 'error': 'text required' }), 400
    if gTTS is None:
        return jsonify({ 'error': 'gTTS not installed' }), 500
    try:
        mp3 = BytesIO()
        gTTS(text=text, lang=lang, slow=slow).write_to_fp(mp3)
        mp3.seek(0)
        resp = Response(mp3.read(), mimetype='audio/mpeg')
        # CORS headers added by after_request
        return resp
    except Exception as e:
        return jsonify({ 'error': 'tts_failed', 'detail': str(e) }), 502

@app.route('/stt', methods=['POST', 'OPTIONS'])
def stt():
    if request.method == 'OPTIONS':
        return ('', 204)
    api_key = os.environ.get('GEMINI_API_KEY')
    if not api_key:
        return jsonify({ 'error': 'GEMINI_API_KEY not set' }), 500
    # Keep full MIME; Gemini accepts audio/webm, audio/ogg, etc. Some deployments need exact codecs.
    mime = (request.headers.get('Content-Type', 'application/octet-stream') or 'application/octet-stream').strip()
    raw = request.data or b''
    try:
        print(f"/stt incoming: mime={mime}, size={len(raw)} bytes")
    except Exception:
        pass
    if not raw:
        return jsonify({ 'error': 'audio required' }), 400
    b64 = base64.b64encode(raw).decode('ascii')
    # Prefer instruction first, then audio. Lower temperature to reduce drift.
    headers = { "Content-Type": "application/json", "X-goog-api-key": api_key }
    generation_config = { "temperature": 0 }
    def build_payload():
        return {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        { "text": "Transcribe the following audio to plain text. Return only the transcript." },
                        { "inline_data": { "mime_type": mime, "data": b64 } }
                    ]
                }
            ],
            "generationConfig": generation_config
        }
    def call_model(model_name):
        u = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent"
        r = requests.post(u, headers=headers, json=build_payload(), timeout=180)
        return r.status_code, r.json()
    try:
        # Try 1.5-flash first, then fall back to 2.0-flash
        status, j = call_model('gemini-1.5-flash')
        if status >= 400 or not (j.get('candidates') or []):
            try:
                print(f"/stt primary model status={status} body={j}")
            except Exception:
                pass
            status2, j2 = call_model('gemini-2.0-flash')
            status, j = status2, j2
        if status >= 400:
            try:
                print(f"/stt gemini_error status={status} body={j}")
            except Exception:
                pass
            msg = (j.get('error', {}) or {}).get('message') if isinstance(j, dict) else None
            # Attempt offline fallback (Vosk) if available
            offline = _offline_vosk_transcribe(mime, raw)
            if offline:
                return jsonify({ 'transcript': offline, 'offline': True })
            return jsonify({ 'error': 'gemini_error', 'status': status, 'message': msg, 'raw': j, 'mime': mime }), status
        text = (
            j.get('candidates', [{}])[0]
             .get('content', {})
             .get('parts', [{}])[0]
             .get('text')
        )
        if not text:
            try:
                print(f"/stt no_transcript body={j}")
            except Exception:
                pass
            # Attempt offline fallback (Vosk)
            offline = _offline_vosk_transcribe(mime, raw)
            if offline:
                return jsonify({ 'transcript': offline, 'offline': True })
            return jsonify({ 'error': 'no_transcript', 'raw': j, 'mime': mime }), 502
        return jsonify({ 'transcript': text })
    except Exception as e:
        # Attempt offline fallback (Vosk)
        offline = _offline_vosk_transcribe(mime, raw)
        if offline:
            return jsonify({ 'transcript': offline, 'offline': True })
        return jsonify({ 'error': 'stt_failed', 'detail': str(e) }), 502

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5403, debug=True)
