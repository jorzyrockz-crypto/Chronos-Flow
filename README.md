# Chronos Overview 4.0 — Daily Command Center

An iPad-first refresh of the Chronos overview dashboard. This package retains the existing calendar, tasks, notes, team workspace, Firebase integration, notification drawer, membership controls, and local-first data structure.

## Deploy
1. Back up your current hosted files.
2. Deploy all files in this package together to your existing HTTPS host.
3. Keep the same Firebase project and existing Firestore rules unless you intentionally change them.
4. Reload the app. The service worker cache name has been updated for this release.

## Note
The overview progress indicator is calculated from the tasks currently loaded in Chronos. Validate live team synchronization and Firebase permissions in your own deployment.
