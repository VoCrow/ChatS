chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startProcess") {
    // Find active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs.length) return;
      const tab = tabs[0];

      if (tab.url.startsWith("chrome://")) {
        console.warn("⛔ Cannot run on chrome:// pages");
        return;
      }

      // Inject content.js (if needed)
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      }, () => {
        // Fetch data from server
        fetch("http://192.168.100.31:5401/messages")
          .then(response => response.json())
          .then(data => {
            // Send data to content.js
            chrome.tabs.sendMessage(tab.id, {
              action: "serverMessage",
              payload: data.messages,
            });
          })
          .catch(err => {
            console.error("Fetch error:", err);
          });
      });
    });
  }
});
