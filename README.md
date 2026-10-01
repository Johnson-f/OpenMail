# OpenMail

An AI-native Gmail client for macOS. See [docs/design.md](docs/design.md).

## Setup

Requires Xcode 27 and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).

1. Create a Google Cloud OAuth client of type **Desktop app** with the Gmail API enabled, and add yourself as a test user.
2. Put its credentials in `.env`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```
3. Generate the build config and the Xcode project:
   ```sh
   ./scripts/generate-secrets.sh
   xcodegen generate
   open OpenMail.xcodeproj
   ```

4. In the app, open **Settings** (⌘,). The assistant uses your installed [Codex CLI](https://developers.openai.com/codex/cli) and ChatGPT plan by default (sign in once with `codex login`); you can switch it to an Anthropic API key. Add a Voyage API key for semantic search.

## Layout

- `OpenMailKit/` — Swift package with sign-in, Gmail sync, the local store and sending. Test it with `swift test`.
- `App/` — the SwiftUI app.

Mail is stored in `~/Library/Application Support/OpenMail/mail.sqlite`. Refresh tokens are stored in the Keychain.
