import requests, time

url = "http://192.168.100.31:5402/student"

student_text = "Hello I'm Kelly. I'm a new student here at Native Camp!"

#Send message to the server.
def send_stt():
    requests.post(url, json = {"student_text": student_text})



pause = input("Tell me when to start: ")
time.sleep(int(pause))
send_stt()


