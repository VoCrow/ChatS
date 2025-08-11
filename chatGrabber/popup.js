// Wait for the entire HTML document (popup) to fully load before running the script
document.addEventListener("DOMContentLoaded", () => {


  document.getElementById("startBtn").addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "startProcess" });
  });
  




  // Find the button with id "sendButton" and attach a click event listener to it
  document.getElementById("sendButton").addEventListener("click", async () => {

    // Grab the value from the input field with id "inputField" (user's typed message)
    const message = document.getElementById("inputField").value;

    // Query the current active tab in the current window
    // This returns an array of tabs, but we only want the first one (active tab)
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Make sure the content script "content.js" is injected into the current active tab
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },  // Target this specific tab by its ID
      files: ["content.js"]       // The content script file to inject
    }).catch(() => {});           // Ignore errors if the script is already injected

    // Send a message from the popup to the content script running in the tab
    chrome.tabs.sendMessage(
      tab.id,                   // Target tab ID
      { type: "FROM_POPUP", text: message },  // Message payload with type and text
      (response) => {           // Callback function to handle response from content script
        if (chrome.runtime.lastError) {  // Check if there was an error sending message
          console.error("Message failed:", chrome.runtime.lastError.message);
        } else {
          console.log("✅ Response:", response);  // Log the successful response
        }
      }
    );
  });
});
