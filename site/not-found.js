// Share links for games published after the last site build have no static page yet:
// /s/<id>/ and /s/<id>/en/ continue straight to the player.
const match = window.location.pathname.match(/^\/s\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(en\/)?$/);
if (match) window.location.replace(`/play/?game=${match[1]}&lang=${match[2] ? "en" : "zh"}`);
