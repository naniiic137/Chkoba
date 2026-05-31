// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyD5mjir_ug6ZQDgzRQHYiihmUj001fzFhw",
  authDomain: "chkobba-fb211.firebaseapp.com",
  databaseURL: "https://chkobba-fb211-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "chkobba-fb211",
  storageBucket: "chkobba-fb211.firebasestorage.app",
  messagingSenderId: "612428857593",
  appId: "1:612428857593:web:e4d1ea746dea1fb9d42228",
  measurementId: "G-VT04LX0QF1"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);