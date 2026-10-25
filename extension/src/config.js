(() => {
  "use strict";

  const status = document.getElementById("status");
  const settingsLink = document.getElementById("settings-link");
  const helper = window.Twitch?.ext;

  if (!helper) {
    status.textContent = "Open from the Extension manager.";
    return;
  }

  helper.onAuthorized((auth) => {
    if (!auth.channelId) {
      status.textContent = "Channel unavailable.";
      return;
    }
    status.textContent = `Channel ${auth.channelId}`;
    settingsLink.hidden = false;
  });

  helper.onContext((context) => {
    if (context?.theme === "light" || context?.theme === "dark") document.documentElement.dataset.theme = context.theme;
  });
})();
