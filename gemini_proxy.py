from flask import Flask, request, jsonify, Response, stream_with_context
import os, requests, base64, json
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
    instruction = "Keep your answer concise, under 50 words, and in 2–3 sentences."
    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    { "text": instruction },
                    { "text": prompt }
                ]
            }
        ]
    }
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
            return jsonify({ 'error': 'no_transcript', 'raw': j, 'mime': mime }), 502
        return jsonify({ 'transcript': text })
    except Exception as e:
        return jsonify({ 'error': 'stt_failed', 'detail': str(e) }), 502

@app.route('/chat_stream', methods=['POST', 'OPTIONS'])
def chat_stream():
    if request.method == 'OPTIONS':
        return ('', 204)
    data = request.get_json(silent=True) or {}
    prompt = (data.get('prompt') or '').strip()
    api_key = os.environ.get('GEMINI_API_KEY')
    if not api_key:
        return jsonify({ 'error': 'GEMINI_API_KEY not set' }), 500
    if not prompt:
        return jsonify({ 'error': 'prompt required' }), 400
    url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent"
    headers = {
        "Content-Type": "application/json",
        "X-goog-api-key": api_key,
    }
    payload = { "contents": [{ "parts": [{ "text": prompt }] }] }

    def generate():
        last_text = ""
        try:
            with requests.post(url, headers=headers, json=payload, stream=True, timeout=300) as r:
                if r.status_code >= 400:
                    try:
                        err = r.json()
                    except Exception:
                        err = { 'status': r.status_code }
                    yield json.dumps({ 'error': 'upstream_error', 'status': r.status_code, 'raw': err }) + "\n"
                    return
                for line in r.iter_lines(decode_unicode=True, chunk_size=1):
                    if not line:
                        continue
                    try:
                        j = json.loads(line)
                    except Exception:
                        continue
                    # Extract any text parts from the chunk
                    segs = []
                    for cand in j.get('candidates', []) or []:
                        parts = (cand.get('content') or {}).get('parts', [])
                        for p in parts:
                            t = p.get('text')
                            if t:
                                segs.append(t)
                    if segs:
                        combined = ''.join(segs)
                        # Some streams send cumulative text; emit only the delta
                        if len(combined) >= len(last_text) and combined.startswith(last_text):
                            delta = combined[len(last_text):]
                            last_text = combined
                        else:
                            delta = combined
                            last_text = combined
                        if delta:
                            yield json.dumps({ 'text': delta }) + "\n"
        except Exception as e:
            yield json.dumps({ 'error': 'stream_failed', 'detail': str(e) }) + "\n"

    return Response(stream_with_context(generate()), mimetype='application/x-ndjson')

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5403, debug=True)
