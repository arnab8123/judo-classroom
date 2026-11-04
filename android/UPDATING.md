# Publishing Android updates

The app checks `https://judomeet.online/android-update.json` when it opens. To publish a native Android update:

1. Increase `versionCode` and `versionName` in `app/build.gradle.kts`.
2. Build and sign the release APK with the same signing key used for the installed app.
3. Replace `client/public/Judo-Android-WebView.apk` with that APK.
4. Set `versionCode` and `versionName` in `client/public/android-update.json` to match the APK, and add short release notes if desired.
5. Deploy the website so the JSON and APK are available at the URLs in the manifest.

The app downloads the APK over HTTPS, checks its package name and version against the manifest, then opens Android's package installer. Android requires the user to allow installs for Judo (once per device) and confirm each update. The APK signature must match the installed app's signing key or Android will reject the update.

Already-installed APKs do not gain this updater until they are manually updated to a build that contains it.
