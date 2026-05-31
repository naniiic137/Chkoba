const fs = require('fs');
const required = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
const config = {};
for (const key of required) {
  config[key] = process.env['FIREBASE_' + key] || '';
  if (!config[key]) {
    console.error('Missing required env var: FIREBASE_' + key);
    process.exit(1);
  }
}
config.measurementId = process.env.FIREBASE_measurementId || '';
fs.writeFileSync('firebase-config.js', '// Generated from Netlify env vars\nconst firebaseConfig = ' + JSON.stringify(config, null, 2) + ';\n');
console.log('firebase-config.js generated');
