from flask import Flask, request, jsonify, Response
import os, requests
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

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5403)

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
