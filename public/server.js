// Where the game server is. Empty means this site (the Worker or npm start serves the
// page and the rooms together); the static copies on Cloudflare Pages and on the old
// Netlify site use the Worker.
window.GAME_SERVER = /\.(pages\.dev|netlify\.app)$/.test(location.hostname) ? 'https://chkobba.hamza-benismail-6.workers.dev' : '';
