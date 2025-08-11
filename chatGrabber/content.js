chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "serverMessage") {
    console.log("Received server messages:", message.payload);

    // Clear everything on the page:
    document.body.innerHTML = "";

    // Change background color to red:
    document.body.style.backgroundColor = "red";

    // Optional: show a big visible message
    const div = document.createElement("div");
    div.textContent = "Messages received! Check console.";
    div.style.color = "white";
    div.style.fontSize = "40px";
    div.style.textAlign = "center";
    div.style.marginTop = "20vh";
    document.body.appendChild(div);
  }
});
