# Android signing key

This folder holds the **release signing keystore** for the Android app. Its
contents are git-ignored and must **never** be committed or shared.

The Gradle build (`client/android/app/build.gradle`) looks here for a
`key.properties` file and the keystore it points at. When they are absent, the
release build still compiles but is left **unsigned** (fine for local testing;
not installable on a device or publishable).

## 1. Generate a keystore (one time)

```bash
keytool -genkey -v \
  -keystore ephemeral.keystore \
  -alias ephdrops \
  -keyalg RSA -keysize 2048 -validity 10000
```

Run this **inside this `ephemeral-key/` folder**. Keep the resulting
`ephemeral.keystore` and the passwords safe — losing them means you can never
ship an update to the same Play Store listing.

## 2. Create `key.properties`

Create `ephemeral-key/key.properties` (next to the keystore):

```properties
storeFile=ephemeral.keystore
storePassword=YOUR_STORE_PASSWORD
keyAlias=ephdrops
keyPassword=YOUR_KEY_PASSWORD
```

`storeFile` is resolved **relative to this folder**.

## 3. Build a signed release

```bash
# from repo root
npm run android:sync           # build web (remote API) + cap sync
cd client/android
./gradlew assembleRelease      # signed APK  -> app/build/outputs/apk/release/
./gradlew bundleRelease        # signed AAB  -> app/build/outputs/bundle/release/  (Play Store)
```

## CI (GitHub Actions)

CI never sees this folder. Instead it reconstructs it from repository secrets:

| Secret | Contents |
|--------|----------|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 ephemeral.keystore` |
| `ANDROID_KEYSTORE_PASSWORD` | store password |
| `ANDROID_KEY_ALIAS` | key alias (`ephdrops`) |
| `ANDROID_KEY_PASSWORD` | key password |

The `android.yml` workflow decodes the keystore and writes `key.properties`
before building. See `.github/workflows/android.yml`.

## Play Store note

Google Play App Signing will re-sign your AAB with a Google-managed key on
upload; the key here becomes your **upload key**. Keep it safe but know that
Play holds the final app-signing key.
