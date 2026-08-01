# Google Cloud setup for sign-in

This app signs in with your own Google Cloud OAuth client. Google does not
review or rate-limit apps used only by their own developer/test accounts, so
this whole setup takes about five minutes and never needs Google's approval.

## 1. Create a Google Cloud project

1. Go to https://console.cloud.google.com/projectcreate.
2. Give it any name (e.g. "gmail-clone-desktop") and click **Create**.
3. Make sure the new project is selected in the top project picker.

## 2. Enable the Gmail API

1. Go to https://console.cloud.google.com/apis/library/gmail.googleapis.com.
2. Confirm your project is selected, then click **Enable**.

## 3. Configure the OAuth consent screen

1. Go to https://console.cloud.google.com/apis/credentials/consent.
2. Choose **External** as the user type (Internal requires a Google
   Workspace org) and click **Create**.
3. Fill in the required fields (app name, your email as support contact and
   developer contact). You can leave everything else default.
4. On the **Scopes** step, add:
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/userinfo.email`
5. On the **Test users** step, add your own Google account's email address.
   Because the app stays in "Testing" status and you're a listed test user,
   **no Google review is required** — this is enough for personal use.

## 4. Create an OAuth client ID

1. Go to https://console.cloud.google.com/apis/credentials.
2. Click **Create credentials → OAuth client ID**.
3. Application type: **Desktop app** (not "Web application" — a desktop app
   client doesn't require a fixed redirect URI, which is what lets this app
   use a random loopback port on `127.0.0.1`).
4. Name it anything and click **Create**. Copy the **Client ID** and
   **Client secret** shown.

## 5. Put the credentials in `.env`

In the repo root (or wherever the desktop app loads its env from), create
or edit `.env`:

```
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

Keep `.env` out of the repo (it should already be git-ignored).

**Note on secrecy:** a Desktop-app client secret is not truly confidential —
Google's own OAuth docs acknowledge installed apps can't keep a secret
embedded in them safe from a determined user. Treat it as a low-sensitivity
identifier, not a password. It still shouldn't be committed to source
control, since that would make it trivial to find and reuse.

## Scopes and what they allow

- `gmail.modify` — read messages, change labels (archive, star, mark
  read/unread), and send mail. It does **not** grant permanent deletion;
  this app's "delete" moves a message to Trash, matching what `gmail.modify`
  actually permits.
- `userinfo.email` — read the signed-in account's email address, used to
  identify which Google account was connected.
