// Auto-stop chat after 5 seconds of inactivity
let inactivityTimer;

// Reset timer on user input
window.addEventListener('keydown', () => {
  clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => {
    window.stop();
    alert('Chat stopped due to inactivity');
  }, 5000);
});

// Start timer on page load
inactivityTimer = setTimeout(() => {
  window.stop();
  alert('Chat stopped due to inactivity');
}, 5000);