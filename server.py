from flask import Flask, request, jsonify

student_text = []

app = Flask(__name__)

@app.route("/")
def home():
    return "Flask Home Page"

@app.route("/student", methods=["POST"])
def student_recieve():
    text = request.get_json()
    text = text.get("student_text")
    student_text.append(text)
    print("Recieved a text from student.")
    return "Message received", 200

@app.route("/messages", methods=["GET"])
def get_messages():
    return jsonify({"messages": student_text})

app.run(host="0.0.0.0", port=5402)