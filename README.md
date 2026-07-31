# household-supplies-tracker

This project is planned to be a way to manage the supplies list that need to be purchased between roomies who live in the same household.

## Cross-device syncing

To make the tracker share data between your laptop and phone, connect the app to Firebase Realtime Database.

### 1. Create a Firebase project

1. Go to https://console.firebase.google.com/
2. Click Create a project
3. Name it something like household-supplies-tracker
4. Enable Google Analytics if you want, or skip it
5. Create the project

### 2. Enable Realtime Database and Authentication

1. In your Firebase project, open Build > Realtime Database
2. Click Create Database
3. Choose the location closest to you
4. In Build > Authentication, enable Email/Password sign-in
5. In Authentication > Settings > Authorized domains, make sure your app domain is listed

### 3. Add your web app

1. In Project settings, click Add app
2. Choose the Web icon
3. Register the app with a nickname like household-tracker
4. Copy the values shown in the Firebase config

### 4. Create a .env file

Create a file named .env in the project root with these values:

VITE_FIREBASE_API_KEY=your-api-key
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your-sender-id
VITE_FIREBASE_APP_ID=your-app-id
VITE_FIREBASE_DATABASE_URL=https://your-project-default-rtdb.firebaseio.com

### 5. Set database rules

In Realtime Database > Rules, use:

{
"rules": {
"household-tracker-data-v1": {
".read": "auth != null",
".write": "auth != null"
},
"household-tracker-items-v1": {
".read": "auth != null",
".write": "auth != null"
},
"household-tracker-users-v1": {
".read": "auth != null",
".write": "auth != null"
}
}
}

This keeps the data private to signed-in users only.

### 6. Install and run

npm install
npm run dev

Once the app runs, the tracker will save and load your data from Firebase instead of only from your browser.
