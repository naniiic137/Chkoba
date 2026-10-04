// Where the game server is. Empty means this site (the Worker or npm start serves the
// page and the rooms together); the static copy on Cloudflare Pages uses the Worker.
window.GAME_SERVER = location.hostname.endsWith('.pages.dev') ? 'https://chkobba.hamza-benismail-6.workers.dev' : '';
